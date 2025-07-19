// В самом начале файла, до любых других require, загружаем переменные окружения из .env
require('dotenv').config();

// Импорт зависимостей из других модулей
const { bot, sendTelegramMessage, sendMessageWithKeyboard, userStates, mainKeyboard, managementKeyboard, monitoringKeyboard } = require('./telegram');
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Добавляем пароль администратора

// --- Обработчики команд Telegram ---

// Команда /start - начальная точка входа для пользователя
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    // Проверка доступа по CHAT_ID
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId] = { state: 'main', action: null }; // Устанавливаем начальное состояние пользователя
    await sendMessageWithKeyboard(chatId, 'Привет! Я бот для мониторинга и управления PM2. Выберите категорию:', mainKeyboard);
});

// --- Обработка кнопок главного меню ---
bot.onText(/🛠️ Управление/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = { state: 'management', action: null }; // Изменяем состояние пользователя на "управление"
    await sendMessageWithKeyboard(chatId, 'Вы в меню управления. Выберите действие:', managementKeyboard);
});

bot.onText(/📊 Мониторинг/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = { state: 'monitoring', action: null }; // Изменяем состояние пользователя на "мониторинг"
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
    userStates[chatId] = { state: 'main', action: null }; // Возвращаем состояние пользователя в "главное"
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в главное меню. Выберите категорию:', mainKeyboard);
});

// --- Обработка команд из подменю "Мониторинг" ---
bot.onText(/📈 Статус приложения/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId].action = null; // Сбрасываем ожидаемое действие
    await checkPm2AppStatus(chatId); // Вызываем функцию из pm2_monitor.js
});

bot.onText(/📄 Последние (\d+) логов|📄 Последние 20 логов/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId].action = null; // Сбрасываем ожидаемое действие

    // Если число не указано в команде, по умолчанию берем 20
    const linesToFetch = match && match[1] ? parseInt(match[1], 10) : 20;

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)');
        return;
    }

    await sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для ${PM2_APP_NAME}...`);

    // Чтение логов из файлов OUT и ERR
    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении OUT логов: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `[OUT - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${outLogs || 'Нет записей в OUT логе.'}`);
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении ERR логов: ${err.message}`);
            return;
        }
        await sendTelegramMessage(chatId, `[ERR - ${PM2_APP_NAME} - ЗАПРОС ${linesToFetch}]\n${errLogs || 'Нет записей в ERR логе.'}`);
    });
});

bot.onText(/🩺 Проверить систему/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId].action = null; // Сбрасываем ожидаемое действие
    await sendTelegramMessage(chatId, 'Выполняю ручную проверку состояния системы...');
    await checkSystemHealth(); // Вызываем функцию из system_health.js
});

bot.onText(/📋 Список всех приложений/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        bot.sendMessage(chatId, 'Извините, у вас нет доступа к этому боту.');
        return;
    }
    userStates[chatId].action = null; // Сбрасываем ожидаемое действие
    await listAllPm2Apps(chatId); // Вызываем функцию из pm2_monitor.js
});


// --- Обработка команд из подменю "Управление" ---
bot.onText(/🔄 Перезапустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }
    // Устанавливаем состояние ожидания пароля для перезапуска
    userStates[chatId] = { state: 'awaiting_password', action: 'restart' };
    await sendTelegramMessage(chatId, 'Введите пароль администратора для подтверждения перезапуска сервера.');
});

bot.onText(/⏹️ Остановить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }
    // Устанавливаем состояние ожидания пароля для остановки
    userStates[chatId] = { state: 'awaiting_password', action: 'stop' };
    await sendTelegramMessage(chatId, 'Введите пароль администратора для подтверждения остановки сервера.');
});

bot.onText(/▶️ Запустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.');
        return;
    }
    userStates[chatId].action = null; // Сбрасываем ожидаемое действие
    await startPm2App(chatId); // Вызываем функцию из pm2_monitor.js
});

// --- Новый обработчик для текстовых сообщений (проверка пароля) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Игнорируем команды и сообщения от неавторизованных пользователей
    if (text.startsWith('/') || String(chatId) !== String(CHAT_ID)) {
        return;
    }

    // Проверяем, находится ли пользователь в состоянии ожидания пароля
    if (userStates[chatId] && userStates[chatId].state === 'awaiting_password') {
        if (text === ADMIN_PASSWORD) {
            await sendTelegramMessage(chatId, 'Пароль подтвержден. Выполняю команду...');
            // Выполняем сохраненное действие
            if (userStates[chatId].action === 'restart') {
                await restartPm2App(chatId);
            } else if (userStates[chatId].action === 'stop') {
                await stopPm2App(chatId);
            }
            // Сбрасываем состояние после выполнения команды
            userStates[chatId] = { state: 'main', action: null };
            await sendMessageWithKeyboard(chatId, 'Возвращаемся в главное меню. Выберите категорию:', mainKeyboard);
        } else {
            await sendTelegramMessage(chatId, 'Неверный пароль. Попробуйте снова или нажмите "⬅️ Назад в Главное меню" для отмены.');
            // Остаемся в состоянии ожидания пароля
        }
    }
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