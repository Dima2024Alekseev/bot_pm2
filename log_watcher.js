const fs = require('fs');
const chokidar = require('chokidar');
require('dotenv').config();
const { sendTelegramMessage } = require('./telegram');

const LOG_FILE_OUT = process.env.LOG_FILE_OUT;
const LOG_FILE_ERR = process.env.LOG_FILE_ERR;
const CRITICAL_KEYWORDS = process.env.CRITICAL_KEYWORDS.split(',').map(kw => kw.trim().toLowerCase());
const WARNING_KEYWORDS = process.env.WARNING_KEYWORDS.split(',').map(kw => kw.trim().toLowerCase());
const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CHAT_ID = process.env.CHAT_ID;

let lastPositionOut = { value: 0 };
let lastPositionErr = { value: 0 };

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
            let unprocessedLines = '';

            stream.on('data', (chunk) => {
                const lines = (unprocessedLines + chunk).split('\n');
                unprocessedLines = lines.pop();

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    const alertType = checkLogForKeywords(line);
                    if (alertType) {
                        // Отправляем оповещение с MarkdownV2 для блока кода
                        sendTelegramMessage(CHAT_ID, `🚨 *${alertType}* (*${PM2_APP_NAME}*)\n\`\`\`\n${line}\n\`\`\``, true, { parse_mode: 'MarkdownV2' });
                    } else {
                        // Отправляем обычную новую строку лога с MarkdownV2 для блока кода
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - *${PM2_APP_NAME}* - NEW]\n\`\`\`\n${line}\n\`\`\``, true, { parse_mode: 'MarkdownV2' });
                    }
                }
            });

            stream.on('end', () => {
                if (unprocessedLines.trim() !== '') {
                    const alertType = checkLogForKeywords(unprocessedLines);
                    if (alertType) {
                        sendTelegramMessage(CHAT_ID, `🚨 *${alertType}* (*${PM2_APP_NAME}*)\n\`\`\`\n${unprocessedLines}\n\`\`\``, true, { parse_mode: 'MarkdownV2' });
                    } else {
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - *${PM2_APP_NAME}* - NEW]\n\`\`\`\n${unprocessedLines}\n\`\`\``, true, { parse_mode: 'MarkdownV2' });
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

function startLogWatcher() {
    initializeLogPositions();
    console.log(`Watching for logs from: ${LOG_FILE_OUT} and ${LOG_FILE_ERR}`);

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
}

function readLastLines(filePath, numLines, callback) {
    if (!fs.existsSync(filePath)) {
        // Здесь не используем MarkdownV2, чтобы сообщение было простым
        return callback(null, `Файл логов не найден: \`${filePath}\``);
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

module.exports = {
    startLogWatcher,
    readLastLines
};