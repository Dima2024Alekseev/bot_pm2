const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');
const pm2 = require('pm2');
const { getDrives } = require('node-disk-info');

// Конфигурация
const BOT_TOKEN = '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds';
const CHAT_ID = '1364079703';
const PM2_APP_NAME = 'server-site';

// Пороговые значения
const DISK_SPACE_THRESHOLD_PERCENT = 15;
const CPU_THRESHOLD_PERCENT = 80;
const MEMORY_THRESHOLD_MB = 500;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

// Эмодзи для визуализации
const EMOJI = {
    ERROR: '🚨',
    WARNING: '⚠️',
    INFO: 'ℹ️',
    SUCCESS: '✅',
    CRITICAL: '🔥',
    DISK: '💾',
    MEMORY: '🧠',
    CPU: '⚡',
    SERVER: '🖥️',
    CLOCK: '⏱️',
    RESTART: '🔄',
    STOP: '⏹️',
    START: '▶️',
    LIST: '📋',
    HEALTH: '🩺',
    LOGS: '📄',
    ALERT: '🔔',
    OK: '🟢',
    PROBLEM: '🔴'
};

// Пути к логам
const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

// Ключевые слова для поиска
const CRITICAL_KEYWORDS = ['error', 'fatal', 'critical', 'exception', 'failed', 'timeout', 'denied', 'unauthorized', 'segfault'];
const WARNING_KEYWORDS = ['warn', 'warning', 'deprecated', 'unstable', 'notice'];

// Инициализация бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Форматирование сообщений
function formatMessage(title, content, type = 'info') {
    const border = '═'.repeat(35);
    let emoji = '';
    
    switch (type.toLowerCase()) {
        case 'error': emoji = EMOJI.ERROR; break;
        case 'warning': emoji = EMOJI.WARNING; break;
        case 'success': emoji = EMOJI.SUCCESS; break;
        case 'critical': emoji = EMOJI.CRITICAL; break;
        case 'info':
        default: emoji = EMOJI.INFO;
    }
    
    return `${emoji} *${title.toUpperCase()}*\n${border}\n${content}\n${border}`;
}

// Отправка сообщений с обработкой длинных текстов
async function sendTelegramMessage(chatId, text, forceSend = false) {
    if (!text.trim() && !forceSend) return;

    const MAX_MESSAGE_LENGTH = 4000;
    const messages = [];
    let remainingText = text;

    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        const lastNewline = part.lastIndexOf('\n');
        
        if (lastNewline !== -1 && lastNewline !== part.length - 1 && remainingText.length > MAX_MESSAGE_LENGTH) {
            part = part.substring(0, lastNewline);
            remainingText = remainingText.substring(lastNewline + 1);
        } else {
            remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
        }
        messages.push(part);
    }

    for (const message of messages) {
        try {
            const isLogMessage = message.includes('```') || message.includes('LOG') || message.includes('ERR');
            await bot.sendMessage(
                chatId, 
                message, 
                { 
                    parse_mode: isLogMessage ? 'MarkdownV2' : 'Markdown',
                    disable_web_page_preview: true
                }
            );
        } catch (error) {
            console.error('Error sending message:', error.message);
            try {
                await bot.sendMessage(chatId, message);
            } catch (fallbackError) {
                console.error('Fallback send failed:', fallbackError.message);
            }
        }
    }
}

// --- Логирование и мониторинг файлов ---
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
            console.error(`Error checking file ${filePath}:`, err.message);
            return;
        }

        const currentSize = stats.size;
        if (currentSize < lastPositionRef.value) {
            console.log(`Log file ${filePath} was truncated. Resetting position.`);
            lastPositionRef.value = 0;
        }

        if (currentSize > lastPositionRef.value) {
            const stream = fs.createReadStream(filePath, { 
                start: lastPositionRef.value, 
                encoding: 'utf8' 
            });
            
            let buffer = '';
            let unprocessedLines = '';

            stream.on('data', (chunk) => {
                const lines = (unprocessedLines + chunk).split('\n');
                unprocessedLines = lines.pop();

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    const alertType = checkLogForKeywords(line);
                    if (alertType) {
                        const formattedMessage = formatMessage(
                            `${alertType} in ${PM2_APP_NAME} (${type.toUpperCase()})`,
                            `\`\`\`\n${line}\n\`\`\``,
                            alertType.toLowerCase()
                        );
                        sendTelegramMessage(CHAT_ID, formattedMessage);
                    }
                }
            });

            stream.on('end', () => {
                if (unprocessedLines.trim() !== '') {
                    const alertType = checkLogForKeywords(unprocessedLines);
                    if (alertType) {
                        const formattedMessage = formatMessage(
                            `${alertType} in ${PM2_APP_NAME} (${type.toUpperCase()})`,
                            `\`\`\`\n${unprocessedLines}\n\`\`\``,
                            alertType.toLowerCase()
                        );
                        sendTelegramMessage(CHAT_ID, formattedMessage);
                    }
                }
                lastPositionRef.value = currentSize;
            });

            stream.on('error', (readErr) => {
                console.error(`Error reading ${filePath}:`, readErr.message);
            });
        }
    });
}

