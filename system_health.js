const nodeDiskInfo = require('node-disk-info'); // ИЗМЕНЕНО: импортируем весь модуль
const pm2 = require('pm2'); // Нужен для получения информации о CPU/памяти PM2 процессов
require('dotenv').config(); // Загружаем переменные окружения
const { sendTelegramMessage } = require('./telegram'); // Импортируем функцию для отправки сообщений

// Получаем необходимые переменные из process.env и парсим числа
const DISK_SPACE_THRESHOLD_PERCENT = parseInt(process.env.DISK_SPACE_THRESHOLD_PERCENT, 10);
const CPU_THRESHOLD_PERCENT = parseInt(process.env.CPU_THRESHOLD_PERCENT, 10);
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB, 10);
const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CHAT_ID = process.env.CHAT_ID; // Chat ID для отправки уведомлений о состоянии системы

/**
 * Выполняет проверку состояния системы (диск, CPU, память PM2).
 * Отправляет оповещения, если обнаружены проблемы.
 */
async function checkSystemHealth() {
    console.log('Performing scheduled system health check...');
    let healthMessage = '🩺 Ежедневная проверка состояния системы:\n';
    let alertCount = 0; // Счетчик найденных проблем

    // --- Проверка места на диске ---
    try {
        const drives = await nodeDiskInfo.getDrives(); // ИЗМЕНЕНО: вызываем через nodeDiskInfo
        let diskInfo = '';
        drives.forEach(drive => {
            const usedPercent = (drive.used / drive.total * 100).toFixed(2);
            const freePercent = (drive.available / drive.total * 100).toFixed(2);
            diskInfo += `  Диск *${drive.mounted}*:\n`;
            diskInfo += `    Всего: \`${(drive.total / (1024 ** 3)).toFixed(2)} GB\`\n`;
            diskInfo += `    Использовано: \`${(drive.used / (1024 ** 3)).toFixed(2)} GB\` (\`${usedPercent}%\`)\n`;
            diskInfo += `    Свободно: \`${(drive.available / (1024 ** 3)).toFixed(2)} GB\` (\`${freePercent}%\`)\n`;

            if (parseFloat(freePercent) < DISK_SPACE_THRESHOLD_PERCENT) { // Убедимся, что сравниваем числа
                healthMessage += `🚨 *Внимание:* Низкое место на диске *${drive.mounted}*: \`${freePercent}%\` свободно (ниже \`${DISK_SPACE_THRESHOLD_PERCENT}%\`)\n`;
                alertCount++;
            }
        });
        healthMessage += `\n💾 Информация о дисках:\n${diskInfo}`;
    } catch (e) {
        healthMessage += `🔴 *Ошибка при получении информации о дисках:* ${e.message}\n`;
        console.error('Error getting disk info:', e);
        alertCount++;
    }

    // --- Проверка CPU и памяти для конкретного PM2 приложения ---
    pm2.list(async (err, list) => {
        if (err) {
            healthMessage += `🔴 *Ошибка при получении списка PM2 приложений для проверки:* ${err.message}\n`;
            console.error('Error listing PM2 processes for health check:', err.message);
            alertCount++;
            await sendTelegramMessage(CHAT_ID, healthMessage, true); // Отправляем сообщение, если ошибка PM2
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);
        if (app) {
            healthMessage += `\n📈 Состояние *${PM2_APP_NAME}*:\n`;
            healthMessage += `  CPU: \`${app.monit.cpu}%\`\n`;
            healthMessage += `  Память: \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;

            if (app.monit.cpu > CPU_THRESHOLD_PERCENT) {
                healthMessage += `🚨 *Внимание:* CPU (\`${app.monit.cpu}%\`) выше порога \`${CPU_THRESHOLD_PERCENT}%\`\n`;
                alertCount++;
            }
            if ((app.monit.memory / 1024 / 1024) > MEMORY_THRESHOLD_MB) {
                healthMessage += `🚨 *Внимание:* Память (\`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`) выше порога \`${MEMORY_THRESHOLD_MB} MB\`\n`;
                alertCount++;
            }
        } else {
            healthMessage += `\nПриложение *${PM2_APP_NAME}* не найдено в PM2 для проверки CPU/памяти.\n`;
        }

        // Отправляем сообщение только если были обнаружены проблемы
        if (alertCount > 0) {
            await sendTelegramMessage(CHAT_ID, healthMessage, true);
        } else {
            console.log('System health check passed without alerts.');
        }
    });
}

// Экспортируем функцию для использования в index.js
module.exports = {
    checkSystemHealth
};