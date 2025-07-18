const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');
const pm2 = require('pm2');
const { getDrives } = require('node-disk-info');
const os = require('os');
const moment = require('moment');
require('moment-duration-format');

// ============== КОНФИГУРАЦИЯ ==============
const CONFIG = {
    BOT_TOKEN: '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds',
    CHAT_ID: '1364079703',
    PM2_APP_NAME: 'server-site',
    
    // Пороги для оповещений
    THRESHOLDS: {
        DISK_SPACE_PERCENT: 15,
        CPU_PERCENT: 80,
        MEMORY_MB: 500,
        TEMPERATURE: 70 // Для CPU температуры (если доступно)
    },
    
    // Интервалы проверки (в миллисекундах)
    INTERVALS: {
        SYSTEM_CHECK: 5 * 60 * 1000, // 5 минут
        STATUS_UPDATE: 60 * 60 * 1000 // 1 час
    },
    
    // Пути к логам
    LOG_PATHS: {
        OUT: '/root/.pm2/logs/server-site-out.log',
        ERR: '/root/.pm2/logs/server-site-error.log'
    },
    
    // Ключевые слова для мониторинга логов
    KEYWORDS: {
        CRITICAL: ['error', 'fatal', 'critical', 'exception', 'failed', 'timeout', 'denied', 'unauthorized', 'segfault'],
        WARNING: ['warn', 'warning', 'deprecated', 'unstable', 'notice']
    },
    
    // Смайлы для статусов
    EMOJIS: {
        ONLINE: '🟢',
        OFFLINE: '🔴',
        RESTART: '🟡',
        WARNING: '⚠️',
        CRITICAL: '🚨',
        INFO: 'ℹ️',
        DISK: '💾',
        MEMORY: '🧠',
        CPU: '⚡',
        TEMP: '🌡️',
        NETWORK: '🌐'
    }
};

// ============== ИНИЦИАЛИЗАЦИЯ ==============
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
let lastLogPositions = { OUT: 0, ERR: 0 };

