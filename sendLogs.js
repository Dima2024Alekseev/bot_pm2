const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// *** НАСТРОЙТЕ ЭТИ ПЕРЕМЕННЫЕ ***
const BOT_TOKEN = '8127032296:AAH7Vxg7v5I_6M94oZbidNvtyPEAFQVEPds'; // Ваш токен бота
const CHAT_ID = '1364079703';     // Ваш Chat ID
const PM2_APP_NAME = 'server-site'; // Имя вашего PM2-приложения
// ******************************

// ПУТИ К ФАЙЛАМ ЛОГОВ PM2 - ВЗЯТЫ ИЗ ВАШЕГО ВЫВОДА `pm2 show`
const LOG_FILE_OUT = '/root/.pm2/logs/server-site-out.log';
const LOG_FILE_ERR = '/root/.pm2/logs/server-site-error.log';

const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

let lastReadOutPosition = 0;
let lastReadErrPosition = 0;

console.log(`Watching for logs from: ${LOG_FILE_OUT} and ${LOG_FILE_ERR}`);

async function sendTelegramMessage(text) {
    if (!text.trim()) {
        return; // Не отправляем пустые сообщения
    }
    try {
        await axios.post(TELEGRAM_API_URL, {
            chat_id: CHAT_ID,
            text: `\`\`\`\n${text.substring(0, 4000)}\n\`\`\``, // Ограничиваем до 4000 символов, т.к. Telegram имеет лимит
            parse_mode: 'MarkdownV2' // Используем Markdown для форматирования, чтобы лог выглядел лучше
        });
        console.log('Message sent to Telegram.');
    } catch (error) {
        console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
    }
}

function processLogFile(filePath, lastPositionRef, type) {
    fs.stat(filePath, (err, stats) => {
        if (err) {
            console.error(`Error stat-ing file ${filePath}:`, err.message);
            return;
        }

        const currentSize = stats.size;
        if (currentSize < lastPositionRef.value) {
            // Файл был усечен (например, при ротации логов). Начинаем чтение с начала.
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
                    sendTelegramMessage(`[${type.toUpperCase()} - ${PM2_APP_NAME}]\n${buffer}`);
                }
                lastPositionRef.value = currentSize; // Обновляем позицию
            });

            stream.on('error', (readErr) => {
                console.error(`Error reading from file ${filePath}:`, readErr.message);
            });
        }
    });
}

// Используем объект для хранения изменяемых значений позиции
const lastPositionOut = { value: 0 };
const lastPositionErr = { value: 0 };

// Инициализация позиций при первом запуске
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

// Наблюдаем за файлами логов с помощью chokidar
const watcher = chokidar.watch([LOG_FILE_OUT, LOG_FILE_ERR], {
    persistent: true,
    ignoreInitial: true, // Не обрабатывать файлы при первом запуске, только изменения
    awaitWriteFinish: {
        stabilityThreshold: 2000, // Подождать 2 секунды, чтобы убедиться, что файл закончил запись
        pollInterval: 100
    }
});

watcher
    .on('add', (filePath) => {
        console.log(`File ${filePath} has been added`);
        // При добавлении нового файла (например, после ротации), сбрасываем позицию
        if (filePath === LOG_FILE_OUT) lastPositionOut.value = 0;
        if (filePath === LOG_FILE_ERR) lastPositionErr.value = 0;
        processLogFile(filePath, filePath === LOG_FILE_OUT ? lastPositionOut : lastPositionErr, filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('change', (filePath) => {
        console.log(`File ${filePath} has been changed`);
        processLogFile(filePath, filePath === LOG_FILE_OUT ? lastPositionOut : lastPositionErr, filePath === LOG_FILE_OUT ? 'out' : 'err');
    })
    .on('error', (error) => console.error(`Watcher error: ${error}`));

console.log('PM2 Log Telegram Bot is running...');