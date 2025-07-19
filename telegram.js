// telegram.js

const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const userStates = {};

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
            const currentOptions = i === 0 ? { parse_mode: 'MarkdownV2', ...options } : { parse_mode: 'MarkdownV2' };
            // Исправлено: если это обычный текст, не оборачиваем его в ```
            // Если текст НЕ начинается с ``` или не содержит специальных символов для MarkdownV2,
            // то не используем MarkdownV2 или экранируем.
            // Для упрощения, будем считать, что логи всегда в ```, а простые сообщения - без.
            // Если передана опция parse_mode, используем ее.
            if (currentOptions.parse_mode === 'MarkdownV2' && (part.includes('```') || part.includes('*') || part.includes('_') || part.includes('[') || part.includes('('))) {
                await bot.sendMessage(chatId, part, currentOptions);
            } else {
                // Если нет спецсимволов или не нужен MarkdownV2, отправляем как plain text
                await bot.sendMessage(chatId, part, currentOptions);
            }
            console.log('Message part sent to Telegram.');
        } catch (error) {
            console.error('Error sending message to Telegram (MarkdownV2/send failed):', error.response ? error.response.data : error.message);
            try {
                // Попытка отправить как plain text, если MarkdownV2 выдал ошибку
                const currentOptions = i === 0 ? options : {};
                await bot.sendMessage(chatId, part, currentOptions);
                console.log('Message part sent without MarkdownV2 due to error.');
            } catch (fallbackError) {
                console.error('Fallback send failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
            }
        }
    }
}

async function sendMessageWithKeyboard(chatId, text, keyboard, options = {}) {
    try {
        await bot.sendMessage(chatId, text, {
            reply_markup: keyboard.reply_markup,
            ...options
        });
    } catch (error) {
        console.error('Error sending message with keyboard:', error.response ? error.response.data : error.message);
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

// Экспортируем новые клавиатуры и функцию для их отправки
module.exports = {
    bot,
    sendTelegramMessage,
    sendMessageWithKeyboard,
    userStates,
    mainKeyboard,
    managementKeyboard,
    monitoringKeyboard,
    confirmRestartKeyboard, // Добавляем в экспорт
    confirmStopKeyboard     // Добавляем в экспорт
};