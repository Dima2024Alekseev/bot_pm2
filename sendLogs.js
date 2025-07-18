const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');
const pm2 = require('pm2'); // Добавляем модуль pm2

// *** НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ ***
const BOT_TOKEN = '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds'; // Ваш токен бота
const CHAT_ID = '1364079703';     // Ваш Chat ID (может быть числом или строкой)
const PM2_APP_NAME = 'server-site'; // Имя вашего PM2-приложения
// ******************************

// ПУТИ К ФАЙЛАМ ЛОГОВ PM2 - ВЗЯТЫ ИЗ ВАШЕГО ВЫВОДА `pm2 show`
const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

// Ключевые слова для поиска критических ошибок и предупреждений (нечувствительны к регистру)
const CRITICAL_KEYWORDS = ['error', 'fatal', 'critical', 'exception', 'failed', 'timeout', 'denied', 'unauthorized', 'segfault'];
const WARNING_KEYWORDS = ['warn', 'warning', 'deprecated', 'unstable', 'notice'];

// Инициализация Telegram бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Функция для отправки сообщений в Telegram
async function sendTelegramMessage(chatId, text, forceSend = false) {
    if (!text.trim() && !forceSend) { // Не отправляем пустые сообщения, если не принудительно
        return;
    }
    const MAX_MESSAGE_LENGTH = 4000;
    let parts = [];
    let remainingText = text;

    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        // Попытка обрезать по последней новой строке, чтобы не ломать логи
        let lastNewline = part.lastIndexOf('\n');
        if (lastNewline !== -1 && lastNewline !== part.length - 1 && remainingText.length > MAX_MESSAGE_LENGTH) {
            part = part.substring(0, lastNewline);
            remainingText = remainingText.substring(lastNewline + 1);
        } else {
            remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
        }
        parts.push(part);
    }

    for (const part of parts) {
        try {
            await bot.sendMessage(chatId, `\`\`\`\n${part}\n\`\`\``, { parse_mode: 'MarkdownV2' });
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram (MarkdownV2 failed):', error.response ? error.response.data : error.message);
            // Попробуем отправить без MarkdownV2
            try {
                await bot.sendMessage(chatId, part);
                console.log('Message part sent without MarkdownV2 due to error.');
            } catch (fallbackError) {
                console.error('Fallback send failed:', fallbackError.response ? fallbackError.data : fallbackError.message);
            }
        }
    }
}

// --- Функционал отслеживания новых логов в реальном времени и поиска ключевых слов ---

let lastReadOutPosition = 0;
let lastReadErrPosition = 0;

console.log(`Watching for logs from: ${LOG_FILE_OUT} and ${LOG_FILE_ERR}`);

function checkLogForKeywords(logLine) {
    const lowerCaseLine = logLine.toLowerCase();
    for (const keyword of CRITICAL_KEYWORDS) {
        if (lowerCaseLine.includes(keyword)) {
            return 'CRITICAL';
        }
    }
    for (const keyword of WARNING_KEYWORDS) {
        if (lowerCaseLine.includes(keyword)) {
            return 'WARNING';
        }
    }
    return null; // Нет совпадений
}

function processLogFile(filePath, lastPositionRef, type) {
    fs.stat(filePath, (err, stats) => {
        if (err) {
            console.error(`Error stat-ing file ${filePath}:`, err.message);
            return;
        }

        const currentSize = stats.size;
        if (currentSize < lastPositionRef.value) {
            console.log(`Log file ${filePath} was truncated. Reading from start.`);
            lastPositionRef.value = 0;
        }

        if (currentSize > lastPositionRef.value) {
            const stream = fs.createReadStream(filePath, { start: lastPositionRef.value, encoding: 'utf8' });
            let buffer = '';
            let unprocessedLines = ''; // Для хранения неполных строк

            stream.on('data', (chunk) => {
                const lines = (unprocessedLines + chunk).split('\n');
                unprocessedLines = lines.pop(); // Последняя строка может быть неполной

                for (const line of lines) {
                    if (line.trim() === '') continue; // Пропускаем пустые строки

                    const alertType = checkLogForKeywords(line);
                    if (alertType) {
                        sendTelegramMessage(CHAT_ID, `🚨 ${alertType} (${PM2_APP_NAME})\n\`\`\`\n${line}\n\`\`\``);
                    } else {
                        // Отправляем обычные логи только если они новые и не содержат критических слов
                        // Для запроса логов используется отдельная функция
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - ${PM2_APP_NAME} - NEW]\n${line}`);
                    }
                }
            });

            stream.on('end', () => {
                // Обработать оставшуюся неполную строку, если она есть
                if (unprocessedLines.trim() !== '') {
                    const alertType = checkLogForKeywords(unprocessedLines);
                    if (alertType) {
                        sendTelegramMessage(CHAT_ID, `🚨 ${alertType} (${PM2_APP_NAME})\n\`\`\`\n${unprocessedLines}\n\`\`\``);
                    } else {
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - ${PM2_APP_NAME} - NEW]\n${unprocessedLines}`);
                    }
                }
                lastPositionRef.value = currentSize;
            });

            stream.on('error', (readErr) => {
                console.error(`Error reading from file ${filePath}:`, readErr.message);
            });
        }
    });
}

const lastPositionOut = { value: 0 };
const lastPositionErr = { value: 0 };

function initializeLogPositions() {
    [LOG_FILE_OUT, LOG_FILE_ERR].forEach(filePath => {
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            if (filePath === LOG_FILE_OUT) lastPositionOut.value = stats.size;
            if (filePath === LOG_FILE_ERR) lastPositionErr.value = stats.size;
            console.log(`Initial position for ${filePath}: ${stats.size}`);
        } else {
            console.warn(`Log file not found: ${filePath}. It will be watched when created.`);
        }
    });
}

initializeLogPositions();

const watcher = chokidar.watch([LOG_FILE_OUT, LOG_FILE_ERR], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
    }
});

watcher
    .on('add', (filePath) => {
        console.log(`File ${filePath} has been added`);
        if (filePath === LOG_FILE_OUT) lastPositionOut.value = 0;
        if (filePath === LOG_FILE_ERR) lastPositionErr.value = 0;
        processLogFile(filePath, filePath === LOG_FILE_OUT ? lastPositionOut : lastPositionErr, filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('change', (filePath) => {
        console.log(`File ${filePath} has been changed`);
        processLogFile(filePath, filePath === LOG_FILE_OUT ? lastPositionOut : lastPositionErr, filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('error', (error) => console.error(`Watcher error: ${error}`));

// --- Функционал обработки команд Telegram ---

function readLastLines(filePath, numLines, callback) {
    if (!fs.existsSync(filePath)) {
        return callback(null, `Файл логов не найден: ${filePath}`);
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading file ${filePath}:`, err.message);
            return callback(err);
        }
        const lines = data.split('\n').filter(line => line.trim() !== '');
        const lastLines = lines.slice(-numLines);
        callback(null, lastLines.join('\n'));
    });
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    bot.sendMessage(chatId, 'Привет! Я бот для логов PM2. Используйте:\n' +
        '- /logs <количество_строк> для получения последних логов.\n' +
        '- /status для проверки состояния вашего приложения.\n' +
        '- /restart_server_site для перезапуска вашего приложения.');
});

