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

// Пути к файлам логов PM2
const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

// Ключевые слова для поиска критических ошибок и предупреждений
const CRITICAL_KEYWORDS = ['error', 'fatal', 'critical', 'exception', 'failed', 'timeout', 'denied', 'unauthorized', 'segfault'];
const WARNING_KEYWORDS = ['warn', 'warning', 'deprecated', 'unstable', 'notice'];

// Инициализация Telegram бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- Клавиатуры для команд ---
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📊 Статус приложения' }],
            [{ text: '📝 Последние логи (20 строк)' }],
            [{ text: '🔄 Перезапустить приложение' }],
            [{ text: '⚙️ Настройки мониторинга' }]
        ],
        resize_keyboard: true // Уменьшает размер кнопок
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

// Состояние бота (можно сохранять в БД для постоянства, сейчас в памяти)
let botState = {
    notificationsEnabled: true,
    notificationLevel: 'all' // 'all' или 'critical'
};

// --- Вспомогательные функции ---

// Экранирует символы MarkdownV2 для текста, который будет внутри MarkdownV2 сообщения,
// но не является частью самой разметки.
const escapeMarkdownV2Text = (str) => {
    if (typeof str !== 'string') return ''; // Защита от нестроковых значений
    return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
};

// Экранирует HTML-спецсимволы для текста, который будет внутри <pre> или <code>
const escapeHtml = (str) => {
    if (typeof str !== 'string') return ''; // Защита от нестроковых значений
    return str.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;');
};

// Функция для отправки сообщений, разделяющая их на части
// Принимает parseMode как параметр (или undefined для обычного текста)
async function sendLongMessage(chatId, text, options = {}) {
    // Если текст undefined, null или не строка, превращаем в пустую строку
    const messageText = typeof text === 'string' ? text : String(text || '');

    // Если forceSend не указан и текст пустой после обрезки пробелов, не отправляем
    if (!options.forceSend && messageText.trim() === '') {
        console.log('Attempted to send empty message, skipped.');
        return;
    }

    const MAX_MESSAGE_LENGTH = 4096; // Максимальная длина сообщения Telegram (4096 для Markdown/HTML, 4000 для Text)
    let parts = [];
    let remainingText = messageText;

    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        let lastNewline = part.lastIndexOf('\n');

        // Пытаемся разбить по новой строке, если часть точно на границе или больше
        if (lastNewline !== -1 && part.length === MAX_MESSAGE_LENGTH) {
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
            // Если это последняя часть, передаем reply_markup
            const currentOptions = (i === parts.length - 1) ? { ...options } : { parse_mode: options.parse_mode };
            await bot.sendMessage(chatId, part, currentOptions);
        } catch (error) {
            console.error('Error sending message part:', error.response ? error.response.data : error.message);
            // Если произошла ошибка парсинга, пробуем отправить как обычный текст
            if (options.parse_mode && error.response && error.response.data && error.response.data.description && error.response.data.description.includes("can't parse entities")) {
                console.warn('Attempting to send as plain text due to MarkdownV2/HTML parsing error.');
                try {
                    const plainTextOptions = (i === parts.length - 1) ? { reply_markup: options.reply_markup } : {};
                    await bot.sendMessage(chatId, part, plainTextOptions);
                } catch (fallbackError) {
                    console.error('Fallback to plain text also failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
                }
            } else {
                 // Если ошибка не связана с парсингом, просто логируем
                console.error('Failed to send message part even after retries or with other error types.');
            }
        }
    }
}


// --- Функционал отслеживания логов ---

let lastReadOutPosition = 0;
let lastReadErrPosition = 0;

