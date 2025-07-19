const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config(); // Загружаем переменные окружения из .env

// Инициализация Telegram бота с токеном из process.env
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- Состояние пользователя для навигации по меню ---
// Хранит текущее меню, в котором находится пользователь { chatId: 'current_menu_state' }
const userStates = {};

// --- Функции для отправки сообщений с Markdown и опциями ---
async function sendTelegramMessage(chatId, text, options = {}) {
    // Не отправляем пустые сообщения
    if (!text.trim()) {
        return;
    }

    const MAX_MESSAGE_LENGTH = 4096; // Максимальная длина сообщения в Telegram (4096 для текста, 4000 для MarkdownV2)
    let parts = [];
    let remainingText = text;

    // Разделяем длинные сообщения на части
    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        // Попытка разбить по последней новой строке, если часть слишком большая
        // Это более мягкое условие, чем 0.8, чтобы избежать слишком коротких кусков
        if (remainingText.length > MAX_MESSAGE_LENGTH) {
            let lastNewline = part.lastIndexOf('\n');
            if (lastNewline !== -1 && lastNewline > (MAX_MESSAGE_LENGTH * 0.5)) { // Если новая строка находится во второй половине части
                part = part.substring(0, lastNewline);
                remainingText = remainingText.substring(lastNewline + 1);
            } else {
                remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
            }
        } else {
            remainingText = ''; // Вся оставшаяся часть - это последняя
        }
        parts.push(part);
    }

    // Отправляем каждую часть сообщения
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        try {
            // Применяем parse_mode и другие опции, переданные в функцию.
            // Если parse_mode не указан, по умолчанию не используем его (plain text).
            await bot.sendMessage(chatId, part, options);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
            // Если ошибка связана с парсингом (частая проблема с MarkdownV2), попробуем отправить как plain text
            if (error.response && error.response.data && error.response.data.description &&
                (error.response.data.description.includes('Bad Request: can\'t parse entities') ||
                 error.response.data.description.includes('Bad Request: failed to parse'))) {
                try {
                    console.warn('Attempting to send as plain text due to Markdown parsing error.');
                    await bot.sendMessage(chatId, part); // Отправляем без форматирования
                } catch (fallbackError) {
                    console.error('Fallback send as plain text failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
                }
            } else {
                // В случае других ошибок, просто логируем и не ретраим без формата
                console.error('Non-parsing error, not retrying without format:', error.response ? error.response.data : error.message);
            }
        }
    }
}

// --- Функции для отправки сообщений с определенной клавиатурой ---
async function sendMessageWithKeyboard(chatId, text, keyboard, options = {}) {
    try {
        await bot.sendMessage(chatId, text, {
            reply_markup: keyboard.reply_markup,
            ...options
        });
    } catch (error) {
        console.error('Error sending message with keyboard:', error.response ? error.response.data : error.message);
        // В случае ошибки при отправке клавиатуры, отправляем только текст
        // Пробуем отправить с исходными опциями, если это был parse_mode
        await sendTelegramMessage(chatId, text, options); // передаем исходные options, чтобы parse_mode сохранился
    }
}

// --- Общие опции для всех клавиатур ---
const keyboardOptions = {
    resize_keyboard: true,
    one_time_keyboard: false
};

// --- Определение основных клавиатур ---
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🛠️ Управление' }, { text: '📊 Мониторинг' }],
            [{ text: '❓ Помощь' }]
        ],
        ...keyboardOptions
    }
};

const managementKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔄 Перезапустить сервер' }],
            [{ text: '⏹️ Остановить сервер' }, { text: '▶️ Запустить сервер' }],
            [{ text: '⬅️ Назад в Главное меню' }]
        ],
        ...keyboardOptions
    }
};

const monitoringKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📈 Статус приложения' }, { text: '📄 Последние 20 логов' }],
            [{ text: '🩺 Проверить систему' }, { text: '📋 Список всех приложений' }],
            [{ text: '⬅️ Назад в Главное меню' }]
        ],
        ...keyboardOptions
    }
};

const confirmationKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '✅ Да' }, { text: '❌ Нет' }],
            [{ text: '⬅️ Назад в Главное меню' }]
        ],
        ...keyboardOptions
    }
};


// Экспортируем все необходимые сущности для использования в других модулях
module.exports = {
    bot,
    sendTelegramMessage,
    sendMessageWithKeyboard,
    userStates,
    mainKeyboard,
    managementKeyboard,
    monitoringKeyboard,
    confirmationKeyboard
};