function initializeLogPositions() {
    [LOG_FILE_OUT, LOG_FILE_ERR].forEach(filePath => {
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            if (filePath === LOG_FILE_OUT) lastReadOutPosition = stats.size;
            if (filePath === LOG_FILE_ERR) lastReadErrPosition = stats.size;
            console.log(`Initialized log position for ${filePath}: ${stats.size}`);
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
        console.log(`File added: ${filePath}`);
        if (filePath === LOG_FILE_OUT) lastReadOutPosition = 0;
        if (filePath === LOG_FILE_ERR) lastReadErrPosition = 0;
        processLogFile(filePath, 
            filePath === LOG_FILE_OUT ? { value: lastReadOutPosition } : { value: lastReadErrPosition }, 
            filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('change', (filePath) => {
        console.log(`File changed: ${filePath}`);
        processLogFile(filePath, 
            filePath === LOG_FILE_OUT ? { value: lastReadOutPosition } : { value: lastReadErrPosition }, 
            filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('error', (error) => console.error(`Watcher error: ${error}`));

// --- Команды бота ---

// Стартовое сообщение
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, '🚫 Access denied.');
        return;
    }
    
    const welcomeMessage = formatMessage(
        'PM2 Monitoring Bot',
        `${EMOJI.LOGS} /logs <n> - Get last n log lines\n` +
        `${EMOJI.HEALTH} /status - Check app status\n` +
        `${EMOJI.RESTART} /restart_server_site - Restart app\n` +
        `${EMOJI.STOP} /stop_server_site - Stop app\n` +
        `${EMOJI.START} /start_server_site - Start app\n` +
        `${EMOJI.LIST} /list_all_apps - List all PM2 apps\n` +
        `${EMOJI.HEALTH} /check_system_health - System health check`,
        'info'
    );
    
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// Чтение последних строк логов
bot.onText(/\/logs(?:@\w+)?(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;

    const linesToFetch = match[1] ? parseInt(match[1], 10) : 20;
    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, formatMessage(
            'Invalid Input',
            'Please specify a positive number (e.g. /logs 50)',
            'warning'
        ));
        return;
    }

    await sendTelegramMessage(chatId, formatMessage(
        'Log Request',
        `Fetching last ${linesToFetch} lines for ${PM2_APP_NAME}...`,
        'info'
    ));

    const readLastLines = (filePath, numLines, logType) => {
        return new Promise((resolve) => {
            if (!fs.existsSync(filePath)) {
                resolve(`Log file not found: ${filePath}`);
                return;
            }

            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    resolve(`Error reading ${logType} logs: ${err.message}`);
                    return;
                }
                const lines = data.split('\n').filter(line => line.trim() !== '');
                const lastLines = lines.slice(-numLines);
                resolve(lastLines.join('\n'));
            });
        });
    };

    const outLogs = await readLastLines(LOG_FILE_OUT, linesToFetch, 'OUT');
    const errLogs = await readLastLines(LOG_FILE_ERR, linesToFetch, 'ERR');

    await sendTelegramMessage(chatId, formatMessage(
        `OUT Logs (Last ${linesToFetch} lines)`,
        outLogs || 'No OUT log entries found.',
        'info'
    ));

    await sendTelegramMessage(chatId, formatMessage(
        `ERR Logs (Last ${linesToFetch} lines)`,
        errLogs || 'No ERR log entries found.',
        'info'
    ));
});