console.log(`Watching for logs from: ${LOG_FILE_OUT} and ${LOG_FILE_ERR}`);

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
                            // Заголовок с MarkdownV2
                            sendLongMessage(CHAT_ID, `${alertType === 'CRITICAL' ? '🚨' : '⚠️'} *${escapeMarkdownV2Text(alertType)} ALERT* (${escapeMarkdownV2Text(PM2_APP_NAME)}):`, { parse_mode: 'MarkdownV2' });
                            // Сам лог в HTML <pre>, содержимое экранируем HTML
                            sendLongMessage(CHAT_ID, `<pre>${escapeHtml(line)}</pre>`, { parse_mode: 'HTML' });
                        }
                    }
                }
            });

            stream.on('end', () => {
                if (unprocessedLines.trim() !== '') {
                    if (botState.notificationsEnabled) {
                        const alertType = checkLogForKeywords(unprocessedLines);
                        if (alertType && (botState.notificationLevel === 'all' || alertType === 'CRITICAL')) {
                            sendLongMessage(CHAT_ID, `${alertType === 'CRITICAL' ? '🚨' : '⚠️'} *${escapeMarkdownV2Text(alertType)} ALERT* (${escapeMarkdownV2Text(PM2_APP_NAME)}):`, { parse_mode: 'MarkdownV2' });
                            sendLongMessage(CHAT_ID, `<pre>${escapeHtml(unprocessedLines)}</pre>`, { parse_mode: 'HTML' });
                        }
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

    const welcomeMsg = `👋 *Привет! Я бот для мониторинга приложения* \`${escapeMarkdownV2Text(PM2_APP_NAME)}\`\\.\n\n` +
                       `Используйте кнопки ниже для управления или введите команду вручную\\.`;

    // Отправляем сообщение с MarkdownV2 и главной клавиатурой
    sendLongMessage(chatId, welcomeMsg, {
        parse_mode: 'MarkdownV2',
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

    // Включаем "печатный" режим, чтобы пользователь видел, что бот что-то делает
    bot.sendChatAction(chatId, 'typing');

    switch(text) {
        case '📊 Статус приложения':
            checkPm2Status(chatId);
            break;

        case '📝 Последние логи (20 строк)':
            fetchLogs(chatId, 20, logsKeyboard); // Передаем logsKeyboard для показа после логов
            bot.sendMessage(chatId, 'Выберите количество строк логов:', logsKeyboard);
            break;

        case '🔄 Перезапустить приложение':
            restartApplication(chatId);
            break;

        case '⚙️ Настройки мониторинга':
            const settingsMessage = `*Текущие настройки:*\n\n` +
                                    `🔔 Уведомления: *${botState.notificationsEnabled ? 'Включены' : 'Выключены'}*\n` +
                                    `📢 Уровень: *${botState.notificationLevel === 'all' ? 'Все уведомления' : 'Только критические'}*`;
            sendLongMessage(chatId, settingsMessage, {
                parse_mode: 'MarkdownV2',
                ...settingsKeyboard
            });
            break;

        case '🔔 Включить уведомления':
            botState.notificationsEnabled = true;
            sendLongMessage(chatId, '🔔 *Уведомления включены*\\.', { parse_mode: 'MarkdownV2', ...settingsKeyboard });
            break;

        case '🔕 Выключить уведомления':
            botState.notificationsEnabled = false;
            sendLongMessage(chatId, '🔕 *Уведомления выключены*\\.', { parse_mode: 'MarkdownV2', ...settingsKeyboard });
            break;

        case '🚨 Только критические':
            botState.notificationLevel = 'critical';
            sendLongMessage(chatId, '🚨 *Будут приходить только критические уведомления*\\.', { parse_mode: 'MarkdownV2', ...settingsKeyboard });
            break;

        case 'ℹ️ Все уведомления':
            botState.notificationLevel = 'all';
            sendLongMessage(chatId, 'ℹ️ *Будут приходить все уведомления*\\.', { parse_mode: 'MarkdownV2', ...settingsKeyboard });
            break;

        case '🔙 На главную':
            sendLongMessage(chatId, '*Главное меню:*', { parse_mode: 'MarkdownV2', ...mainKeyboard });
            break;

        case '📝 10 строк логов':
            fetchLogs(chatId, 10, logsKeyboard);
            break;

        case '📝 20 строк логов':
            fetchLogs(chatId, 20, logsKeyboard);
            break;

        case '📝 50 строк логов':
            fetchLogs(chatId, 50, logsKeyboard);
            break;

        case '📝 100 строк логов':
            fetchLogs(chatId, 100, logsKeyboard);
            break;

        default:
            // Обработка команд вручную, если не нажата кнопка
            if (text.startsWith('/')) {
                handleCommand(chatId, text);
            } else {
                sendLongMessage(chatId, 'Неизвестная команда\\. Используйте кнопки для управления\\.', { parse_mode: 'MarkdownV2', ...mainKeyboard });
            }
            break;
    }
});

function handleCommand(chatId, command) {
    if (command.match(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/)) {
        const match = command.match(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/);
        const linesToFetch = match[1] ? parseInt(match[1], 10) : 20;
        fetchLogs(chatId, linesToFetch, mainKeyboard); // После команды /logs возвращаем на главную
    } else if (command.match(/^\/status$/)) {
        checkPm2Status(chatId);
    } else if (command.match(/^\/restart_server_site$/)) {
        restartApplication(chatId);
    } else if (command.match(/^\/start$/)) {
        // Команда /start обрабатывается отдельным bot.onText
    } else {
        sendLongMessage(chatId, 'Неизвестная команда\\. Используйте кнопки для управления\\.', { parse_mode: 'MarkdownV2', ...mainKeyboard });
    }
}

// Добавили необязательный параметр keyboardToSendAfterLogs
function fetchLogs(chatId, linesToFetch, keyboardToSendAfterLogs = null) {
    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        sendLongMessage(chatId, '❌ Пожалуйста, укажите корректное число строк \\(например: `/logs 50`\\)\\.', { parse_mode: 'MarkdownV2' });
        return;
    }

    sendLongMessage(chatId, `🔍 Запрашиваю последние *${linesToFetch}* строк логов для \`${escapeMarkdownV2Text(PM2_APP_NAME)}\`\\.\\.\\.`, { parse_mode: 'MarkdownV2' });

    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendLongMessage(chatId, `🔴 *Ошибка при чтении OUT логов:* ${escapeMarkdownV2Text(err.message)}\\.`, { parse_mode: 'MarkdownV2' });
            return;
        }
        // Заголовок OUT лога
        await sendLongMessage(chatId, `📋 *OUT лог \\(${escapeMarkdownV2Text(PM2_APP_NAME)} \\- последние ${linesToFetch} строк\\):*`, { parse_mode: 'MarkdownV2' });
        // Сам лог в HTML <pre>
        await sendLongMessage(chatId, `<pre>${escapeHtml(outLogs || 'Нет записей в OUT логе\\.')}</pre>`, { parse_mode: 'HTML' });
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendLongMessage(chatId, `🔴 *Ошибка при чтении ERR логов:* ${escapeMarkdownV2Text(err.message)}\\.`, { parse_mode: 'MarkdownV2' });
            return;
        }
        // Заголовок ERR лога
        await sendLongMessage(chatId, `🔥 *ERR лог \\(${escapeMarkdownV2Text(PM2_APP_NAME)} \\- последние ${linesToFetch} строк\\):*`, { parse_mode: 'MarkdownV2' });
        // Сам лог в HTML <pre> и с опциональной клавиатурой
        await sendLongMessage(chatId, `<pre>${escapeHtml(errLogs || 'Нет записей в ERR логе\\.')}</pre>`, { parse_mode: 'HTML', ...(keyboardToSendAfterLogs || mainKeyboard) });
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
            sendLongMessage(chatId, `🔴 *Ошибка при получении статуса PM2:* ${escapeMarkdownV2Text(err.message)}\\.`, { parse_mode: 'MarkdownV2', ...mainKeyboard });
            console.error('Error listing PM2 processes:', err.message);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        if (app) {
            let statusMessage = `📊 *Статус* \`${escapeMarkdownV2Text(PM2_APP_NAME)}\`\\:\n\n`;
            statusMessage += `🔹 *Состояние:* \`${escapeMarkdownV2Text(app.pm2_env.status)}\`\n`;
            statusMessage += `🔹 *Uptime:* \`${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\`\n`;
            statusMessage += `🔹 *Перезапусков:* \`${app.pm2_env.restart_time}\`\n`;
            statusMessage += `🔹 *Память:* \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;
            statusMessage += `🔹 *CPU:* \`${app.monit.cpu}%\`\n`;

            sendLongMessage(chatId, statusMessage, {
                parse_mode: 'MarkdownV2',
                ...mainKeyboard
            });
        } else {
            sendLongMessage(chatId, `🤷‍♂️ Приложение \`${escapeMarkdownV2Text(PM2_APP_NAME)}\` не найдено в PM2\\. Возможно, оно не запущено или имя указано неверно\\.`, { parse_mode: 'MarkdownV2', ...mainKeyboard });
        }
    });
}

