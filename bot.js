// В самом начале файла, до любых других require, загружаем переменные окружения из .env
require('dotenv').config();

// Импорт зависимостей из других модулей
const { bot, sendTelegramMessage, sendMessageWithKeyboard, userStates, mainKeyboard, managementKeyboard, monitoringKeyboard, confirmationKeyboard } = require('./telegram'); // Добавляем confirmationKeyboard
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

// Добавляем новые состояния для подтверждения
const USER_STATE_CONFIRM_RESTART = 'confirm_restart';
const USER_STATE_CONFIRM_STOP = 'confirm_stop';

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
        'Чтобы вернуться в главное меню, нажмите "⬅️ Назад в Главное меню".', 'Markdown'); // Используем 'Markdown' для этого сообщения
});

// Кнопка "Назад" для возврата в главное меню (работает из любого подменю)
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

    // Если число не указано в команде, по умолчанию берем 20
    const linesToFetch = match && match[1] ? parseInt(match[1], 10) : 20;

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)', 'Markdown');
        return;
    }

    await sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для ${PM2_APP_NAME}...`, 'Markdown');

    // Чтение логов из файлов OUT и ERR
    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении OUT логов: ${err.message}`, 'Markdown');
            return;
        }
        await sendTelegramMessage(chatId, `[OUT - *${PM2_APP_NAME}* - ЗАПРОС ${linesToFetch}]\n${outLogs || 'Нет записей в OUT логе.'}`, 'Markdown');
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении ERR логов: ${err.message}`, 'Markdown');
            return;
        }
        await sendTelegramMessage(chatId, `[ERR - *${PM2_APP_NAME}* - ЗАПРОС ${linesToFetch}]\n${errLogs || 'Нет записей в ERR логе.'}`, 'Markdown');
    });
});

bot.onText(/🩺 Проверить систему/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    await sendTelegramMessage(chatId, 'Выполняю ручную проверку состояния системы...', 'Markdown');
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

// Обновленный обработчик для перезапуска
bot.onText(/🔄 Перезапустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.', 'Markdown');
        return;
    }
    userStates[chatId] = USER_STATE_CONFIRM_RESTART; // Устанавливаем состояние ожидания подтверждения перезапуска
    await sendMessageWithKeyboard(chatId, 'Вы уверены, что хотите перезапустить сервер? Это может прервать текущие операции.', confirmationKeyboard, { parse_mode: 'Markdown' });
});

// Обновленный обработчик для остановки
bot.onText(/⏹️ Остановить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.', 'Markdown');
        return;
    }
    userStates[chatId] = USER_STATE_CONFIRM_STOP; // Устанавливаем состояние ожидания подтверждения остановки
    await sendMessageWithKeyboard(chatId, 'Вы уверены, что хотите остановить сервер? Это полностью остановит работу приложения!', confirmationKeyboard, { parse_mode: 'Markdown' });
});

bot.onText(/▶️ Запустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.', 'Markdown');
        return;
    }
    await startPm2App(chatId); // Вызываем функцию из pm2_monitor.js
});


// --- Обработка кнопок подтверждения "Да" и "Нет" ---
bot.onText(/✅ Да/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    const currentState = userStates[chatId];
    if (currentState === USER_STATE_CONFIRM_RESTART) {
        await restartPm2App(chatId);
    } else if (currentState === USER_STATE_CONFIRM_STOP) {
        await stopPm2App(chatId);
    } else {
        await sendTelegramMessage(chatId, 'Не могу определить, какое действие нужно подтвердить. Пожалуйста, попробуйте еще раз.', 'Markdown');
    }

    // Возвращаемся в меню управления после выполнения действия
    userStates[chatId] = 'management';
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в меню управления. Выберите действие:', managementKeyboard);
});

bot.onText(/❌ Нет/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }

    await sendTelegramMessage(chatId, 'Действие отменено.', 'Markdown');
    // Возвращаемся в меню управления
    userStates[chatId] = 'management';
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в меню управления. Выберите действие:', managementKeyboard);
});


// --- Запуск системных проверок и мониторинга логов ---
// Периодическая проверка состояния системы
setInterval(() => checkSystemHealth(), CHECK_INTERVAL_MS);

// Подключение к PM2 для прослушивания событий
connectAndListenPm2Events();

// Запуск отслеживания файлов логов
startLogWatcher();

console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

// Обработка ошибок опроса Telegram API
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});