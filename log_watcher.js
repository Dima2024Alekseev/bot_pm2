const fs = require('fs');
const chokidar = require('chokidar');
require('dotenv').config(); // Загружаем переменные окружения
const { sendTelegramMessage } = require('./telegram'); // Импортируем функцию для отправки сообщений

// Получаем необходимые переменные из process.env
const LOG_FILE_OUT = process.env.LOG_FILE_OUT;
const LOG_FILE_ERR = process.env.LOG_FILE_ERR;
// Ключевые слова для поиска, разбиваем строку из .env по запятой
const CRITICAL_KEYWORDS = process.env.CRITICAL_KEYWORDS.split(',').map(kw => kw.trim().toLowerCase());
const WARNING_KEYWORDS = process.env.WARNING_KEYWORDS.split(',').map(kw => kw.trim().toLowerCase());
const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CHAT_ID = process.env.CHAT_ID; // Chat ID для отправки уведомлений о новых логах

// Позиции последнего прочитанного байта для каждого лог-файла
let lastPositionOut = { value: 0 };
let lastPositionErr = { value: 0 };

/**
 * Проверяет строку лога на наличие критических или предупреждающих ключевых слов.
 * @param {string} logLine - Строка лога для проверки.
 * @returns {'CRITICAL' | 'WARNING' | null} - Тип оповещения или null, если совпадений нет.
 */
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

/**
 * Обрабатывает изменения в файле лога, читает новые строки и отправляет в Telegram.
 * @param {string} filePath - Путь к файлу лога.
 * @param {{value: number}} lastPositionRef - Ссылка на объект с последней прочитанной позицией.
 * @param {'out' | 'err'} type - Тип лога (stdout или stderr).
 */
function processLogFile(filePath, lastPositionRef, type) {
    fs.stat(filePath, (err, stats) => {
        if (err) {
            console.error(`Error stat-ing file ${filePath}:`, err.message);
            return;
        }

        const currentSize = stats.size;
        // Если файл был усечен (размер стал меньше предыдущего), начинаем чтение с начала
        if (currentSize < lastPositionRef.value) {
            console.log(`Log file ${filePath} was truncated. Reading from start.`);
            lastPositionRef.value = 0;
        }

        // Если есть новые данные
        if (currentSize > lastPositionRef.value) {
            // Создаем поток чтения с последней известной позиции
            const stream = fs.createReadStream(filePath, { start: lastPositionRef.value, encoding: 'utf8' });
            let unprocessedLines = ''; // Буфер для неполных строк

            stream.on('data', (chunk) => {
                const lines = (unprocessedLines + chunk).split('\n');
                unprocessedLines = lines.pop(); // Последняя строка может быть неполной, сохраняем ее

                for (const line of lines) {
                    if (line.trim() === '') continue; // Пропускаем пустые строки

                    const alertType = checkLogForKeywords(line);
                    if (alertType) {
                        // Отправляем оповещение, если найдено ключевое слово
                        sendTelegramMessage(CHAT_ID, `🚨 *${alertType}* (*${PM2_APP_NAME}*)\n\`\`\`\n${line}\n\`\`\``);
                    } else {
                        // Отправляем обычную новую строку лога
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - *${PM2_APP_NAME}* - NEW]\n\`\`\`\n${line}\n\`\`\``);
                    }
                }
            });

            stream.on('end', () => {
                // Обрабатываем оставшиеся неполные строки после завершения чтения
                if (unprocessedLines.trim() !== '') {
                    const alertType = checkLogForKeywords(unprocessedLines);
                    if (alertType) {
                        sendTelegramMessage(CHAT_ID, `🚨 *${alertType}* (*${PM2_APP_NAME}*)\n\`\`\`\n${unprocessedLines}\n\`\`\``);
                    } else {
                        sendTelegramMessage(CHAT_ID, `[${type.toUpperCase()} - *${PM2_APP_NAME}* - NEW]\n\`\`\`\n${unprocessedLines}\n\`\`\``);
                    }
                }
                lastPositionRef.value = currentSize; // Обновляем последнюю прочитанную позицию
            });

            stream.on('error', (readErr) => {
                console.error(`Error reading from file ${filePath}:`, readErr.message);
            });
        }
    });
}

/**
 * Инициализирует начальные позиции чтения для файлов логов.
 * Если файл существует, устанавливает позицию в конец файла, чтобы не читать старые логи при запуске.
 */
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

/**
 * Запускает отслеживание файлов логов с помощью chokidar.
 */
function startLogWatcher() {
    initializeLogPositions(); // Инициализируем позиции при запуске
    console.log(`Watching for logs from: ${LOG_FILE_OUT} and ${LOG_FILE_ERR}`);

    const watcher = chokidar.watch([LOG_FILE_OUT, LOG_FILE_ERR], {
        persistent: true, // Продолжать наблюдение даже после завершения программы (для демона)
        ignoreInitial: true, // Игнорировать события 'add'/'change' при первом запуске (чтобы не читать все старые логи)
        awaitWriteFinish: { // Ожидать завершения записи в файл, прежде чем обрабатывать его
            stabilityThreshold: 2000, // Задержка в мс перед тем, как считать файл "стабильным"
            pollInterval: 100 // Интервал опроса для стабильности
        }
    });

    watcher
        .on('add', (filePath) => {
            console.log(`File ${filePath} has been added`);
            // Если файл добавлен, сбрасываем позицию, чтобы начать чтение с начала
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

/**
 * Читает последние N строк из указанного файла логов.
 * @param {string} filePath - Путь к файлу логов.
 * @param {number} numLines - Количество строк для чтения.
 * @param {function(Error|null, string|null): void} callback - Callback-функция, вызываемая после чтения.
 */
function readLastLines(filePath, numLines, callback) {
    if (!fs.existsSync(filePath)) {
        return callback(null, `Файл логов не найден: \`${filePath}\``);
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading file ${filePath}:`, err.message);
            return callback(err);
        }
        const lines = data.split('\n').filter(line => line.trim() !== ''); // Разделяем на строки и убираем пустые
        const lastLines = lines.slice(-numLines); // Берем последние N строк
        callback(null, lastLines.join('\n'));
    });
}

// Экспортируем функции для использования в index.js
module.exports = {
    startLogWatcher,
    readLastLines
};