// ============== УТИЛИТЫ ==============
class Logger {
    static log(message, type = 'INFO') {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${type}] ${message}`);
    }
    
    static error(message) {
        this.log(message, 'ERROR');
    }
    
    static warn(message) {
        this.log(message, 'WARN');
    }
}

class FormatUtils {
    static bytesToGB(bytes) {
        return (bytes / (1024 ** 3)).toFixed(2);
    }
    
    static bytesToMB(bytes) {
        return (bytes / (1024 ** 2)).toFixed(2);
    }
    
    static formatUptime(ms) {
        return moment.duration(ms).format("d [дней], h [часов], m [мин]");
    }
    
    static escapeMarkdown(text) {
        return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
    }
    
    static formatProcessStatus(status) {
        const statusMap = {
            'online': `${CONFIG.EMOJIS.ONLINE} Работает`,
            'stopped': `${CONFIG.EMOJIS.OFFLINE} Остановлен`,
            'restarting': `${CONFIG.EMOJIS.RESTART} Перезапускается`,
            'errored': `${CONFIG.EMOJIS.CRITICAL} Ошибка`,
            'launching': `${CONFIG.EMOJIS.INFO} Запускается`
        };
        return statusMap[status] || status;
    }
}

// ============== ОСНОВНЫЕ ФУНКЦИИ ==============
class TelegramService {
    static async sendMessage(chatId, text, options = {}) {
        if (!text.trim() && !options.force) return;
        
        try {
            const messageOptions = {
                parse_mode: 'MarkdownV2',
                disable_web_page_preview: true,
                ...options
            };
            
            // Разбиваем длинные сообщения
            const MAX_LENGTH = 4000;
            if (text.length > MAX_LENGTH) {
                const parts = [];
                let remaining = text;
                
                while (remaining.length > 0) {
                    const part = remaining.substring(0, MAX_LENGTH);
                    const lastNewline = part.lastIndexOf('\n');
                    
                    if (lastNewline > 0 && remaining.length > MAX_LENGTH) {
                        parts.push(part.substring(0, lastNewline));
                        remaining = remaining.substring(lastNewline + 1);
                    } else {
                        parts.push(part);
                        remaining = remaining.substring(MAX_LENGTH);
                    }
                }
                
                for (const part of parts) {
                    await bot.sendMessage(chatId, part, messageOptions);
                    await new Promise(resolve => setTimeout(resolve, 300)); // Задержка между сообщениями
                }
            } else {
                await bot.sendMessage(chatId, text, messageOptions);
            }
        } catch (error) {
            Logger.error(`Ошибка отправки сообщения: ${error.message}`);
            // Попытка отправить без Markdown
            try {
                await bot.sendMessage(chatId, FormatUtils.escapeMarkdown(text));
            } catch (fallbackError) {
                Logger.error(`Ошибка при повторной отправке: ${fallbackError.message}`);
            }
        }
    }
    
    static async sendFormattedMessage(chatId, title, content, options = {}) {
        const formattedText = `*${title}*\n\n${content}`;
        return this.sendMessage(chatId, formattedText, options);
    }
}

class LogMonitor {
    static initialize() {
        Logger.log('Инициализация мониторинга логов...');
        
        // Инициализация позиций логов
        this.initLogPositions();
        
        // Настройка watcher
        const watcher = chokidar.watch(Object.values(CONFIG.LOG_PATHS), {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });
        
        watcher
            .on('add', filePath => this.handleLogChange(filePath))
            .on('change', filePath => this.handleLogChange(filePath))
            .on('error', error => Logger.error(`Ошибка watcher: ${error.message}`));
    }
    
    static initLogPositions() {
        Object.entries(CONFIG.LOG_PATHS).forEach(([type, path]) => {
            if (fs.existsSync(path)) {
                lastLogPositions[type] = fs.statSync(path).size;
                Logger.log(`Инициализирована позиция для ${type} лога: ${lastLogPositions[type]}`);
            } else {
                Logger.warn(`Файл лога не найден: ${path}`);
            }
        });
    }
    
    static handleLogChange(filePath) {
        const logType = filePath === CONFIG.LOG_PATHS.OUT ? 'OUT' : 'ERR';
        const stats = fs.statSync(filePath);
        
        if (stats.size < lastLogPositions[logType]) {
            Logger.log(`Лог файл ${logType} был обрезан, сбрасываем позицию`);
            lastLogPositions[logType] = 0;
        }
        
        if (stats.size > lastLogPositions[logType]) {
            this.processNewLogs(filePath, logType, stats.size);
        }
    }
    
    static processNewLogs(filePath, logType, newSize) {
        const stream = fs.createReadStream(filePath, {
            start: lastLogPositions[logType],
            encoding: 'utf8'
        });
        
        let buffer = '';
        
        stream.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            lines.forEach(line => {
                if (line.trim()) {
                    this.analyzeLogLine(line, logType);
                }
            });
        });
        
        stream.on('end', () => {
            if (buffer.trim()) {
                this.analyzeLogLine(buffer, logType);
            }
            lastLogPositions[logType] = newSize;
        });
        
        stream.on('error', error => {
            Logger.error(`Ошибка чтения лога ${logType}: ${error.message}`);
        });
    }
    
    static analyzeLogLine(line, logType) {
        const lowerLine = line.toLowerCase();
        const isCritical = CONFIG.KEYWORDS.CRITICAL.some(kw => lowerLine.includes(kw));
        const isWarning = CONFIG.KEYWORDS.WARNING.some(kw => lowerLine.includes(kw));
        
        if (isCritical) {
            this.sendLogAlert(line, 'CRITICAL', logType);
        } else if (isWarning) {
            this.sendLogAlert(line, 'WARNING', logType);
        }
    }
    
    static sendLogAlert(line, severity, logType) {
        const emoji = severity === 'CRITICAL' ? CONFIG.EMOJIS.CRITICAL : CONFIG.EMOJIS.WARNING;
        const message = `${emoji} *${severity}* (${CONFIG.PM2_APP_NAME}, ${logType}):\n\`\`\`\n${line}\n\`\`\``;
        TelegramService.sendMessage(CONFIG.CHAT_ID, message);
    }
    
    static getLogs(logType, linesCount = 20) {
        return new Promise((resolve, reject) => {
            const filePath = CONFIG.LOG_PATHS[logType];
            
            if (!fs.existsSync(filePath)) {
                return reject(`Файл лога ${logType} не найден`);
            }
            
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) return reject(err);
                
                const lines = data.split('\n')
                    .filter(line => line.trim())
                    .slice(-linesCount);
                
                resolve(lines.join('\n'));
            });
        });
    }
}

