const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');
const pm2 = require('pm2');

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

// --- Вспомогательные функции для экранирования Markdown ---

// Экранирует символы MarkdownV2 для обычного текста (вне блоков кода)
const escapeMarkdownV2Text = (str) => {
    return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
};

// --- Функция для отправки сообщений в Telegram ---
// Эта функция теперь используется только для отправки ЧИСТОГО текста (например, логов).
// Для сообщений с MarkdownV2 и кнопками будем использовать bot.sendMessage напрямую.
async function sendTelegramMessage(chatId, text, options = {}) {
    if (!text || !text.trim()) {
        return;
    }
    const MAX_MESSAGE_LENGTH = 4000; // Максимальная длина сообщения Telegram

    let remainingText = text;
    let parts = [];

    // Разбиваем сообщение на части
    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        let lastNewline = part.lastIndexOf('\n');

        if (lastNewline !== -1 && (part.length === MAX_MESSAGE_LENGTH || remainingText.length > MAX_MESSAGE_LENGTH)) {
            part = part.substring(0, lastNewline);
            remainingText = remainingText.substring(lastNewline + 1);
        } else {
            remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
        }
        parts.push(part);
    }

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        try {
            const currentOptions = (i === parts.length - 1) ? { ...options } : {};
            await bot.sendMessage(chatId, part, currentOptions);
            console.log(`Message part ${i + 1}/${parts.length} sent to Telegram.`);
        } catch (error) {
            console.error(`Error sending message part ${i + 1}/${parts.length}:`, error.response ? error.response.data : error.message);
            console.error('Failed to send message even without formatting. Check Telegram API errors.');
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
            let unprocessedLines = '';

            stream.on('data', (chunk) => {
                const lines = (unprocessedLines + chunk).split('\n');
                unprocessedLines = lines.pop();

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    const alertType = checkLogForKeywords(line);
                    if (alertType) {
                        const emoji = alertType === 'CRITICAL' ? '🚨' : '⚠️';
                        bot.sendMessage(CHAT_ID, `${emoji} *${alertType} ALERT* (${escapeMarkdownV2Text(PM2_APP_NAME)}):`, { parse_mode: 'MarkdownV2' });
                        sendTelegramMessage(CHAT_ID, line); // Сам лог без форматирования
                    } else {
                        bot.sendMessage(CHAT_ID, `📝 *Новый лог* [${type.toUpperCase()} - ${escapeMarkdownV2Text(PM2_APP_NAME)}]:`, { parse_mode: 'MarkdownV2' });
                        sendTelegramMessage(CHAT_ID, line); // Сам лог без форматирования
                    }
                }
            });

            stream.on('end', () => {
                if (unprocessedLines.trim() !== '') {
                    const alertType = checkLogForKeywords(unprocessedLines);
                    if (alertType) {
                        const emoji = alertType === 'CRITICAL' ? '🚨' : '⚠️';
                        bot.sendMessage(CHAT_ID, `${emoji} *${alertType} ALERT* (${escapeMarkdownV2Text(PM2_APP_NAME)}):`, { parse_mode: 'MarkdownV2' });
                        sendTelegramMessage(CHAT_ID, unprocessedLines);
                    } else {
                        bot.sendMessage(CHAT_ID, `📝 *Новый лог* [${type.toUpperCase()} - ${escapeMarkdownV2Text(PM2_APP_NAME)}]:`, { parse_mode: 'MarkdownV2' });
                        sendTelegramMessage(CHAT_ID, unprocessedLines);
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
        return callback(null, `Файл логов не найден: ${escapeMarkdownV2Text(filePath)}`);
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
    const welcomeMessage = `👋 *Привет! Я ваш бот для мониторинга PM2 логов и статуса.*
Я буду присылать вам критические ошибки и предупреждения из логов *${escapeMarkdownV2Text(PM2_APP_NAME)}*.

*Используйте кнопки ниже или введите команду:*`;

    const replyKeyboard = {
        keyboard: [
            [{ text: '/logs 20' }, { text: '/status' }],
            [{ text: '/restart_server_site' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false, // Кнопки будут всегда видны
    };

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'MarkdownV2',
        reply_markup: replyKeyboard
    });
});

bot.onText(/\/logs(?:@\w+)?(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    const linesToFetch = match[1] ? parseInt(match[1], 10) : 20;

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await bot.sendMessage(chatId, '❌ Пожалуйста, укажите корректное число строк (например: `/logs 50`)', { parse_mode: 'MarkdownV2' });
        return;
    }

    await sendLogsWithHeaders(chatId, linesToFetch);
});

// Переименовали функцию для ясности
async function sendLogsWithHeaders(chatId, linesToFetch) {
    // Отправляем заголовок с MarkdownV2
    await bot.sendMessage(chatId, `🔍 Запрашиваю последние *${linesToFetch}* строк логов для *${escapeMarkdownV2Text(PM2_APP_NAME)}*...`, { parse_mode: 'MarkdownV2' });

    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await bot.sendMessage(chatId, `🔴 Ошибка при чтении OUT логов: ${escapeMarkdownV2Text(err.message)}`, { parse_mode: 'MarkdownV2' });
            return;
        }
        // Заголовок с MarkdownV2
        await bot.sendMessage(chatId, `📋 *OUT лог (${escapeMarkdownV2Text(PM2_APP_NAME)} - последние ${linesToFetch} строк):*`, { parse_mode: 'MarkdownV2' });
        // Сам лог без форматирования
        await sendTelegramMessage(chatId, outLogs || 'Нет записей в OUT логе.');
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await bot.sendMessage(chatId, `🔴 Ошибка при чтении ERR логов: ${escapeMarkdownV2Text(err.message)}`, { parse_mode: 'MarkdownV2' });
            return;
        }
        // Заголовок с MarkdownV2
        await bot.sendMessage(chatId, `🔥 *ERR лог (${escapeMarkdownV2Text(PM2_APP_NAME)} - последние ${linesToFetch} строк):*`, { parse_mode: 'MarkdownV2' });
        // Сам лог без форматирования
        await sendTelegramMessage(chatId, errLogs || 'Нет записей в ERR логе.');
    });
}


