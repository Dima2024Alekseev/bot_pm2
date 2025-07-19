const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config(); // Загружаем переменные окружения из .env

// Инициализация Telegram бота с токеном из process.env
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- Состояние пользователя для навигации по меню ---
// Хранит текущее меню, в котором находится пользователь { chatId: 'current_menu_state' }
const userStates = {};

// --- Функции для отправки сообщений с Markdown и опциями ---
// Добавляем новый параметр `isCodeBlock`
async function sendTelegramMessage(chatId, text, options = {}, isCodeBlock = false) {
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
        if (remainingText.length > MAX_MESSAGE_LENGTH) {
            let lastNewline = part.lastIndexOf('\n');
            if (lastNewline !== -1 && lastNewline > (MAX_MESSAGE_LENGTH * 0.8)) { // Если новая строка близко к концу части
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
        let part = parts[i];
        let currentOptions = { ...options };

        try {
            // Если isCodeBlock = true, оборачиваем каждую часть в кодовый блок и устанавливаем parse_mode: 'MarkdownV2'
            if (isCodeBlock) {
                part = '```\n' + part + '\n```';
                currentOptions.parse_mode = 'MarkdownV2';
            }
            // Если parse_mode не был установлен явно (и это не кодовый блок),
            // и вы хотите использовать MarkdownV2 для обычных сообщений,
            // добавьте его здесь или при вызове.
            // Например, для обратной совместимости с вашим исходным ботом:
            // if (!currentOptions.parse_mode && !isCodeBlock) {
            //    currentOptions.parse_mode = 'Markdown'; // Или 'MarkdownV2' с экранированием
            // }

            await bot.sendMessage(chatId, part, currentOptions);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
            // Если ошибка связана с парсингом, попробуем отправить как plain text
            if (error.response && error.response.data && error.response.data.description && 
                (error.response.data.description.includes('Bad Request: can\'t parse entities') || 
                 error.response.data.description.includes('Bad Request: failed to parse'))) {
                try {
                    console.warn('Attempting to send as plain text due to Markdown parsing error.');
                    await bot.sendMessage(chatId, parts[i]); // Отправляем исходную часть без форматирования
                } catch (fallbackError) {
                    console.error('Fallback send as plain text failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
                }
            } else {
                // В случае других ошибок, просто логируем
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
        await sendTelegramMessage(chatId, text, options); // Передаем исходные опции
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