class SystemMonitor {
    static async checkSystemHealth() {
        Logger.log('Проверка состояния системы...');
        
        try {
            const [diskInfo, pm2Info, systemInfo] = await Promise.all([
                this.getDiskInfo(),
                this.getPm2Info(),
                this.getSystemInfo()
            ]);
            
            let message = '*🛠️ Состояние системы*\n\n';
            let hasProblems = false;
            
            // Диски
            message += `*${CONFIG.EMOJIS.DISK} Дисковое пространство:*\n`;
            diskInfo.forEach(disk => {
                const freePercent = (disk.free / disk.total * 100).toFixed(1);
                message += `▸ *${disk.mount}*: ${freePercent}% свободно (${FormatUtils.bytesToGB(disk.free)}/${FormatUtils.bytesToGB(disk.total)} GB)\n`;
                
                if (freePercent < CONFIG.THRESHOLDS.DISK_SPACE_PERCENT) {
                    message += `   ${CONFIG.EMOJIS.WARNING} *Мало свободного места!*\n`;
                    hasProblems = true;
                }
            });
            
            // PM2 процесс
            message += `\n*🚀 ${CONFIG.PM2_APP_NAME} статус:*\n`;
            if (pm2Info) {
                message += `▸ Состояние: ${FormatUtils.formatProcessStatus(pm2Info.status)}\n`;
                message += `▸ Uptime: ${FormatUtils.formatUptime(Date.now() - pm2Info.pm_uptime)}\n`;
                message += `▸ Перезапусков: ${pm2Info.restart_time}\n`;
                message += `▸ ${CONFIG.EMOJIS.CPU} CPU: ${pm2Info.cpu}%\n`;
                message += `▸ ${CONFIG.EMOJIS.MEMORY} Память: ${FormatUtils.bytesToMB(pm2Info.memory)} MB\n`;
                
                if (pm2Info.cpu > CONFIG.THRESHOLDS.CPU_PERCENT) {
                    message += `   ${CONFIG.EMOJIS.WARNING} *Высокая нагрузка CPU!*\n`;
                    hasProblems = true;
                }
                
                if (pm2Info.memory / (1024 ** 2) > CONFIG.THRESHOLDS.MEMORY_MB) {
                    message += `   ${CONFIG.EMOJIS.WARNING} *Высокое потребление памяти!*\n`;
                    hasProblems = true;
                }
            } else {
                message += `${CONFIG.EMOJIS.OFFLINE} Процесс не найден\n`;
                hasProblems = true;
            }
            
            // Системная информация
            message += `\n*${CONFIG.EMOJIS.INFO} Система:*\n`;
            message += `▸ ${CONFIG.EMOJIS.CPU} Загрузка CPU: ${systemInfo.cpuLoad}%\n`;
            message += `▸ ${CONFIG.EMOJIS.MEMORY} Свободно RAM: ${FormatUtils.bytesToMB(systemInfo.freeMem)}/${FormatUtils.bytesToMB(systemInfo.totalMem)} MB\n`;
            message += `▸ ${CONFIG.EMOJIS.NETWORK} Время работы: ${FormatUtils.formatUptime(systemInfo.uptime * 1000)}\n`;
            
            if (systemInfo.temperature && systemInfo.temperature > CONFIG.THRESHOLDS.TEMPERATURE) {
                message += `   ${CONFIG.EMOJIS.WARNING} *Высокая температура CPU: ${systemInfo.temperature}°C!*\n`;
                hasProblems = true;
            }
            
            // Отправляем только если есть проблемы или это ручная проверка
            return { message, hasProblems };
        } catch (error) {
            Logger.error(`Ошибка проверки системы: ${error.message}`);
            return {
                message: `${CONFIG.EMOJIS.CRITICAL} *Ошибка проверки системы:*\n\n${error.message}`,
                hasProblems: true
            };
        }
    }
    
