const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config(); // Загружаем переменные окружения из .env

// Инициализация Telegram бота с токеном из process.env
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- Состояние пользователя для навигации по меню ---
// Хранит текущее меню, в котором находится пользователь { chatId: 'current_menu_state' }
const userStates = {};

// --- Функции для отправки сообщений без MarkdownV2 по умолчанию ---
async function sendTelegramMessage(chatId, text, forceSend = false, options = {}) {
    // Не отправляем пустые сообщения, если это не принудительная отправка
    if (!text.trim() && !forceSend) {
        return;
    }

    const MAX_MESSAGE_LENGTH = 4000; // Максимальная длина сообщения в Telegram
    let parts = [];
    let remainingText = text;

    // Разделяем длинные сообщения на части
    while (remainingText.length > 0) {
        let part = remainingText.substring(0, MAX_MESSAGE_LENGTH);
        let lastNewline = part.lastIndexOf('\n');
        // Если сообщение длиннее MAX_MESSAGE_LENGTH и есть символ новой строки, обрезаем по нему
        if (lastNewline !== -1 && lastNewline !== part.length - 1 && remainingText.length > MAX_MESSAGE_LENGTH) {
            part = part.substring(0, lastNewline);
            remainingText = remainingText.substring(lastNewline + 1);
        } else {
            remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
        }
        parts.push(part);
    }

    // Отправляем каждую часть сообщения
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        try {
            // *** ИЗМЕНЕНИЕ ЗДЕСЬ: Убираем parse_mode: 'MarkdownV2' по умолчанию ***
            // Теперь отправляем как обычный текст, если явно не указано иное в options
            await bot.sendMessage(chatId, part, options);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            // Поскольку MarkdownV2 больше не используется по умолчанию,
            // этот fallback блок может быть менее актуален, но оставим его
            // для отладки других потенциальных ошибок отправки.
            console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
            // Повторная попытка без опций (на всякий случай)
            try {
                await bot.sendMessage(chatId, part, {});
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
            // *** ИЗМЕНЕНИЕ ЗДЕСЬ: Убираем parse_mode: 'MarkdownV2' по умолчанию ***
            ...options // Позволяет переопределять или добавлять другие опции
        });
    } catch (error) {
        console.error('Error sending message with keyboard:', error.response ? error.response.data : error.message);
        // В случае ошибки при отправке клавиатуры, отправляем только текст
        await sendTelegramMessage(chatId, text, false, options);
    }
}

// --- Общие опции для всех клавиатур ---
const keyboardOptions = {
    resize_keyboard: true, // Клавиатура будет автоматически подстраиваться под размер экрана
    one_time_keyboard: false // Клавиатура будет оставаться после использования
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
            [{ text: '⬅️ Назад в Главное меню' }] // Кнопка для возврата
        ],
        ...keyboardOptions
    }
};

const monitoringKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '📈 Статус приложения' }, { text: '📄 Последние 20 логов' }],
            [{ text: '🩺 Проверить систему' }, { text: '📋 Список всех приложений' }],
            [{ text: '⬅️ Назад в Главное меню' }] // Кнопка для возврата
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

// Экспортируем все необходимые сущности для использования в других модулях
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