bot.onText(/\/logs(?:@\w+)?(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    const linesToFetch = match[1] ? parseInt(match[1], 10) : 20;

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)');
        return;
    }

    await sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для ${PM2_APP_NAME}...`);

    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении OUT логов: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `[OUT - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${outLogs || 'Нет записей в OUT логе.'}`);
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении ERR логов: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `[ERR - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${errLogs || 'Нет записей в ERR логе.'}`);
    });
});

// Добавляем обработчик команды для перезапуска
bot.onText(/\/restart_server_site/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }

    await sendTelegramMessage(chatId, `Запрос на перезапуск ${PM2_APP_NAME}...`);

    pm2.restart(PM2_APP_NAME, async (err, apps) => {
        if (err) {
            console.error(`Error restarting ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при перезапуске ${PM2_APP_NAME}: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `🟢 ${PM2_APP_NAME} успешно запрошен на перезапуск.`);
        // PM2 также отправит событие 'restart', которое будет перехвачено и отправлено ботом.
    });
});

// --- Функционал мониторинга состояния PM2 ---

pm2.connect(function(err) {
    if (err) {
        console.error('Error connecting to PM2:', err.message);
        sendTelegramMessage(CHAT_ID, `🔴 Ошибка подключения бота к PM2: ${err.message}`, true);
        return;
    }

    console.log('Connected to PM2 daemon.');

    // Слушаем события PM2
    pm2.launchBus(function(err, bus) {
        if (err) {
            console.error('Error launching PM2 bus:', err.message);
            sendTelegramMessage(CHAT_ID, `🔴 Ошибка прослушивания событий PM2: ${err.message}`, true);
            return;
        }

        bus.on('process:event', function(data) {
            if (data.process.name === PM2_APP_NAME) {
                let message = `📊 PM2 уведомление для ${PM2_APP_NAME}: \n`;
                switch (data.event) {
                    case 'stop':
                        message += `🔴 ПРИЛОЖЕНИЕ ОСТАНОВЛЕНО! (Status: ${data.process.status})`;
                        break;
                    case 'restart':
                        message += `🟡 ПРИЛОЖЕНИЕ ПЕРЕЗАПУЩЕНО! (Status: ${data.process.status})`;
                        break;
                    case 'exit':
                        message += `💔 ПРИЛОЖЕНИЕ ВЫШЛО ИЗ СТРОЯ! (Status: ${data.process.status})`;
                        break;
                    case 'online':
                        message += `🟢 ПРИЛОЖЕНИЕ ЗАПУЩЕНО И РАБОТАЕТ! (Status: ${data.process.status})`;
                        break;
                    default:
                        message += `ℹ️ Неизвестное событие: ${data.event} (Status: ${data.process.status})`;
                        break;
                }
                sendTelegramMessage(CHAT_ID, message, true); // Принудительно отправляем уведомление
            }
        });
    });
});

// Обработка команды /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, `🔴 Ошибка при получении статуса PM2: ${err.message}`);
            console.error('Error listing PM2 processes:', err.message);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        if (app) {
            let statusMessage = `📊 Статус ${PM2_APP_NAME}:\n`;
            statusMessage += `  Статус: ${app.pm2_env.status}\n`;
            statusMessage += `  Uptime: ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            statusMessage += `  Перезапусков: ${app.pm2_env.restart_time}\n`;
            statusMessage += `  Память: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;
            statusMessage += `  CPU: ${app.monit.cpu}%\n`;
            await sendTelegramMessage(chatId, statusMessage);
        } else {
            await sendTelegramMessage(chatId, `Приложение ${PM2_APP_NAME} не найдено в PM2.`);
        }
    });
});


console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

// Обработка ошибок бота
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
    // bot.sendMessage(CHAT_ID, `❗️ Ошибкаpolling: ${error.code} - ${error.message}`); // Можно включить для уведомлений об ошибках самого бота
}); 