function restartApplication(chatId) {
    sendLongMessage(chatId, `🔄 Запрос на перезапуск \`${escapeMarkdownV2Text(PM2_APP_NAME)}\`\\.\\.\\.`, { parse_mode: 'MarkdownV2' });

    pm2.restart(PM2_APP_NAME, (err, apps) => {
        if (err) {
            console.error(`Error restarting ${PM2_APP_NAME}:`, err.message);
            sendLongMessage(chatId, `🔴 *Ошибка при перезапуске* \`${escapeMarkdownV2Text(PM2_APP_NAME)}\`\\: ${escapeMarkdownV2Text(err.message)}\\.`, { parse_mode: 'MarkdownV2', ...mainKeyboard });
            return;
        }
        sendLongMessage(chatId, `✅ \`${escapeMarkdownV2Text(PM2_APP_NAME)}\` *успешно запрошен на перезапуск*\\.\\nОжидайте уведомления от PM2\\.`, { parse_mode: 'MarkdownV2', ...mainKeyboard });
    });
}

// --- Функционал мониторинга состояния PM2 ---

pm2.connect(function(err) {
    if (err) {
        console.error('Error connecting to PM2:', err.message);
        sendLongMessage(CHAT_ID, `🔴 *Ошибка подключения бота к PM2:* ${escapeMarkdownV2Text(err.message)}\\.`, { parse_mode: 'MarkdownV2' });
        return;
    }

    console.log('Connected to PM2 daemon.');

    pm2.launchBus(function(err, bus) {
        if (err) {
            console.error('Error launching PM2 bus:', err.message);
            sendLongMessage(CHAT_ID, `🔴 *Ошибка прослушивания событий PM2:* ${escapeMarkdownV2Text(err.message)}\\.`, { parse_mode: 'MarkdownV2' });
            return;
        }

        bus.on('process:event', function(data) {
            if (data.process.name === PM2_APP_NAME && botState.notificationsEnabled) {
                let message = `📊 *PM2 уведомление для* \`${escapeMarkdownV2Text(PM2_APP_NAME)}\`\\:\n\n`;
                const escapedStatus = escapeMarkdownV2Text(data.process.status);
                const escapedEvent = escapeMarkdownV2Text(data.event);

                switch (data.event) {
                    case 'stop':
                        message += `🔴 *ПРИЛОЖЕНИЕ ОСТАНОВЛЕНО!* \\(Status: \`${escapedStatus}\`\\)`;
                        break;
                    case 'restart':
                        message += `🟡 *ПРИЛОЖЕНИЕ ПЕРЕЗАПУЩЕНО!* \\(Status: \`${escapedStatus}\`\\)`;
                        break;
                    case 'exit':
                        message += `💔 *ПРИЛОЖЕНИЕ ВЫШЛО ИЗ СТРОЯ!* \\(Status: \`${escapedStatus}\`\\)`;
                        break;
                    case 'online':
                        message += `🟢 *ПРИЛОЖЕНИЕ ЗАПУЩЕНО И РАБОТАЕТ!* \\(Status: \`${escapedStatus}\`\\)`;
                        break;
                    default:
                        message += `ℹ️ Неизвестное событие: \`${escapedEvent}\` \\(Status: \`${escapedStatus}\`\\)`;
                        break;
                }
                sendLongMessage(CHAT_ID, message, { parse_mode: 'MarkdownV2' });
            }
        });
    });
});

console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});