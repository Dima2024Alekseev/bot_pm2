const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');
const pm2 = require('pm2');

// *** НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ ***
const BOT_TOKEN = '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds';
const CHAT_ID = '1364079703';
const PM2_APP_NAME = 'server-site';
// ******************************

const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

const CRITICAL_KEYWORDS = ['error', 'fatal', 'critical', 'exception', 'failed', 'timeout', 'denied', 'unauthorized', 'segfault'];
const WARNING_KEYWORDS = ['warn', 'warning', 'deprecated', 'unstable', 'notice'];

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Клавиатуры для команд
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📊 Статус приложения' }],
            [{ text: '📝 Последние логи (20 строк)' }],
            [{ text: '🔄 Перезапустить приложение' }],
            [{ text: '⚙️ Настройки мониторинга' }]
        ],
        resize_keyboard: true
    }
};

const logsKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📝 10 строк логов' }, { text: '📝 20 строк логов' }],
            [{ text: '📝 50 строк логов' }, { text: '📝 100 строк логов' }],
            [{ text: '🔙 На главную' }]
        ],
        resize_keyboard: true
    }
};

const settingsKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔔 Включить уведомления' }, { text: '🔕 Выключить уведомления' }],
            [{ text: '🚨 Только критические' }, { text: 'ℹ️ Все уведомления' }],
            [{ text: '🔙 На главную' }]
        ],
        resize_keyboard: true
    }
};

// Состояние бота (можно сохранять в БД для постоянства)
let botState = {
    notificationsEnabled: true,
    notificationLevel: 'all' // 'all' или 'critical'
};

// Функция для отправки сообщений в Telegram
async function sendTelegramMessage(chatId, text, forceSend = false, options = {}) {
    if (!text.trim() && !forceSend) return;
    
    const MAX_MESSAGE_LENGTH = 4000;
    let parts = [];
    let remainingText = text;

    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
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
            await bot.sendMessage(chatId, `\`\`\`\n${part}\n\`\`\``, { 
                parse_mode: 'MarkdownV2',
                ...options 
            });
        } catch (error) {
            console.error('Error sending message:', error.message);
            try {
                await bot.sendMessage(chatId, part, options);
            } catch (fallbackError) {
                console.error('Fallback send failed:', fallbackError.message);
            }
        }
    }
}

// --- Функционал отслеживания логов ---

let lastReadOutPosition = 0;
let lastReadErrPosition = 0;

