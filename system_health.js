// system_health.js
const checkDiskSpace = require('check-disk-space');
const pm2 = require('pm2');
const si = require('systeminformation');
require('dotenv').config();
const { sendTelegramMessage } = require('./telegram');

// Получаем необходимые переменные из process.env и парсим числа
const DISK_SPACE_THRESHOLD_PERCENT = parseInt(process.env.DISK_SPACE_THRESHOLD_PERCENT, 10);
const CPU_THRESHOLD_PERCENT = parseInt(process.env.CPU_THRESHOLD_PERCENT, 10);
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB, 10);
const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CHAT_ID = process.env.CHAT_ID;

// Определяем путь к диску, который нужно проверять.
const DISK_PATH_TO_CHECK = process.env.DISK_PATH_TO_CHECK || '/';


/**
 * Выполняет проверку состояния системы (диск, CPU, память PM2, общая RAM, uptime, OS info).
 * Отправляет оповещения, если обнаружены проблемы.
 */
async function checkSystemHealth() {
    console.log('Performing scheduled system health check...');
    let healthMessage = '🩺 *Ежедневная проверка состояния системы:*\n';
    let alertCount = 0;

    // --- Проверка места на диске ---
    try {
        // Проверяем, что checkDiskSpace действительно является функцией перед использованием
        if (typeof checkDiskSpace === 'function') {
            const diskSpace = await checkDiskSpace(DISK_PATH_TO_CHECK);

            const totalGB = (diskSpace.size / (1024 ** 3)).toFixed(2);
            const usedGB = ((diskSpace.size - diskSpace.free) / (1024 ** 3)).toFixed(2);
            const freeGB = (diskSpace.free / (1024 ** 3)).toFixed(2);
            const usedPercent = ((diskSpace.size - diskSpace.free) / diskSpace.size * 100).toFixed(2);
            const freePercent = (diskSpace.free / diskSpace.size * 100).toFixed(2);

            healthMessage += `\n💾 *Информация о диске (${DISK_PATH_TO_CHECK}):*\n`;
            healthMessage += `   Всего: \`${totalGB} GB\`\n`;
            healthMessage += `   Использовано: \`${usedGB} GB\` (\`${usedPercent}%\`)\n`;
            healthMessage += `   Свободно: \`${freeGB} GB\` (\`${freePercent}%\`)\n`;

            if (parseFloat(freePercent) < DISK_SPACE_THRESHOLD_PERCENT) {
                healthMessage += `🚨 *Внимание:* Низкое место на диске *${DISK_PATH_TO_CHECK}*: \`${freePercent}%\` свободно (ниже \`${DISK_SPACE_THRESHOLD_PERCENT}%\`)\n`;
                alertCount++;
            }
        } else {
            // Если checkDiskSpace не функция, просто пропускаем этот блок без вывода ошибки в Telegram
            console.error('checkDiskSpace is not a function. Disk information will not be displayed.');
        }
    } catch (e) {
        // Эта ошибка будет выведена только в консоль сервера, но не в Telegram
        console.error('Error getting disk info:', e.message);
        // alertCount++; // Не увеличиваем alertCount для этой ошибки, чтобы не отправлять её в Telegram
    }

    // --- Проверка общей оперативной памяти системы ---
    try {
        const mem = await si.mem();
        const totalMemGB = (mem.total / (1024 ** 3)).toFixed(2);
        const usedMemGB = (mem.used / (1024 ** 3)).toFixed(2);
        const freeMemGB = (mem.free / (1024 ** 3)).toFixed(2);
        const usedMemPercent = ((mem.used / mem.total) * 100).toFixed(2);

        healthMessage += `\n🧠 *Использование RAM системы:*\n`;
        healthMessage += `   Всего: \`${totalMemGB} GB\`\n`;
        healthMessage += `   Использовано: \`${usedMemGB} GB\` (\`${usedMemPercent}%\`)\n`;
        healthMessage += `   Свободно: \`${freeMemGB} GB\`\n`;

    } catch (e) {
        console.error('Error getting system memory info:', e.message);
        // alertCount++;
    }

    // --- Время работы системы (uptime) ---
    try {
        const osInfo = await si.osInfo();
        const osUptimeSeconds = osInfo.uptime;
        // Проверяем, что osUptimeSeconds является числом, чтобы избежать NaN
        if (typeof osUptimeSeconds === 'number' && !isNaN(osUptimeSeconds)) {
            const days = Math.floor(osUptimeSeconds / (3600 * 24));
            const hours = Math.floor((osUptimeSeconds % (3600 * 24)) / 3600);
            const minutes = Math.floor((osUptimeSeconds % 3600) / 60);

            healthMessage += `\n⏱️ *Время работы системы (Uptime):*\n`;
            healthMessage += `   \`${days} дн. ${hours} ч. ${minutes} мин.\`\n`;
        } else {
            console.error('Could not get valid system uptime. It might be NaN or undefined.');
        }
    } catch (e) {
        console.error('Error getting system uptime:', e.message);
        // alertCount++;
    }

    // --- Информация об ОС, Node.js, PM2 ---
    try {
        const os = await si.osInfo();
        const versions = await si.versions();

        healthMessage += `\n🖥️ *Информация об ОС:*\n`;
        healthMessage += `   Платформа: \`${os.distro}\`\n`;
        healthMessage += `   Архитектура: \`${os.arch}\`\n`;
        healthMessage += `   Ядро: \`${os.kernel}\`\n`;
        healthMessage += `\n💻 *Версии:*\n`;
        healthMessage += `   Node.js: \`${versions.node}\`\n`;
        healthMessage += `   PM2: \`${versions.pm2}\`\n`;
    } catch (e) {
        console.error('Error getting OS/versions info:', e.message);
        // alertCount++;
    }

    // --- Проверка CPU и памяти для конкретного PM2 приложения ---
    pm2.list(async (err, list) => {
        if (err) {
            healthMessage += `🔴 *Ошибка при получении списка PM2 приложений для проверки:* ${err.message}\n`;
            console.error('Error listing PM2 processes for health check:', err.message);
            alertCount++;
            await sendTelegramMessage(CHAT_ID, healthMessage, true);
            return;
        }

        const app = list.find(p => p.name === PM2_APP_NAME);
        if (app) {
            healthMessage += `\n📈 *Состояние ${PM2_APP_NAME}:*\n`;
            healthMessage += `   CPU: \`${app.monit.cpu}%\`\n`;
            healthMessage += `   Память: \`${(app.monit.memory / 1024 / 1024).toFixed(2)} MB\`\n`;

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

        await sendTelegramMessage(CHAT_ID, healthMessage, true);
        if (alertCount === 0) {
            console.log('System health check passed without alerts.');
        }
    });
}

module.exports = {
    checkSystemHealth
};