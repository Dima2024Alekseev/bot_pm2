const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');
const pm2 = require('pm2');
const { getDrives } = require('node-disk-info');

// *** НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ ***
const BOT_TOKEN = '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds'; // Ваш токен бота
const CHAT_ID = '1364079703';     // Ваш Chat ID (может быть числом или строкой)
const PM2_APP_NAME = 'server-site'; // Имя вашего PM2-приложения

// Пороги для оповещений
const DISK_SPACE_THRESHOLD_PERCENT = 15; // Процент свободного места, ниже которого отправляется предупреждение
const CPU_THRESHOLD_PERCENT = 80;       // Процент CPU, выше которого отправляется предупреждение для PM2_APP_NAME
const MEMORY_THRESHOLD_MB = 500;        // Мегабайты памяти, выше которых отправляется предупреждение для PM2_APP_NAME

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Интервал проверки (5 минут) для диска, CPU, памяти
// ******************************

// ПУТИ К ФАЙЛАМ ЛОГОВ PM2 - ВЗЯТЫ ИЗ ВАШЕГО ВЫВОДА `pm2 show`
const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

// Ключевые слова для поиска критических ошибок и предупреждений (нечувствительны к регистру)
const CRITICAL_KEYWORDS = ['error', 'fatal', 'critical', 'exception', 'failed', 'timeout', 'denied', 'unauthorized', 'segfault'];
const WARNING_KEYWORDS = ['warn', 'warning', 'deprecated', 'unstable', 'notice'];

// Инициализация Telegram бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- Состояние пользователя для навигации по меню ---
const userStates = {}; // { chatId: 'current_menu_state' }