    static async getDiskInfo() {
        try {
            const drives = await getDrives();
            return drives.map(drive => ({
                mount: drive.mounted,
                total: drive.total,
                free: drive.available,
                used: drive.used
            }));
        } catch (error) {
            Logger.error(`Ошибка получения информации о дисках: ${error.message}`);
            throw new Error('Не удалось получить информацию о дисках');
        }
    }
    
    static async getPm2Info() {
        return new Promise((resolve, reject) => {
            pm2.list((err, list) => {
                if (err) return reject(err);
                
                const app = list.find(p => p.name === CONFIG.PM2_APP_NAME);
                if (!app) return resolve(null);
                
                resolve({
                    status: app.pm2_env.status,
                    pm_uptime: app.pm2_env.pm_uptime,
                    restart_time: app.pm2_env.restart_time,
                    cpu: app.monit.cpu,
                    memory: app.monit.memory
                });
            });
        });
    }
    
    static async getSystemInfo() {
        const cpuLoad = os.loadavg()[0] * 100 / os.cpus().length;
        const freeMem = os.freemem();
        const totalMem = os.totalmem();
        const uptime = os.uptime();
        
        // Попытка получить температуру CPU (Linux)
        let temperature = null;
        try {
            if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
                const tempData = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
                temperature = parseInt(tempData, 10) / 1000;
            }
        } catch (error) {
            Logger.error(`Ошибка чтения температуры CPU: ${error.message}`);
        }
        
        return {
            cpuLoad: cpuLoad.toFixed(1),
            freeMem,
            totalMem,
            uptime,
            temperature
        };
    }
}

class Pm2Manager {
    static connect() {
        return new Promise((resolve, reject) => {
            pm2.connect(err => {
                if (err) return reject(err);
                Logger.log('Подключено к PM2');
                resolve();
            });
        });
    }
    
    static setupEventBus() {
        pm2.launchBus((err, bus) => {
            if (err) {
                Logger.error(`Ошибка запуска PM2 bus: ${err.message}`);
                return;
            }
            
            bus.on('process:event', data => {
                if (data.process.name === CONFIG.PM2_APP_NAME) {
                    this.handlePm2Event(data.event, data.process);
                }
            });
        });
    }
    
    static handlePm2Event(event, process) {
        const eventMessages = {
            'stop': `${CONFIG.EMOJIS.OFFLINE} *Приложение остановлено!*`,
            'restart': `${CONFIG.EMOJIS.RESTART} *Приложение перезапущено!*`,
            'exit': `${CONFIG.EMOJIS.CRITICAL} *Приложение завершилось с ошибкой!*`,
            'online': `${CONFIG.EMOJIS.ONLINE} *Приложение запущено и работает!*`,
            'error': `${CONFIG.EMOJIS.CRITICAL} *Ошибка в приложении!*`
        };
        
        const message = eventMessages[event] || `${CONFIG.EMOJIS.INFO} Неизвестное событие: ${event}`;
        TelegramService.sendFormattedMessage(
            CONFIG.CHAT_ID,
            `PM2 Уведомление (${CONFIG.PM2_APP_NAME})`,
            `${message}\n\nСостояние: ${FormatUtils.formatProcessStatus(process.status)}`
        );
    }
    
