const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const userStates = {};

// --- Функции для отправки сообщений без MarkdownV2 по умолчанию ---
async function sendTelegramMessage(chatId, text, forceSend = false, options = {}) {
    if (!text.trim() && !forceSend) {
        return;
    }

    const MAX_MESSAGE_LENGTH = 4000;
    let parts = [];
    let remainingText = text;

    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        let lastNewline = part.lastIndexOf('\n');
        if (lastNewline !== -1 && lastNewline !== part.length - 1 && remainingText.length > MAX_MESSAGE_LENGTH) {
            part = part.substring(0, lastNewline);
            remainingText = remainingText.substring(lastNewline + 1);
        } else {
            remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
        }
        parts.push(part);
    }

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        try {
            // *** Ключевое ИЗМЕНЕНИЕ: Убираем parse_mode по умолчанию. Будет обычный текст. ***
            // Если вы хотите иногда использовать MarkdownV2 (например, для логов),
            // то нужно передавать { parse_mode: 'MarkdownV2' } в опциях при вызове sendTelegramMessage
            await bot.sendMessage(chatId, part, options);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
            // Fallback на случай, если даже обычная отправка с ошибками
            try {
                await bot.sendMessage(chatId, part, {}); // Попытка отправить вообще без опций
                console.log('Message part sent with minimal options due to error.');
            } catch (fallbackError) {
                console.error('Final fallback send failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
            }
        }
    }
}

// --- Функции для отправки сообщений с определенной клавиатурой ---
async function sendMessageWithKeyboard(chatId, text, keyboard, options = {}) {
    try {
        await bot.sendMessage(chatId, text, {
            reply_markup: keyboard.reply_markup,
            // *** Ключевое ИЗМЕНЕНИЕ: Убираем parse_mode: 'MarkdownV2' отсюда тоже. ***
            // Текст для клавиатурных сообщений теперь будет обычным текстом,
            // если только не указан `parse_mode` в `options`.
            ...options
        });
    } catch (error) {
        console.error('Error sending message with keyboard:', error.response ? error.response.data : error.message);
        // В случае ошибки при отправке клавиатуры, отправляем только текст
        await sendTelegramMessage(chatId, text, false, options);
    }
}

const keyboardOptions = {
    resize_keyboard: true,
    one_time_keyboard: false
};

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

// --- Новые инлайн-клавиатуры для подтверждения ---
const confirmRestartKeyboard = (chatId) => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '✅ Да, перезапустить', callback_data: `confirm_restart_${chatId}` }],
            [{ text: '❌ Нет, отмена', callback_data: `cancel_action_${chatId}` }]
        ]
    }
});

const confirmStopKeyboard = (chatId) => ({
    reply_markup: {
        inline_keyboard: [
            [{ text: '✅ Да, остановить', callback_data: `confirm_stop_${chatId}` }],
            [{ text: '❌ Нет, отмена', callback_data: `cancel_action_${chatId}` }]
        ]
    }
});

module.exports = {
    bot,
    sendTelegramMessage,
    sendMessageWithKeyboard,
    userStates,
    mainKeyboard,
    managementKeyboard,
    monitoringKeyboard,
    confirmRestartKeyboard,
    confirmStopKeyboard
};