bot.onText(/\/restart_server_site/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await bot.sendMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }

    await bot.sendMessage(chatId, `🔄 Запрос на перезапуск *${escapeMarkdownV2Text(PM2_APP_NAME)}*...`, { parse_mode: 'MarkdownV2' });

    pm2.restart(PM2_APP_NAME, async (err, apps) => {
        if (err) {
            console.error(`Error restarting ${PM2_APP_NAME}:`, err.message);
            await bot.sendMessage(chatId, `🔴 *Ошибка при перезапуске ${escapeMarkdownV2Text(PM2_APP_NAME)}:* ${escapeMarkdownV2Text(err.message)}`, { parse_mode: 'MarkdownV2' });
            return;
        }
        await bot.sendMessage(chatId, `✅ *${escapeMarkdownV2Text(PM2_APP_NAME)}* успешно запрошен на перезапуск\\. Ожидайте уведомления от PM2\\.`, { parse_mode: 'MarkdownV2' });
    });
});

// --- Функционал мониторинга состояния PM2 ---

pm2.connect(function(err) {
    if (err) {
        console.error('Error connecting to PM2:', err.message);
        bot.sendMessage(CHAT_ID, `🚨 *КРИТИЧЕСКАЯ ОШИБКА*: Не удалось подключиться к PM2\\. ${escapeMarkdownV2Text(err.message)}`, { parse_mode: 'MarkdownV2' });
        return;
    }

    console.log('Connected to PM2 daemon.');

    pm2.launchBus(function(err, bus) {
        if (err) {
            console.error('Error launching PM2 bus:', err.message);
            bot.sendMessage(CHAT_ID, `🚨 *КРИТИЧЕСКАЯ ОШИБКА*: Не удалось запустить шину событий PM2\\. ${escapeMarkdownV2Text(err.message)}`, { parse_mode: 'MarkdownV2' });
            return;
        }

        bus.on('process:event', function(data) {
            if (data.process.name === PM2_APP_NAME) {
                let message = `📊 *Уведомление PM2 для ${escapeMarkdownV2Text(PM2_APP_NAME)}:*\n`;
                const escapedStatus = escapeMarkdownV2Text(data.process.status);
                const escapedEvent = escapeMarkdownV2Text(data.event); // Экранируем, чтобы не было проблем, если event содержит спецсимволы

                switch (data.event) {
                    case 'stop':
                        message += `🔴 *ПРИЛОЖЕНИЕ ОСТАНОВЛЕНО!* Статус: \`${escapedStatus}\``;
                        break;
                    case 'restart':
                        message += `🟡 *ПРИЛОЖЕНИЕ ПЕРЕЗАПУЩЕНО!* Статус: \`${escapedStatus}\``;
                        break;
                    case 'exit':
                        message += `💔 *ПРИЛОЖЕНИЕ ВЫШЛО ИЗ СТРОЯ!* Статус: \`${escapedStatus}\``;
                        break;
                    case 'online':
                        message += `🟢 *ПРИЛОЖЕНИЕ ЗАПУЩЕНО И РАБОТАЕТ!* Статус: \`${escapedStatus}\``;
                        break;
                    default:
                        message += `ℹ️ *Неизвестное событие:* \`${escapedEvent}\` Статус: \`${escapedStatus}\``;
                        break;
                }
                bot.sendMessage(CHAT_ID, message, { parse_mode: 'MarkdownV2' });
            }
        });
    });
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    await sendStatusWithHeaders(chatId);
});

// Переименовали функцию для ясности
async function sendStatusWithHeaders(chatId) {
    pm2.list(async (err, list) => {
        if (err) {
            await bot.sendMessage(chatId, `🔴 *Ошибка при получении статуса PM2:* ${escapeMarkdownV2Text(err.message)}`, { parse_mode: 'MarkdownV2' });
            console.error('Error listing PM2 processes:', err.message);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        let statusMessage;
        if (app) {
            statusMessage = `📊 *Статус ${escapeMarkdownV2Text(PM2_APP_NAME)}:*\n`;
            statusMessage += `  *Состояние:* \`${escapeMarkdownV2Text(app.pm2_env.status)}\`\n`;
            statusMessage += `  *Uptime:* \`${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\`\n`;
            statusMessage += `  *Перезапусков:* \`${app.pm2_env.restart_time}\`\n`;
            statusMessage += `  *Память:* \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;
            statusMessage += `  *CPU:* \`${app.monit.cpu}%\`\n`;
        } else {
            statusMessage = `🤷‍♂️ Приложение *${escapeMarkdownV2Text(PM2_APP_NAME)}* не найдено в PM2\\. Возможно, оно не запущено или имя указано неверно\\.`;
        }

        // ReplyKeyboard не исчезает, поэтому нет необходимости в ней в каждом сообщении статуса/лога.
        // Она будет показана при /start и всегда доступна.
        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'MarkdownV2' });
    });
}


console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

// --- Удаляем обработчик callback_query, так как inline-кнопок больше нет ---
// bot.on('callback_query', async (query) => { ... });

// Обработка ошибок бота
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});