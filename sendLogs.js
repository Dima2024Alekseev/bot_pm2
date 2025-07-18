const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api'); // Новая зависимость

// *** НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ ***
const BOT_TOKEN = '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds'; // Ваш токен бота
const CHAT_ID = '1364079703';     // Ваш Chat ID (может быть числом или строкой)
const PM2_APP_NAME = 'server-site'; // Имя вашего PM2-приложения
// ******************************

// ПУТИ К ФАЙЛАМ ЛОГОВ PM2 - ВЗЯТЫ ИЗ ВАШЕГО ВЫВОДА `pm2 show`
const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

// Инициализация Telegram бота
// 'polling' позволяет боту получать обновления
const bot = new TelegramBot(BOT_TOKEN, {polling: true});

// Функция для отправки сообщений в Telegram (используется ботом)
async function sendTelegramMessage(chatId, text) {
    if (!text.trim()) {
        return;
    }
    // Telegram имеет лимит на длину сообщения (4096 символов).
    // Разбиваем длинные сообщения на части, если необходимо.
    const MAX_MESSAGE_LENGTH = 4000;
    let parts = [];
    while (text.length > 0) {
        let part = text.substring(0, MAX_MESSAGE_LENGTH);
        let lastNewline = part.lastIndexOf('\n');
        // Если часть обрывается не на конце строки и не является всей оставшейся строкой,
        // то обрезаем до последней новой строки, чтобы не ломать строки логов
        if (lastNewline !== -1 && lastNewline !== part.length -1 && text.length > MAX_MESSAGE_LENGTH) {
            part = part.substring(0, lastNewline);
            text = text.substring(lastNewline + 1);
        } else {
            text = text.substring(MAX_MESSAGE_LENGTH);
        }
        parts.push(part);
    }

    for (const part of parts) {
        try {
            await bot.sendMessage(chatId, `\`\`\`\n${part}\n\`\`\``, {parse_mode: 'MarkdownV2'});
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
            // Если ошибка связана с форматированием (например, MarkdownV2), попробуйте без него
            try {
                await bot.sendMessage(chatId, part);
                console.log('Message part sent without MarkdownV2 due to error.');
            } catch (fallbackError) {
                console.error('Fallback send failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
            }
        }
    }
}

// --- Функционал отслеживания новых логов в реальном времени ---

let lastReadOutPosition = 0;
let lastReadErrPosition = 0;

console.log(`Watching for logs from: ${LOG_FILE_OUT} and ${LOG_FILE_ERR}`);

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

            stream.on('data', (chunk) => {
                buffer += chunk;
            });

            stream.on('end', () => {
                if (buffer) {
                    sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - ${PM2_APP_NAME} - NEW]\n${buffer}`);
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

// Функция для чтения последних N строк из файла
function readLastLines(filePath, numLines, callback) {
    if (!fs.existsSync(filePath)) {
        return callback(null, `Файл логов не найден: ${filePath}`);
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading file ${filePath}:`, err.message);
            return callback(err);
        }
        const lines = data.split('\n').filter(line => line.trim() !== ''); // Отфильтровываем пустые строки
        const lastLines = lines.slice(-numLines);
        callback(null, lastLines.join('\n'));
    });
}

// Обработка команды /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    // Проверяем, что это наш разрешенный Chat ID
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    bot.sendMessage(chatId, 'Привет! Я бот для логов PM2. Используйте /logs <количество_строк> для получения последних логов. Например: /logs 20');
});

// Обработка команды /logs
bot.onText(/\/logs(?:@\w+)?(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    // Проверяем, что это наш разрешенный Chat ID
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    const linesToFetch = match[1] ? parseInt(match[1], 10) : 20; // По умолчанию 20 строк

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)');
        return;
    }

    await sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для ${PM2_APP_NAME}...`);

    // Отправляем логи OUT
    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении OUT логов: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `[OUT - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${outLogs || 'Нет записей в OUT логе.'}`);
    });

    // Отправляем логи ERR
    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении ERR логов: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `[ERR - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${errLogs || 'Нет записей в ERR логе.'}`);
    });
});


console.log('PM2 Log Telegram Bot is running and listening for commands...');