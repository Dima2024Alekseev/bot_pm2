// pm2_monitor.js
const pm2 = require('pm2');
require('dotenv').config(); // Загружаем переменные окружения
const { sendTelegramMessage } = require('./telegram'); // Импортируем функцию для отправки сообщений в Telegram

// Получаем необходимые переменные из process.env
const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CPU_THRESHOLD_PERCENT = parseInt(process.env.CPU_THRESHOLD_PERCENT, 10);
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB, 10);
const CHAT_ID = process.env.CHAT_ID; // Chat ID для отправки уведомлений о событиях PM2

/**
 * Проверяет статус конкретного PM2 приложения и отправляет его в Telegram.
 * @param {string} chatId - ID чата для отправки сообщения.
 */
async function checkPm2AppStatus(chatId) {
    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, `🔴 Ошибка при получении статуса PM2: ${err.message}`);
            console.error('Error listing PM2 processes for status check:', err.message);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME); // Находим наше приложение по имени

        if (app) {
            let statusMessage = `📊 Статус *${PM2_APP_NAME}*:\n`;
            statusMessage += `   Статус: \`${app.pm2_env.status}\`\n`;
            // Рассчитываем uptime в минутах
            statusMessage += `   Uptime: ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            statusMessage += `   Перезапусков: \`${app.pm2_env.restart_time}\`\n`;
            statusMessage += `   Память: \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;
            statusMessage += `   CPU: \`${app.monit.cpu}%\`\n`;

            // Добавляем предупреждения, если пороги превышены
            if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
                statusMessage += `   ⚠️ *Внимание:* CPU (\`${app.monit.cpu}%\`) выше порога ${CPU_THRESHOLD_PERCENT}%\n`;
            }
            if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
                statusMessage += `   ⚠️ *Внимание:* Память (\`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`) выше порога ${MEMORY_THRESHOLD_MB} MB\n`;
            }

            await sendTelegramMessage(chatId, statusMessage);
        } else {
            await sendTelegramMessage(chatId, `Приложение *${PM2_APP_NAME}* не найдено в PM2.`);
        }
    });
}

/**
 * Перезапускает PM2 приложение.
 * @param {string} chatId - ID чата для отправки сообщения.
 */
async function restartPm2App(chatId) {
    await sendTelegramMessage(chatId, `Запрос на перезапуск *${PM2_APP_NAME}*...`);

    pm2.restart(PM2_APP_NAME, async (err) => {
        if (err) {
            console.error(`Error restarting ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при перезапуске *${PM2_APP_NAME}*: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `🟢 *${PM2_APP_NAME}* успешно запрошен на перезапуск.`);
    });
}

/**
 * Останавливает PM2 приложение.
 * @param {string} chatId - ID чата для отправки сообщения.
 */