function checkLogForKeywords(logLine) {
    const lowerCaseLine = logLine.toLowerCase();
    for (const keyword of CRITICAL_KEYWORDS) {
        if (lowerCaseLine.includes(keyword)) return 'CRITICAL';
    }
    for (const keyword of WARNING_KEYWORDS) {
        if (lowerCaseLine.includes(keyword)) return 'WARNING';
    }
    return null;
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

                    if (botState.notificationsEnabled) {
                        const alertType = checkLogForKeywords(line);
                        if (alertType && (botState.notificationLevel === 'all' || alertType === 'CRITICAL')) {
                            sendTelegramMessage(CHAT_ID, `🚨 ${alertType} (${PM2_APP_NAME})\n\`\`\`\n${line}\n\`\`\``);
                        }
                    }
                }
            });

            stream.on('end', () => {
                if (unprocessedLines.trim() !== '') {
                    const alertType = checkLogForKeywords(unprocessedLines);
                    if (alertType && (botState.notificationLevel === 'all' || alertType === 'CRITICAL')) {
                        sendTelegramMessage(CHAT_ID, `🚨 ${alertType} (${PM2_APP_NAME})\n\`\`\`\n${unprocessedLines}\n\`\`\``);
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
        } else {
            console.warn(`Log file not found: ${filePath}`);
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
        if (filePath === LOG_FILE_OUT) lastPositionOut.value = 0;
        if (filePath === LOG_FILE_ERR) lastPositionErr.value = 0;
        processLogFile(filePath, filePath === LOG_FILE_OUT ? lastPositionOut : lastPositionErr, filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('change', (filePath) => {
        processLogFile(filePath, filePath === LOG_FILE_OUT ? lastPositionOut : lastPositionErr, filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('error', (error) => console.error(`Watcher error: ${error}`));

// --- Обработчики команд и кнопок ---

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    
    const welcomeMsg = `👋 Привет! Я бот для мониторинга приложения *${PM2_APP_NAME}*.\n\n` +
                      `Используйте кнопки ниже для управления или введите команду вручную.`;
    
    bot.sendMessage(chatId, welcomeMsg, {
        parse_mode: 'Markdown',
        ...mainKeyboard
    });
});

// Обработка текстовых сообщений (кнопок)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    const text = msg.text;
    
    switch(text) {
        case '📊 Статус приложения':
            checkPm2Status(chatId);
            break;
            
        case '📝 Последние логи (20 строк)':
            fetchLogs(chatId, 20);
            bot.sendMessage(chatId, 'Выберите количество строк логов:', logsKeyboard);
            break;
            
        case '🔄 Перезапустить приложение':
            restartApplication(chatId);
            break;
            
        case '⚙️ Настройки мониторинга':
            bot.sendMessage(chatId, `Текущие настройки:\n\n` +
                                  `🔔 Уведомления: ${botState.notificationsEnabled ? 'Включены' : 'Выключены'}\n` +
                                  `📢 Уровень: ${botState.notificationLevel === 'all' ? 'Все уведомления' : 'Только критические'}`, 
                                  settingsKeyboard);
            break;
            
        case '🔔 Включить уведомления':
            botState.notificationsEnabled = true;
            bot.sendMessage(chatId, '🔔 Уведомления включены', settingsKeyboard);
            break;
            
        case '🔕 Выключить уведомления':
            botState.notificationsEnabled = false;
            bot.sendMessage(chatId, '🔕 Уведомления выключены', settingsKeyboard);
            break;
            
        case '🚨 Только критические':
            botState.notificationLevel = 'critical';
            bot.sendMessage(chatId, '🚨 Будут приходить только критические уведомления', settingsKeyboard);
            break;
            
        case 'ℹ️ Все уведомления':
            botState.notificationLevel = 'all';
            bot.sendMessage(chatId, 'ℹ️ Будут приходить все уведомления', settingsKeyboard);
            break;
            
        case '🔙 На главную':
            bot.sendMessage(chatId, 'Главное меню:', mainKeyboard);
            break;
            
        case '📝 10 строк логов':
            fetchLogs(chatId, 10);
            break;
            
        case '📝 20 строк логов':
            fetchLogs(chatId, 20);
            break;
            
        case '📝 50 строк логов':
            fetchLogs(chatId, 50);
            break;
            
        case '📝 100 строк логов':
            fetchLogs(chatId, 100);
            break;
            
        default:
            // Обработка команд вручную, если не нажата кнопка
            if (text.startsWith('/')) {
                handleCommand(chatId, text);
            }
            break;
    }
});

function handleCommand(chatId, command) {
    if (command.match(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/)) {
        const match = command.match(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/);
        const linesToFetch = match[1] ? parseInt(match[1], 10) : 20;
        fetchLogs(chatId, linesToFetch);
    } else if (command.match(/^\/status$/)) {
        checkPm2Status(chatId);
    } else if (command.match(/^\/restart_server_site$/)) {
        restartApplication(chatId);
    } else {
        bot.sendMessage(chatId, 'Неизвестная команда. Используйте кнопки для управления.', mainKeyboard);
    }
}

function fetchLogs(chatId, linesToFetch) {
    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)');
        return;
    }

    sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для ${PM2_APP_NAME}...`);

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
}

function readLastLines(filePath, numLines, callback) {
    if (!fs.existsSync(filePath)) {
        return callback(null, `Файл логов не найден: ${filePath}`);
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return callback(err);
        const lines = data.split('\n').filter(line => line.trim() !== '');
        const lastLines = lines.slice(-numLines);
        callback(null, lastLines.join('\n'));
    });
}

function checkPm2Status(chatId) {
    pm2.list((err, list) => {
        if (err) {
            sendTelegramMessage(chatId, `🔴 Ошибка при получении статуса PM2: ${err.message}`);
            console.error('Error listing PM2 processes:', err.message);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        if (app) {
            let statusMessage = `📊 *Статус ${PM2_APP_NAME}:*\n\n`;
            statusMessage += `🔹 *Статус:* ${app.pm2_env.status}\n`;
            statusMessage += `🔹 *Uptime:* ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            statusMessage += `🔹 *Перезапусков:* ${app.pm2_env.restart_time}\n`;
            statusMessage += `🔹 *Память:* ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;
            statusMessage += `🔹 *CPU:* ${app.monit.cpu}%\n`;
            
            bot.sendMessage(chatId, statusMessage, {
                parse_mode: 'Markdown',
                ...mainKeyboard
            });
        } else {
            sendTelegramMessage(chatId, `Приложение ${PM2_APP_NAME} не найдено в PM2.`, mainKeyboard);
        }
    });
}

function restartApplication(chatId) {
    sendTelegramMessage(chatId, `Запрос на перезапуск ${PM2_APP_NAME}...`);

    pm2.restart(PM2_APP_NAME, (err, apps) => {
        if (err) {
            console.error(`Error restarting ${PM2_APP_NAME}:`, err.message);
            sendTelegramMessage(chatId, `🔴 Ошибка при перезапуске ${PM2_APP_NAME}: ${err.message}`, false, mainKeyboard);
            return;
        }
        sendTelegramMessage(chatId, `🟢 ${PM2_APP_NAME} успешно запрошен на перезапуск.`, false, mainKeyboard);
    });
}

// --- Функционал мониторинга состояния PM2 ---

pm2.connect(function(err) {
    if (err) {
        console.error('Error connecting to PM2:', err.message);
        sendTelegramMessage(CHAT_ID, `🔴 Ошибка подключения бота к PM2: ${err.message}`, true);
        return;
    }

    pm2.launchBus(function(err, bus) {
        if (err) {
            console.error('Error launching PM2 bus:', err.message);
            sendTelegramMessage(CHAT_ID, `🔴 Ошибка прослушивания событий PM2: ${err.message}`, true);
            return;
        }

        bus.on('process:event', function(data) {
            if (data.process.name === PM2_APP_NAME && botState.notificationsEnabled) {
                let message = `📊 *PM2 уведомление для ${PM2_APP_NAME}:* \n\n`;
                switch (data.event) {
                    case 'stop':
                        message += `🔴 *ПРИЛОЖЕНИЕ ОСТАНОВЛЕНО!* (Status: ${data.process.status})`;
                        break;
                    case 'restart':
                        message += `🟡 *ПРИЛОЖЕНИЕ ПЕРЕЗАПУЩЕНО!* (Status: ${data.process.status})`;
                        break;
                    case 'exit':
                        message += `💔 *ПРИЛОЖЕНИЕ ВЫШЛО ИЗ СТРОЯ!* (Status: ${data.process.status})`;
                        break;
                    case 'online':
                        message += `🟢 *ПРИЛОЖЕНИЕ ЗАПУЩЕНО И РАБОТАЕТ!* (Status: ${data.process.status})`;
                        break;
                    default:
                        message += `ℹ️ Неизвестное событие: ${data.event} (Status: ${data.process.status})`;
                        break;
                }
                sendTelegramMessage(CHAT_ID, message, true, mainKeyboard);
            }
        });
    });
});

console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});