    static async listProcesses() {
        return new Promise((resolve, reject) => {
            pm2.list((err, list) => {
                if (err) return reject(err);
                resolve(list);
            });
        });
    }
    
    static async controlProcess(action) {
        const actions = {
            'start': pm2.start,
            'stop': pm2.stop,
            'restart': pm2.restart,
            'delete': pm2.delete
        };
        
        if (!actions[action]) {
            throw new Error(`Неизвестное действие: ${action}`);
        }
        
        return new Promise((resolve, reject) => {
            actions[action](CONFIG.PM2_APP_NAME, (err, proc) => {
                if (err) return reject(err);
                resolve(proc);
            });
        });
    }
}

// ============== КОМАНДЫ БОТА ==============
class BotCommands {
    static initialize() {
        // Основные команды
        bot.onText(/\/start/, this.handleStart);
        bot.onText(/\/help/, this.handleHelp);
        bot.onText(/\/status/, this.handleStatus);
        bot.onText(/\/logs/, this.handleLogs);
        bot.onText(/\/health/, this.handleHealth);
        bot.onText(/\/list/, this.handleList);
        
        // Управление процессом
        bot.onText(/\/start_process/, this.handleStartProcess);
        bot.onText(/\/stop_process/, this.handleStopProcess);
        bot.onText(/\/restart_process/, this.handleRestartProcess);
        
        Logger.log('Команды бота инициализированы');
    }
    
    static handleStart(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        const welcomeMessage = `👋 *Привет! Я бот-монитор для ${CONFIG.PM2_APP_NAME}*\n\n` +
            `Я могу:\n` +
            `▸ Отправлять логи и уведомления о проблемах\n` +
            `▸ Показывать статус приложения и системы\n` +
            `▸ Управлять вашим PM2 процессом\n\n` +
            `Используйте /help для списка команд`;
        
        TelegramService.sendFormattedMessage(chatId, 'Добро пожаловать!', welcomeMessage);
    }
    
    static handleHelp(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        const helpMessage = `📋 *Доступные команды:*\n\n` +
            `*Основные:*\n` +
            `▸ /status - Текущий статус приложения\n` +
            `▸ /logs [N] - Последние N строк логов (по умолчанию 20)\n` +
            `▸ /health - Проверка состояния системы\n` +
            `▸ /list - Список всех PM2 процессов\n\n` +
            `*Управление:*\n` +
            `▸ /start_process - Запустить приложение\n` +
            `▸ /stop_process - Остановить приложение\n` +
            `▸ /restart_process - Перезапустить приложение\n\n` +
            `*Настройки:*\n` +
            `▸ /thresholds - Показать текущие пороги оповещений\n` +
            `▸ /set_threshold [тип] [значение] - Изменить порог`;
        
        TelegramService.sendFormattedMessage(chatId, 'Помощь', helpMessage);
    }
    