async function stopPm2App(chatId) {
    pm2.list(async (err, list) => {
        if (err) {
            console.error(`Error listing PM2 processes for stop check:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при проверке статуса PM2 для остановки: ${err.message}`);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        // Проверяем, если приложение уже остановлено или не найдено
        if (!app || app.pm2_env.status === 'stopped' || app.pm2_env.status === 'stopped_waiting') {
            await sendTelegramMessage(chatId, `ℹ️ Сервер *${PM2_APP_NAME}* уже остановлен и не запущен.`);
            return;
        }

        await sendTelegramMessage(chatId, `Запрос на остановку *${PM2_APP_NAME}*...`);

        pm2.stop(PM2_APP_NAME, async (err) => {
            if (err) {
                console.error(`Error stopping ${PM2_APP_NAME}:`, err.message);
                await sendTelegramMessage(chatId, `🔴 Ошибка при остановке *${PM2_APP_NAME}*: ${err.message}`);
                return;
            }
            await sendTelegramMessage(chatId, `⚫️ *${PM2_APP_NAME}* успешно запрошен на остановку.`);
        });
    });
}

/**
 * Запускает PM2 приложение.
 * @param {string} chatId - ID чата для отправки сообщения.
 */
async function startPm2App(chatId) {
    pm2.list(async (err, list) => {
        if (err) {
            console.error(`Error listing PM2 processes for start check:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при проверке статуса PM2 для запуска: ${err.message}`);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        if (app && app.pm2_env.status === 'online') {
            await sendTelegramMessage(chatId, `ℹ️ Сервер *${PM2_APP_NAME}* уже запущен.`);
            return;
        }

        await sendTelegramMessage(chatId, `Запрос на запуск *${PM2_APP_NAME}*...`);

        pm2.start(PM2_APP_NAME, async (err) => {
            if (err) {
                console.error(`Error starting ${PM2_APP_NAME}:`, err.message);
                await sendTelegramMessage(chatId, `🔴 Ошибка при запуске *${PM2_APP_NAME}*: ${err.message}`);
                return;
            }
            await sendTelegramMessage(chatId, `🟢 *${PM2_APP_NAME}* успешно запрошен на запуск.`);
        });
    });
}

/**
 * Получает список всех PM2 приложений и отправляет его в Telegram.
 * @param {string} chatId - ID чата для отправки сообщения.
 */
async function listAllPm2Apps(chatId) {
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
            let statusEmoji = '';
            // Определяем эмодзи в зависимости от статуса
            switch (app.pm2_env.status) {
                case 'online':
                    statusEmoji = '🟢 '; // Зеленый кружок для "online"
                    break;
                case 'stopped':
                    statusEmoji = '⚫️ '; // Черный кружок для "stopped"
                    break;
                case 'errored':
                    statusEmoji = '🔴 '; // Красный кружок для ошибок
                    break;
                case 'launching':
                    statusEmoji = '🟡 '; // Желтый кружок для запуска
                    break;
                default:
                    statusEmoji = '⚪️ '; // Белый кружок для неопределенного статуса
            }

            message += `*Имя:* \`${app.name}\`\n`;
            message += `   *ID:* \`${app.pm_id}\`\n`;
            message += `   *Статус:* ${statusEmoji}\`${app.pm2_env.status}\`\n`; // Добавили эмодзи сюда
            message += `   *Uptime:* ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            message += `   *Перезапусков:* \`${app.pm2_env.restart_time}\`\n`;
            message += `   *Память:* \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;
            message += `   *CPU:* \`${app.monit.cpu}%\`\n`;
            message += `\n`;
        });

        await sendTelegramMessage(chatId, message);
    });
}

/**
 * Подключается к демону PM2 и начинает прослушивать события.
 * Отправляет уведомления в Telegram о важных событиях приложения.
 */
function connectAndListenPm2Events() {
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
                // Отслеживаем события только для нашего конкретного приложения
                if (data.process.name === PM2_APP_NAME) {
                    let message = `📊 PM2 уведомление для *${PM2_APP_NAME}*: \n`;
                    switch (data.event) {
                        case 'stop':
                            message += `🔴 *ПРИЛОЖЕНИЕ ОСТАНОВЛЕНО!* (Status: \`${data.process.status}\`)`;
                            break;
                        case 'restart':
                            message += `🟡 *ПРИЛОЖЕНИЕ ПЕРЕЗАПУЩЕНО!* (Status: \`${data.process.status}\`)`;
                            break;
                        case 'exit':
                            message += `💔 *ПРИЛОЖЕНИЕ ВЫШЛО ИЗ СТРОЯ!* (Status: \`${data.process.status}\`)`;
                            break;
                        case 'online':
                            message += `✅ *ПРИЛОЖЕНИЕ ЗАПУЩЕНО И РАБОТАЕТ!* (Status: \`${data.process.status}\`)`;
                            break;
                        default:
                            message += `ℹ️ Неизвестное событие: \`${data.event}\` (Status: \`${data.process.status}\`)`;
                            break;
                    }
                    sendTelegramMessage(CHAT_ID, message, true); // Отправляем уведомление
                }
            });
        });
    });
}

// Экспортируем функции для использования в index.js
module.exports = {
    checkPm2AppStatus,
    restartPm2App,
    stopPm2App,
    startPm2App,
    listAllPm2Apps,
    connectAndListenPm2Events
};