// --- Функции для отправки сообщений с Markdown и опциями ---
async function sendTelegramMessage(chatId, text, forceSend = false, options = {}) {
    if (!text.trim() && !forceSend) {
        return;
    }
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

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        try {
            const currentOptions = i === 0 ? { parse_mode: 'MarkdownV2', ...options } : { parse_mode: 'MarkdownV2' };
            await bot.sendMessage(chatId, `\`\`\`\n${part}\n\`\`\``, currentOptions);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram (MarkdownV2 failed):', error.response ? error.response.data : error.message);
            try {
                const currentOptions = i === 0 ? options : {};
                await bot.sendMessage(chatId, part, currentOptions);
                console.log('Message part sent without MarkdownV2 due to error.');
            } catch (fallbackError) {
                console.error('Fallback send failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
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
            let unprocessedLines = '';

            stream.on('data', (chunk) => {
                const lines = (unprocessedLines + chunk).split('\n');
                unprocessedLines = lines.pop();

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    const alertType = checkLogForKeywords(line);
                    if (alertType) {
                        sendTelegramMessage(CHAT_ID, `🚨 ${alertType} (${PM2_APP_NAME})\n\`\`\`\n${line}\n\`\`\``);
                    } else {
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - ${PM2_APP_NAME} - NEW]\n${line}`);
                    }
                }
            });

            stream.on('end', () => {
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

// --- Определение клавиатур ---

const keyboardOptions = {
    resize_keyboard: true,
    one_time_keyboard: false
};

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🛠️ Управление' }, { text: '📊 Мониторинг' }],
            [{ text: '❓ Помощь' }]
        ],
        ...keyboardOptions
    }
};

const managementKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔄 Перезапустить сервер' }],
            [{ text: '⏹️ Остановить сервер' }, { text: '▶️ Запустить сервер' }],
            [{ text: '⬅️ Назад в Главное меню' }]
        ],
        ...keyboardOptions
    }
};

const monitoringKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📈 Статус приложения' }, { text: '📄 Последние 20 логов' }],
            [{ text: '🩺 Проверить систему' }, { text: '📋 Список всех приложений' }],
            [{ text: '⬅️ Назад в Главное меню' }]
        ],
        ...keyboardOptions
    }
};

// --- ИСПРАВЛЕННАЯ ФУНКЦИЯ ДЛЯ ОТПРАВКИ СООБЩЕНИЙ С КЛАВИАТУРОЙ ---
async function sendMessageWithKeyboard(chatId, text, keyboard, options = {}) {
    await bot.sendMessage(chatId, text, {
        reply_markup: keyboard.reply_markup, // <-- ИСПРАВЛЕНО
        ...options // Позволяет переопределять или добавлять другие опции, например parse_mode
    });
}


bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId] = 'main'; // Устанавливаем начальное состояние
    await sendMessageWithKeyboard(chatId, 'Привет! Я бот для мониторинга и управления PM2. Выберите категорию:', mainKeyboard);
});

// --- Обработка кнопок главного меню ---
bot.onText(/🛠️ Управление/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = 'management';
    await sendMessageWithKeyboard(chatId, 'Вы в меню управления. Выберите действие:', managementKeyboard);
});

bot.onText(/📊 Мониторинг/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = 'monitoring';
    await sendMessageWithKeyboard(chatId, 'Вы в меню мониторинга. Выберите информацию:', monitoringKeyboard);
});

bot.onText(/❓ Помощь/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    await sendTelegramMessage(chatId, 'Привет! Я бот для логов PM2. Используйте кнопки для взаимодействия. Вот что я могу:\n' +
        '- *Управление*: Перезапуск, остановка, запуск вашего приложения.\n' +
        '- *Мониторинг*: Проверка статуса, логов, состояния системы и списка всех PM2 приложений.\n' +
        '- *Помощь*: Получить это сообщение.\n\n' +
        'Чтобы вернуться в главное меню, нажмите "⬅️ Назад в Главное меню".');
});

bot.onText(/⬅️ Назад в Главное меню/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = 'main';
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в главное меню. Выберите категорию:', mainKeyboard);
});

// --- Обработка команд из подменю "Мониторинг" ---

bot.onText(/📈 Статус приложения/, async (msg) => {
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
            statusMessage += `   Статус: ${app.pm2_env.status}\n`;
            statusMessage += `   Uptime: ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            statusMessage += `   Перезапусков: ${app.pm2_env.restart_time}\n`;
            statusMessage += `   Память: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;
            statusMessage += `   CPU: ${app.monit.cpu}%\n`;

            if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
                statusMessage += `   ⚠️ Внимание: CPU (${app.monit.cpu}%) выше порога ${CPU_THRESHOLD_PERCENT}%\n`;
            }
            if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
                statusMessage += `   ⚠️ Внимание: Память (${(app.monit.memory / 1024 / 1024).toFixed(2)} MB) выше порога ${MEMORY_THRESHOLD_MB} MB\n`;
            }

            await sendTelegramMessage(chatId, statusMessage);
        } else {
            await sendTelegramMessage(chatId, `Приложение ${PM2_APP_NAME} не найдено в PM2.`);
        }
    });
});

bot.onText(/📄 Последние (\d+) логов|📄 Последние логов/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    // Если нет числа в команде, по умолчанию 20
    const linesToFetch = match && match[1] ? parseInt(match[1], 10) : 20;

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


bot.onText(/🩺 Проверить систему/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    await sendTelegramMessage(chatId, 'Выполняю ручную проверку состояния системы...');
    await checkSystemHealth();
});

bot.onText(/📋 Список всех приложений/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    await sendTelegramMessage(chatId, 'Запрашиваю список всех приложений PM2...');

    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, `🔴 Ошибка при получении списка приложений PM2: ${err.message}`);
            console.error('Error listing all PM2 processes:', err.message);
            return;
        }

        if (list.length === 0) {
            await sendTelegramMessage(chatId, 'В PM2 не найдено запущенных приложений.');
            return;
        }

        let message = '📋 Список всех приложений PM2:\n\n';
        list.forEach(app => {
            message += `*Имя:* ${app.name}\n`;
            message += `  *ID:* ${app.pm_id}\n`;
            message += `  *Статус:* ${app.pm2_env.status}\n`;
            message += `  *Uptime:* ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            message += `  *Перезапусков:* ${app.pm2_env.restart_time}\n`;
            message += `  *Память:* ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;
            message += `  *CPU:* ${app.monit.cpu}%\n`;
            message += `\n`;
        });

        await sendTelegramMessage(chatId, message);
    });
});


// --- Обработка команд из подменю "Управление" ---

bot.onText(/🔄 Перезапустить сервер/, async (msg) => {
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
    });
});

bot.onText(/⏹️ Остановить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }

    await sendTelegramMessage(chatId, `Запрос на остановку ${PM2_APP_NAME}...`);

    pm2.stop(PM2_APP_NAME, async (err) => {
        if (err) {
            console.error(`Error stopping ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при остановке ${PM2_APP_NAME}: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `⚫️ ${PM2_APP_NAME} успешно запрошен на остановку.`);
    });
});

bot.onText(/▶️ Запустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }

    await sendTelegramMessage(chatId, `Запрос на запуск ${PM2_APP_NAME}...`);

    pm2.start(PM2_APP_NAME, async (err) => {
        if (err) {
            console.error(`Error starting ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при запуске ${PM2_APP_NAME}: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `🟢 ${PM2_APP_NAME} успешно запрошен на запуск.`);
    });
});


// --- Функционал мониторинга состояния PM2 (без изменений) ---
pm2.connect(function (err) {
    if (err) {
        console.error('Error connecting to PM2:', err.message);
        sendTelegramMessage(CHAT_ID, `🔴 Ошибка подключения бота к PM2: ${err.message}`, true);
        return;
    }
    console.log('Connected to PM2 daemon.');

    pm2.launchBus(function (err, bus) {
        if (err) {
            console.error('Error launching PM2 bus:', err.message);
            sendTelegramMessage(CHAT_ID, `🔴 Ошибка прослушивания событий PM2: ${err.message}`, true);
            return;
        }

        bus.on('process:event', function (data) {
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
                sendTelegramMessage(CHAT_ID, message, true);
            }
        });
    });
});

// --- Системная проверка (без изменений) ---
async function checkSystemHealth() {
    console.log('Performing scheduled system health check...');
    let healthMessage = '🩺 Ежедневная проверка состояния системы:\n';
    let alertCount = 0;

    try {
        const drives = await getDrives();
        let diskInfo = '';
        drives.forEach(drive => {
            const usedPercent = (drive.used / drive.total * 100).toFixed(2);
            const freePercent = (drive.available / drive.total * 100).toFixed(2);
            diskInfo += `  Диск ${drive.mounted}:\n`;
            diskInfo += `    Всего: ${(drive.total / (1024 ** 3)).toFixed(2)} GB\n`;
            diskInfo += `    Использовано: ${(drive.used / (1024 ** 3)).toFixed(2)} GB (${usedPercent}%)\n`;
            diskInfo += `    Свободно: ${(drive.available / (1024 ** 3)).toFixed(2)} GB (${freePercent}%)\n`;

            if (freePercent < DISK_SPACE_THRESHOLD_PERCENT) {
                healthMessage += `🚨 Низкое место на диске ${drive.mounted}: ${freePercent}% свободно (ниже ${DISK_SPACE_THRESHOLD_PERCENT}%)\n`;
                alertCount++;
            }
        });
        healthMessage += `\n💾 Информация о дисках:\n${diskInfo}`;
    } catch (e) {
        healthMessage += `🔴 Ошибка при получении информации о дисках: ${e.message}\n`;
        console.error('Error getting disk info:', e);
        alertCount++;
    }

    pm2.list(async (err, list) => {
        if (err) {
            healthMessage += `🔴 Ошибка при получении списка PM2 приложений для проверки: ${err.message}\n`;
            console.error('Error listing PM2 processes for health check:', err.message);
            alertCount++;
            await sendTelegramMessage(CHAT_ID, healthMessage, true);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);
        if (app) {
            healthMessage += `\n📈 Состояние ${PM2_APP_NAME}:\n`;
            healthMessage += `  CPU: ${app.monit.cpu}%\n`;
            healthMessage += `  Память: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;

            if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
                healthMessage += `🚨 CPU (${app.monit.cpu}%) выше порога ${CPU_THRESHOLD_PERCENT}%\n`;
                alertCount++;
            }
            if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
                healthMessage += `🚨 Память (${(app.monit.memory / 1024 / 1024).toFixed(2)} MB) выше порога ${MEMORY_THRESHOLD_MB} MB\n`;
                alertCount++;
            }
        } else {
            healthMessage += `\nПриложение ${PM2_APP_NAME} не найдено в PM2 для проверки CPU/памяти.\n`;
        }

        if (alertCount > 0) {
            await sendTelegramMessage(CHAT_ID, healthMessage, true);
        } else {
            console.log('System health check passed without alerts.');
        }
    });
}

setInterval(checkSystemHealth, CHECK_INTERVAL_MS);

console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});