// Обработчик команд управления приложением
const handleAppCommand = async (msg, command, actionName) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;

    const emoji = {
        'restart': EMOJI.RESTART,
        'stop': EMOJI.STOP,
        'start': EMOJI.START
    }[command];

    await sendTelegramMessage(chatId, formatMessage(
        `${actionName} Request`,
        `${emoji} Requesting ${actionName.toLowerCase()} for ${PM2_APP_NAME}...`,
        'info'
    ));

    pm2[command](PM2_APP_NAME, async (err) => {
        if (err) {
            await sendTelegramMessage(chatId, formatMessage(
                'Error',
                `Failed to ${actionName.toLowerCase()} ${PM2_APP_NAME}:\n${err.message}`,
                'error'
            ));
            return;
        }
        await sendTelegramMessage(chatId, formatMessage(
            'Success',
            `${emoji} ${PM2_APP_NAME} ${actionName.toLowerCase()} requested successfully!`,
            'success'
        ));
    });
};

// Регистрация команд
bot.onText(/\/restart_server_site/, (msg) => handleAppCommand(msg, 'restart', 'Restart'));
bot.onText(/\/stop_server_site/, (msg) => handleAppCommand(msg, 'stop', 'Stop'));
bot.onText(/\/start_server_site/, (msg) => handleAppCommand(msg, 'start', 'Start'));

// Проверка статуса приложения
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;

    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, formatMessage(
                'Error',
                `Failed to get PM2 status: ${err.message}`,
                'error'
            ));
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);
        if (!app) {
            await sendTelegramMessage(chatId, formatMessage(
                'Status',
                `${PM2_APP_NAME} not found in PM2`,
                'warning'
            ));
            return;
        }

        const uptime = app.pm2_env.pm_uptime 
            ? `${Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)} minutes` 
            : 'N/A';

        let statusMessage = `Status: ${app.pm2_env.status}\n`;
        statusMessage += `Uptime: ${uptime}\n`;
        statusMessage += `Restarts: ${app.pm2_env.restart_time}\n`;
        statusMessage += `Memory: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;
        statusMessage += `CPU: ${app.monit.cpu}%`;

        // Проверка порогов
        let alerts = '';
        if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
            alerts += `${EMOJI.ALERT} CPU usage (${app.monit.cpu}%) exceeds threshold (${CPU_THRESHOLD_PERCENT}%)\n`;
        }
        if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
            alerts += `${EMOJI.ALERT} Memory usage (${(app.monit.memory / 1024 / 1024).toFixed(2)} MB) exceeds threshold (${MEMORY_THRESHOLD_MB} MB)\n`;
        }

        if (alerts) {
            statusMessage += `\n\n${alerts}`;
        }

        await sendTelegramMessage(chatId, formatMessage(
            `${PM2_APP_NAME} Status`,
            statusMessage,
            alerts ? 'warning' : 'info'
        ));
    });
});

// Список всех приложений PM2
bot.onText(/\/list_all_apps/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;

    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, formatMessage(
                'Error',
                `Failed to list PM2 apps: ${err.message}`,
                'error'
            ));
            return;
        }

        if (list.length === 0) {
            await sendTelegramMessage(chatId, formatMessage(
                'PM2 Apps',
                'No applications running in PM2',
                'info'
            ));
            return;
        }

        let message = '';
        list.forEach(app => {
            const uptime = app.pm2_env.pm_uptime 
                ? `${Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)} min` 
                : 'N/A';
            
            message += `*${app.name}* (ID: ${app.pm_id})\n`;
            message += `Status: ${app.pm2_env.status}\n`;
            message += `Uptime: ${uptime}\n`;
            message += `Restarts: ${app.pm2_env.restart_time}\n`;
            message += `Memory: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;
            message += `CPU: ${app.monit.cpu}%\n\n`;
        });

        await sendTelegramMessage(chatId, formatMessage(
            'All PM2 Applications',
            message,
            'info'
        ));
    });
});

