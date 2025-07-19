const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config(); // Загружаем переменные окружения из .env

// Инициализация Telegram бота с токеном из process.env
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- Состояние пользователя для навигации по меню ---
// Хранит текущее меню, в котором находится пользователь { chatId: 'current_menu_state' }
const userStates = {};

// --- Функции для отправки сообщений с Markdown и опциями ---
async function sendTelegramMessage(chatId, text, parseMode = 'MarkdownV2', forceSend = false, options = {}) {
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
        // Также убедимся, что part не становится пустой строкой после обрезки
        if (lastNewline !== -1 && lastNewline !== part.length - 1 && remainingText.length > MAX_MESSAGE_LENGTH && lastNewline > 0) {
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
            // Применяем parse_mode только если он указан
            const currentOptions = { ...options };
            if (parseMode) {
                currentOptions.parse_mode = parseMode;
            }
            
            // Если текст должен быть в кодеблоке, добавляем его
            let formattedPart = part;
            if (parseMode === 'MarkdownV2' && (text.startsWith('```') || text.includes('`'))) { // Простая проверка на наличие кодблоков
                 formattedPart = '```\n' + part + '\n```';
            }

            await bot.sendMessage(chatId, formattedPart, currentOptions);
            console.log('Message part sent to Telegram.');
        } catch (error) {
            // Если произошла ошибка, попробуем отправить без MarkdownV2
            console.error('Error sending message to Telegram:', error.response ? error.response.data : error.message);
            try {
                const currentOptions = { ...options }; // Очищаем parse_mode
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
        await sendTelegramMessage(chatId, text, 'MarkdownV2', false, options); // Использование parseMode по умолчанию
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

// Новая клавиатура для подтверждения
const confirmationKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '✅ Да' }, { text: '❌ Нет' }],
            [{ text: '⬅️ Назад в Главное меню' }] // Добавляем возможность отменить и вернуться
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
    confirmationKeyboard // Экспортируем новую клавиатуру
};