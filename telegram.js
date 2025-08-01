// telegram.js
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config(); // Загружаем переменные окружения

// Инициализация Telegram бота с токеном из process.env
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- Состояние пользователя для навигации по меню ---
// Хранит текущее меню, в котором находится пользователь { chatId: { state: 'current_menu_state', action: null } }
// Добавляем 'action' для отслеживания ожидаемого подтверждения (например, перезапуск/остановка)
const userStates = {};

// --- Функции для отправки сообщений с Markdown и опциями ---
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
            remainingText = remaining.substring(lastNewline + 1);
        } else {
            remainingText = remainingText.substring(MAX_MESSAGE_LENGTH);
        }
        parts.push(part);
    }

    // Отправляем каждую часть сообщения
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        try {
            // Применяем MarkdownV2 для форматирования кода, если это первая часть, добавляем переданные опции
            const currentOptions = i === 0 ? { parse_mode: 'MarkdownV2', ...options } : { parse_mode: 'MarkdownV2' };
            await bot.sendMessage(chatId, `\`\`\`\n${part}\n\`\`\``, currentOptions);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            // Если MarkdownV2 вызывает ошибку, пробуем отправить без него
            console.error('Error sending message to Telegram (MarkdownV2 failed):', error.response ? error.response.data : error.message);
            try {
                const currentOptions = i === 0 ? options : {}; // Передаем опции только для первой части
                await bot.sendMessage(chatId, part, currentOptions);
                console.log('Message part sent without MarkdownV2 due to error.');
            } catch (fallbackError) {
                // Если и это не удалось, логируем окончательную ошибку
                console.error('Fallback send failed:', fallbackError.response ? fallbackError.response.data : fallbackError.message);
            }
        }
    }
}

// --- Функции для отправки сообщений с определенной клавиатурой ---
// Эта функция отправляет сообщение и прикрепляет к нему кастомную клавиатуру.
async function sendMessageWithKeyboard(chatId, text, keyboard, options = {}) {
    try {
        await bot.sendMessage(chatId, text, {
            reply_markup: keyboard.reply_markup, // Важно: reply_markup должен быть вложен в объект опций
            ...options // Позволяет переопределять или добавлять другие опции, например parse_mode
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

// Экспортируем все необходимые сущности для использования в других модулях
module.exports = {
    bot,
    sendTelegramMessage,
    sendMessageWithKeyboard,
    userStates,
    mainKeyboard,
    managementKeyboard,
    monitoringKeyboard
};