// Проверка здоровья системы
async function checkSystemHealth() {
    console.log('Performing system health check...');
    let healthMessage = '';
    let alertCount = 0;

    // Проверка дисков
    try {
        const drives = await getDrives();
        let diskInfo = '';
        
        drives.forEach(drive => {
            const usedPercent = (drive.used / drive.total * 100).toFixed(2);
            const freePercent = (drive.available / drive.total * 100).toFixed(2);
            const freeGB = (drive.available / (1024 ** 3)).toFixed(2);
            
            diskInfo += `*${drive.mounted}*\n`;
            diskInfo += `Total: ${(drive.total / (1024 ** 3)).toFixed(2)} GB\n`;
            diskInfo += `Used: ${usedPercent}%\n`;
            diskInfo += `Free: ${freeGB} GB (${freePercent}%)\n\n`;

            if (freePercent < DISK_SPACE_THRESHOLD_PERCENT) {
                healthMessage += `${EMOJI.ALERT} *Low disk space* on ${drive.mounted}: ${freePercent}% free (below ${DISK_SPACE_THRESHOLD_PERCENT}%)\n\n`;
                alertCount++;
            }
        });

        healthMessage += `${EMOJI.DISK} *Disk Information*\n${diskInfo}`;
    } catch (e) {
        healthMessage += `${EMOJI.ERROR} *Disk Check Error*: ${e.message}\n\n`;
        console.error('Disk check error:', e);
        alertCount++;
    }

    // Проверка PM2 приложения
    pm2.list(async (err, list) => {
        if (err) {
            healthMessage += `${EMOJI.ERROR} *PM2 Check Error*: ${err.message}\n`;
            console.error('PM2 check error:', err);
            alertCount++;
            await sendHealthMessage(healthMessage, alertCount);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);
        if (app) {
            healthMessage += `\n${EMOJI.SERVER} *${PM2_APP_NAME} Status*\n`;
            healthMessage += `CPU: ${app.monit.cpu}%\n`;
            healthMessage += `Memory: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\n`;

            if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
                healthMessage += `${EMOJI.ALERT} *High CPU*: ${app.monit.cpu}% (above ${CPU_THRESHOLD_PERCENT}%)\n`;
                alertCount++;
            }
            if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
                healthMessage += `${EMOJI.ALERT} *High Memory*: ${(app.monit.memory / 1024 / 1024).toFixed(2)} MB (above ${MEMORY_THRESHOLD_MB} MB)\n`;
                alertCount++;
            }
        } else {
            healthMessage += `\n${EMOJI.WARNING} ${PM2_APP_NAME} not found in PM2\n`;
        }

        await sendHealthMessage(healthMessage, alertCount);
    });

    async function sendHealthMessage(message, alerts) {
        const title = alerts > 0 
            ? `${EMOJI.ALERT} System Health Check (${alerts} alerts)` 
            : `${EMOJI.OK} System Health Check`;
        
        await sendTelegramMessage(
            CHAT_ID, 
            formatMessage(title, message, alerts > 0 ? 'warning' : 'success'),
            true
        );
    }
}

// Ручная проверка здоровья системы
bot.onText(/\/check_system_health/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;

    await sendTelegramMessage(chatId, formatMessage(
        'System Check',
        'Performing manual system health check...',
        'info'
    ));
    await checkSystemHealth();
});

// Периодическая проверка здоровья
setInterval(checkSystemHealth, CHECK_INTERVAL_MS);

// Мониторинг событий PM2
pm2.connect((err) => {
    if (err) {
        console.error('PM2 connection error:', err);
        sendTelegramMessage(CHAT_ID, formatMessage(
            'PM2 Connection Error',
            `Failed to connect to PM2: ${err.message}`,
            'critical'
        ));
        return;
    }

    pm2.launchBus((err, bus) => {
        if (err) {
            console.error('PM2 bus error:', err);
            sendTelegramMessage(CHAT_ID, formatMessage(
                'PM2 Bus Error',
                `Failed to launch PM2 event bus: ${err.message}`,
                'critical'
            ));
            return;
        }

        bus.on('process:event', (data) => {
            if (data.process.name === PM2_APP_NAME) {
                let message = '';
                let type = 'info';

                switch (data.event) {
                    case 'stop':
                        message = `${EMOJI.STOP} Application stopped!\nStatus: ${data.process.status}`;
                        type = 'error';
                        break;
                    case 'restart':
                        message = `${EMOJI.RESTART} Application restarted!\nStatus: ${data.process.status}`;
                        type = 'warning';
                        break;
                    case 'exit':
                        message = `${EMOJI.ERROR} Application crashed!\nStatus: ${data.process.status}`;
                        type = 'critical';
                        break;
                    case 'online':
                        message = `${EMOJI.SUCCESS} Application is running!\nStatus: ${data.process.status}`;
                        type = 'success';
                        break;
                    default:
                        message = `Unknown event: ${data.event}\nStatus: ${data.process.status}`;
                }

                sendTelegramMessage(CHAT_ID, formatMessage(
                    `PM2 Event: ${data.event}`,
                    message,
                    type
                ));
            }
        });
    });
});

// Обработка ошибок бота
bot.on('polling_error', (error) => {
    console.error('Bot polling error:', error.code, error.message);
});

console.log('PM2 Monitoring Bot is running...');