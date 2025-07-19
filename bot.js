// bot.js

// В самом начале файла, до любых других require, загружаем переменные окружения из .env
require('dotenv').config();

// Импорт зависимостей из других модулей
const { bot, sendTelegramMessage, sendMessageWithKeyboard, userStates, mainKeyboard, managementKeyboard, monitoringKeyboard, confirmRestartKeyboard, confirmStopKeyboard } = require('./telegram');
const { checkPm2AppStatus, restartPm2App, stopPm2App, startPm2App, listAllPm2Apps, connectAndListenPm2Events } = require('./pm2_monitor');
const { checkSystemHealth } = require('./system_health');
const { startLogWatcher, readLastLines } = require('./log_watcher');

// Получаем переменные окружения напрямую из process.env
const CHAT_ID = process.env.CHAT_ID;
const PM2_APP_NAME = process.env.PM2_APP_NAME;
// Важно: численные значения из .env приходят как строки, их нужно парсить
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10);
const LOG_FILE_OUT = process.env.LOG_FILE_OUT;
const LOG_FILE_ERR = process.env.LOG_FILE_ERR;

// --- Обработчики команд Telegram ---

// Команда /start - начальная точка входа для пользователя
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    // Проверка доступа по CHAT_ID
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId] = 'main'; // Устанавливаем начальное состояние пользователя
    await sendMessageWithKeyboard(chatId, 'Привет! Я бот для мониторинга и управления PM2. Выберите категорию:', mainKeyboard);
});

// --- Обработка кнопок главного меню ---
bot.onText(/🛠️ Управление/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = 'management'; // Изменяем состояние пользователя на "управление"
    await sendMessageWithKeyboard(chatId, 'Вы в меню управления. Выберите действие:', managementKeyboard);
});

bot.onText(/📊 Мониторинг/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = 'monitoring'; // Изменяем состояние пользователя на "мониторинг"
    await sendMessageWithKeyboard(chatId, 'Вы в меню мониторинга. Выберите информацию:', monitoringKeyboard);
});

bot.onText(/❓ Помощь/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    await sendTelegramMessage(chatId, 'Привет! Я бот для логов PM2. Используйте кнопки для взаимодействия. Вот что я могу:\n' +
        '- *Управление*: Перезапуск, остановка, запуск вашего приложения.\n' +
        '- *Мониторинг*: Проверка статуса, логов, состояния системы и списка всех PM2 приложений.\n' +
        '- *Помощь*: Получить это сообщение.\n\n' +
        'Чтобы вернуться в главное меню, нажмите "⬅️ Назад в Главное меню".');
});

// Кнопка "Назад" для возврата в главное меню
bot.onText(/⬅️ Назад в Главное меню/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = 'main'; // Возвращаем состояние пользователя в "главное"
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в главное меню. Выберите категорию:', mainKeyboard);
});

// --- Обработка команд из подменю "Мониторинг" ---
bot.onText(/📈 Статус приложения/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    await checkPm2AppStatus(chatId); // Вызываем функцию из pm2_monitor.js
});

bot.onText(/📄 Последние (\d+) логов|📄 Последние 20 логов/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    const linesToFetch = match && match[1] ? parseInt(match[1], 10) : 20;

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)');
        return;
    }

    await sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для *${PM2_APP_NAME}*...`, true);

    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении OUT логов: ${err.message}`, true);
            return;
        }
        await sendTelegramMessage(chatId, `\`\`\`\n[OUT - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${outLogs || 'Нет записей в OUT логе.'}\n\`\`\``, true);
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении ERR логов: ${err.message}`, true);
            return;
        }
        await sendTelegramMessage(chatId, `\`\`\`\n[ERR - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${errLogs || 'Нет записей в ERR логе.'}\n\`\`\``, true);
    });
});

bot.onText(/🩺 Проверить систему/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    await sendTelegramMessage(chatId, 'Выполняю ручную проверку состояния системы...', true);
    await checkSystemHealth(); // Вызываем функцию из system_health.js
});

bot.onText(/📋 Список всех приложений/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    await listAllPm2Apps(chatId); // Вызываем функцию из pm2_monitor.js
});


// --- Обработка команд из подменю "Управление" ---
// ИЗМЕНЕНО: Теперь запрашиваем подтверждение
bot.onText(/🔄 Перезапустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }
    // Отправляем сообщение с инлайн-клавиатурой для подтверждения
    await sendMessageWithKeyboard(chatId, `Вы уверены, что хотите перезапустить *${PM2_APP_NAME}*?`, confirmRestartKeyboard(chatId), { parse_mode: 'MarkdownV2' });
});

// ИЗМЕНЕНО: Теперь запрашиваем подтверждение
bot.onText(/⏹️ Остановить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }
    // Отправляем сообщение с инлайн-клавиатурой для подтверждения
    await sendMessageWithKeyboard(chatId, `Вы уверены, что хотите остановить *${PM2_APP_NAME}*?`, confirmStopKeyboard(chatId), { parse_mode: 'MarkdownV2' });
});

// Команда "Запустить сервер" не требует подтверждения, как менее критичная
bot.onText(/▶️ Запустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }
    await startPm2App(chatId); // Вызываем функцию из pm2_monitor.js
});

// --- Обработка инлайн-колбэков (callback_query) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data; // Получаем данные из callback_data

    // Убедимся, что пользователь имеет доступ
    if (String(chatId) !== String(CHAT_ID)) {
        await bot.answerCallbackQuery(query.id, { text: 'У вас нет доступа.' });
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этой функции.');
        return;
    }

    // Проверяем, что колбэк пришел именно от нашего чата, для которого он был сгенерирован
    // Это защита от старых или пересылаемых кнопок
    if (!data.endsWith(`_${chatId}`)) {
         await bot.answerCallbackQuery(query.id, { text: 'Эта кнопка неактивна или предназначена для другого чата.' });
         return;
    }

    // Удаляем инлайн-клавиатуру после ответа, чтобы избежать повторных нажатий
    await bot.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] } // Пустая клавиатура удаляет кнопки
    }).catch(e => console.error("Error editing message reply markup:", e.message)); // Отлавливаем ошибку, если сообщение уже удалено/изменено

    if (data.startsWith('confirm_restart_')) {
        await bot.answerCallbackQuery(query.id, { text: 'Перезапуск подтвержден.' });
        await restartPm2App(chatId);
    } else if (data.startsWith('confirm_stop_')) {
        await bot.answerCallbackQuery(query.id, { text: 'Остановка подтверждена.' });
        await stopPm2App(chatId);
    } else if (data.startsWith('cancel_action_')) {
        await bot.answerCallbackQuery(query.id, { text: 'Действие отменено.' });
        await sendTelegramMessage(chatId, 'Действие отменено.');
    } else {
        await bot.answerCallbackQuery(query.id, { text: 'Неизвестная команда.' });
    }
});


// --- Запуск системных проверок и мониторинга логов ---
setInterval(() => checkSystemHealth(), CHECK_INTERVAL_MS);

connectAndListenPm2Events();

startLogWatcher();

console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});