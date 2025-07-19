const pm2 = require('pm2');
require('dotenv').config();
const { sendTelegramMessage } = require('./telegram');

const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CPU_THRESHOLD_PERCENT = parseInt(process.env.CPU_THRESHOLD_PERCENT, 10);
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB, 10);
const CHAT_ID = process.env.CHAT_ID;

async function checkPm2AppStatus(chatId) {
    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, `🔴 Ошибка при получении статуса PM2: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
            console.error('Error listing PM2 processes for status check:', err.message);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);

        if (app) {
            let statusMessage = `📊 Статус *${PM2_APP_NAME}*:\n`;
            statusMessage += `   Статус: \`${app.pm2_env.status}\`\n`;
            statusMessage += `   Uptime: ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            statusMessage += `   Перезапусков: \`${app.pm2_env.restart_time}\`\n`;
            statusMessage += `   Память: \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;
            statusMessage += `   CPU: \`${app.monit.cpu}%\`\n`;

            if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
                statusMessage += `   ⚠️ *Внимание:* CPU (\`${app.monit.cpu}%\`) выше порога ${CPU_THRESHOLD_PERCENT}%\n`;
            }
            if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
                statusMessage += `   ⚠️ *Внимание:* Память (\`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`) выше порога ${MEMORY_THRESHOLD_MB} MB\n`;
            }

            await sendTelegramMessage(chatId, statusMessage, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
        } else {
            await sendTelegramMessage(chatId, `Приложение *${PM2_APP_NAME}* не найдено в PM2.`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
        }
    });
}

async function restartPm2App(chatId) {
    await sendTelegramMessage(chatId, `Запрос на перезапуск *${PM2_APP_NAME}*...`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2

    pm2.restart(PM2_APP_NAME, async (err) => {
        if (err) {
            console.error(`Error restarting ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при перезапуске *${PM2_APP_NAME}*: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
            return;
        }
        await sendTelegramMessage(chatId, `🟢 *${PM2_APP_NAME}* успешно запрошен на перезапуск.`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
    });
}

async function stopPm2App(chatId) {
    await sendTelegramMessage(chatId, `Запрос на остановку *${PM2_APP_NAME}*...`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2

    pm2.stop(PM2_APP_NAME, async (err) => {
        if (err) {
            console.error(`Error stopping ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при остановке *${PM2_APP_NAME}*: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
            return;
        }
        await sendTelegramMessage(chatId, `⚫️ *${PM2_APP_NAME}* успешно запрошен на остановку.`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
    });
}

async function startPm2App(chatId) {
    await sendTelegramMessage(chatId, `Запрос на запуск *${PM2_APP_NAME}*...`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2

    pm2.start(PM2_APP_NAME, async (err) => {
        if (err) {
            console.error(`Error starting ${PM2_APP_NAME}:`, err.message);
            await sendTelegramMessage(chatId, `🔴 Ошибка при запуске *${PM2_APP_NAME}*: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
            return;
        }
        await sendTelegramMessage(chatId, `🟢 *${PM2_APP_NAME}* успешно запрошен на запуск.`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
    });
}

async function listAllPm2Apps(chatId) {
    await sendTelegramMessage(chatId, 'Запрашиваю список всех приложений PM2...', true); // Здесь MarkdownV2 не нужен

    pm2.list(async (err, list) => {
        if (err) {
            await sendTelegramMessage(chatId, `🔴 Ошибка при получении списка приложений PM2: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
            console.error('Error listing all PM2 processes:', err.message);
            return;
        }

        if (list.length === 0) {
            await sendTelegramMessage(chatId, 'В PM2 не найдено запущенных приложений.', true); // Здесь MarkdownV2 не нужен
            return;
        }

        let message = '📋 Список всех приложений PM2:\n\n';
        list.forEach(app => {
            // Обратите внимание: для MarkdownV2 нужно экранировать символы, если они не являются частью форматирования
            // Например, `app.name` может содержать символы, которые нужно экранировать.
            // Простейший способ: не использовать бэк-тики вокруг app.name если не хотите его как кодблок.
            // Или использовать специальную функцию для экранирования, если app.name может быть произвольным текстом.
            // Для упрощения, предположим, что app.name не содержит спецсимволов, которые конфликтуют с MarkdownV2.
            message += `*Имя:* \`${app.name}\`\n`; // name в бэк-тиках
            message += `  *ID:* \`${app.pm_id}\`\n`;
            message += `  *Статус:* \`${app.pm2_env.status}\`\n`;
            message += `  *Uptime:* ${app.pm2_env.pm_uptime ? (Math.round((Date.now() - app.pm2_env.pm_uptime) / 1000 / 60)) + ' мин' : 'N/A'}\n`;
            message += `  *Перезапусков:* \`${app.pm2_env.restart_time}\`\n`;
            message += `  *Память:* \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;
            message += `  *CPU:* \`${app.monit.cpu}%\`\n`;
            message += `\n`;
        });

        await sendTelegramMessage(chatId, message, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
    });
}

function connectAndListenPm2Events() {
    pm2.connect(function (err) {
        if (err) {
            console.error('Error connecting to PM2:', err.message);
            sendTelegramMessage(CHAT_ID, `🔴 Ошибка подключения бота к PM2: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
            return;
        }
        console.log('Connected to PM2 daemon.');

        pm2.launchBus(function (err, bus) {
            if (err) {
                console.error('Error launching PM2 bus:', err.message);
                sendTelegramMessage(CHAT_ID, `🔴 Ошибка прослушивания событий PM2: ${err.message}`, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
                return;
            }

            bus.on('process:event', function (data) {
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
                            message += `🟢 *ПРИЛОЖЕНИЕ ЗАПУЩЕНО И РАБОТАЕТ!* (Status: \`${data.process.status}\`)`;
                            break;
                        default:
                            message += `ℹ️ Неизвестное событие: \`${data.event}\` (Status: \`${data.process.status}\`)`;
                            break;
                    }
                    sendTelegramMessage(CHAT_ID, message, true, { parse_mode: 'MarkdownV2' }); // Явно указываем MarkdownV2
                }
            });
        });
    });
}

module.exports = {
    checkPm2AppStatus,
    restartPm2App,
    stopPm2App,
    startPm2App,
    listAllPm2Apps,
    connectAndListenPm2Events
};