    static async handleStatus(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        try {
            const { message } = await SystemMonitor.checkSystemHealth();
            TelegramService.sendMessage(chatId, message);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка получения статуса: ${error.message}`);
        }
    }
    
    static async handleLogs(msg, match) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        const linesCount = match[1] ? parseInt(match[1]) : 20;
        
        if (isNaN(linesCount)) {
            return TelegramService.sendMessage(chatId, 'Пожалуйста, укажите число строк (например: /logs 50)');
        }
        
        try {
            const [outLogs, errLogs] = await Promise.all([
                LogMonitor.getLogs('OUT', linesCount),
                LogMonitor.getLogs('ERR', linesCount)
            ]);
            
            let response = `📜 *Последние ${linesCount} строк логов*\n\n`;
            response += `*OUT logs:*\n\`\`\`\n${outLogs || 'Нет данных'}\n\`\`\`\n\n`;
            response += `*ERR logs:*\n\`\`\`\n${errLogs || 'Нет данных'}\n\`\`\``;
            
            TelegramService.sendMessage(chatId, response);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка получения логов: ${error.message}`);
        }
    }
    
    static async handleHealth(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        try {
            const { message } = await SystemMonitor.checkSystemHealth();
            TelegramService.sendMessage(chatId, message);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка проверки системы: ${error.message}`);
        }
    }
    
    static async handleList(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        try {
            const processes = await Pm2Manager.listProcesses();
            
            if (processes.length === 0) {
                return TelegramService.sendMessage(chatId, 'Нет запущенных PM2 процессов');
            }
            
            let message = '📋 *Список PM2 процессов*\n\n';
            
            processes.forEach(proc => {
                const isMainApp = proc.name === CONFIG.PM2_APP_NAME;
                const prefix = isMainApp ? '⭐ ' : '▸ ';
                
                message += `${prefix}*${proc.name}* (ID: ${proc.pm_id})\n`;
                message += `   Статус: ${FormatUtils.formatProcessStatus(proc.pm2_env.status)}\n`;
                message += `   CPU: ${proc.monit.cpu}% | Память: ${FormatUtils.bytesToMB(proc.monit.memory)} MB\n`;
                message += `   Uptime: ${FormatUtils.formatUptime(Date.now() - proc.pm2_env.pm_uptime)}\n`;
                message += `   Перезапусков: ${proc.pm2_env.restart_time}\n\n`;
            });
            
            TelegramService.sendMessage(chatId, message);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка получения списка процессов: ${error.message}`);
        }
    }
    
    static async handleStartProcess(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        try {
            await TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.INFO} Запускаю процесс...`);
            await Pm2Manager.controlProcess('start');
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.ONLINE} Процесс успешно запущен`);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка запуска: ${error.message}`);
        }
    }
    
    static async handleStopProcess(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        try {
            await TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.INFO} Останавливаю процесс...`);
            await Pm2Manager.controlProcess('stop');
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.OFFLINE} Процесс успешно остановлен`);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка остановки: ${error.message}`);
        }
    }
    
    static async handleRestartProcess(msg) {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(CONFIG.CHAT_ID)) return;
        
        try {
            await TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.INFO} Перезапускаю процесс...`);
            await Pm2Manager.controlProcess('restart');
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.RESTART} Процесс успешно перезапущен`);
        } catch (error) {
            TelegramService.sendMessage(chatId, `${CONFIG.EMOJIS.CRITICAL} Ошибка перезапуска: ${error.message}`);
        }
    }
}

// ============== ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ ==============
async function initializeApp() {
    try {
        // Подключаемся к PM2
        await Pm2Manager.connect();
        Pm2Manager.setupEventBus();
        
        // Инициализируем мониторинг логов
        LogMonitor.initialize();
        
        // Регистрируем команды бота
        BotCommands.initialize();
        
        // Запускаем периодическую проверку системы
        setInterval(async () => {
            try {
                const { message, hasProblems } = await SystemMonitor.checkSystemHealth();
                if (hasProblems) {
                    await TelegramService.sendMessage(CONFIG.CHAT_ID, message);
                }
            } catch (error) {
                Logger.error(`Ошибка периодической проверки: ${error.message}`);
            }
        }, CONFIG.INTERVALS.SYSTEM_CHECK);
        
        Logger.log('Бот успешно инициализирован и готов к работе');
        TelegramService.sendMessage(CONFIG.CHAT_ID, `${CONFIG.EMOJIS.ONLINE} *Бот мониторинга запущен!*\n\nСистема готова к работе`);
    } catch (error) {
        Logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
}

// Запуск приложения
initializeApp();

// Обработка ошибок бота
bot.on('polling_error', error => {
    Logger.error(`Ошибка polling: ${error.code} - ${error.message}`);
});

// Обработка завершения процесса
process.on('SIGINT', () => {
    Logger.log('Завершение работы...');
    pm2.disconnect();
    bot.stopPolling();
    process.exit();
});