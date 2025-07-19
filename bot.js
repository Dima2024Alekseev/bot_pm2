// В самом начале файла, до любых других require, загружаем переменные окружения из .env
require('dotenv').config();

// Импорт зависимостей из других модулей
const { bot, sendTelegramMessage, sendMessageWithKeyboard, userStates, mainKeyboard, managementKeyboard, monitoringKeyboard, confirmationKeyboard } = require('./telegram');
const { checkPm2AppStatus, restartPm2App, stopPm2App, startPm2App, listAllPm2Apps, connectAndListenPm2Events } = require('./pm2_monitor');
const { checkSystemHealth } = require('./system_health');
const { startLogWatcher, readLastLines } = require('./log_watcher');

// Получаем переменные окружения напрямую из process.env
const CHAT_ID = process.env.CHAT_ID;
const PM2_APP_NAME = process.env.PM2_APP_NAME;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10);
const LOG_FILE_OUT = process.env.LOG_FILE_OUT;
const LOG_FILE_ERR = process.env.LOG_FILE_ERR;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Получаем административный пароль

// --- Состояния пользователя для навигации по меню и аутентификации ---
const USER_STATE_MAIN = 'main';
const USER_STATE_MANAGEMENT = 'management';
const USER_STATE_MONITORING = 'monitoring';
const USER_STATE_AWAITING_PASSWORD_RESTART = 'awaiting_password_restart'; // Новое состояние: ожидание пароля для перезапуска
const USER_STATE_AWAITING_PASSWORD_STOP = 'awaiting_password_stop';     // Новое состояние: ожидание пароля для остановки
const USER_STATE_CONFIRM_RESTART = 'confirm_restart';
const USER_STATE_CONFIRM_STOP = 'confirm_stop';

// --- Обработчики команд Telegram ---

// Команда /start - начальная точка входа для пользователя
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    // Проверка доступа по CHAT_ID
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }
    userStates[chatId] = USER_STATE_MAIN; // Устанавливаем начальное состояние пользователя
    await sendMessageWithKeyboard(chatId, 'Привет! Я бот для мониторинга и управления PM2. Выберите категорию:', mainKeyboard, { parse_mode: 'Markdown' });
});

// --- Обработка кнопок главного меню ---
bot.onText(/🛠️ Управление/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = USER_STATE_MANAGEMENT; // Изменяем состояние пользователя на "управление"
    await sendMessageWithKeyboard(chatId, 'Вы в меню управления. Выберите действие:', managementKeyboard, { parse_mode: 'Markdown' });
});

bot.onText(/📊 Мониторинг/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = USER_STATE_MONITORING; // Изменяем состояние пользователя на "мониторинг"
    await sendMessageWithKeyboard(chatId, 'Вы в меню мониторинга. Выберите информацию:', monitoringKeyboard, { parse_mode: 'Markdown' });
});

bot.onText(/❓ Помощь/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    await sendTelegramMessage(chatId, 'Привет! Я бот для логов PM2. Используйте кнопки для взаимодействия. Вот что я могу:\n' +
        '- *Управление*: Перезапуск, остановка, запуск вашего приложения.\n' +
        '- *Мониторинг*: Проверка статуса, логов, состояния системы и списка всех PM2 приложений.\n' +
        '- *Помощь*: Получить это сообщение.\n\n' +
        'Чтобы вернуться в главное меню, нажмите "⬅️ Назад в Главное меню".', { parse_mode: 'Markdown' });
});

// Кнопка "Назад" для возврата в главное меню (работает из любого подменю)
bot.onText(/⬅️ Назад в Главное меню/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;
    userStates[chatId] = USER_STATE_MAIN; // Возвращаем состояние пользователя в "главное"
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в главное меню. Выберите категорию:', mainKeyboard, { parse_mode: 'Markdown' });
});

// --- Обработка команд из подменю "Мониторинг" ---
bot.onText(/📈 Статус приложения/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }
    await checkPm2AppStatus(chatId); // Вызываем функцию из pm2_monitor.js
});

bot.onText(/📄 Последние (\d+) логов|📄 Последние 20 логов/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }

    const linesToFetch = match && match[1] ? parseInt(match[1], 10) : 20;

    if (isNaN(linesToFetch) || linesToFetch <= 0) {
        await sendTelegramMessage(chatId, 'Пожалуйста, укажите корректное число строк (например: /logs 50)', { parse_mode: 'Markdown' });
        return;
    }

    await sendTelegramMessage(chatId, `Запрашиваю последние ${linesToFetch} строк логов для ${PM2_APP_NAME}...`, { parse_mode: 'Markdown' });

    // Чтение логов из файлов OUT и ERR
    readLastLines(LOG_FILE_OUT, linesToFetch, async (err, outLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении OUT логов: ${err.message}`, { parse_mode: 'Markdown' });
            return;
        }
        await sendTelegramMessage(chatId, `[OUT - *${PM2_APP_NAME}* - ЗАПРОС ${linesToFetch}]\n\`\`\`\n${outLogs || 'Нет записей в OUT логе.'}\n\`\`\``, { parse_mode: 'MarkdownV2' });
    });

    readLastLines(LOG_FILE_ERR, linesToFetch, async (err, errLogs) => {
        if (err) {
            await sendTelegramMessage(chatId, `Ошибка при чтении ERR логов: ${err.message}`, { parse_mode: 'Markdown' });
            return;
        }
        await sendTelegramMessage(chatId, `[ERR - *${PM2_APP_NAME}* - ЗАПРОС ${linesToFetch}]\n\`\`\`\n${errLogs || 'Нет записей в ERR логе.'}\n\`\`\``, { parse_mode: 'MarkdownV2' });
    });
});

bot.onText(/🩺 Проверить систему/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }
    await sendTelegramMessage(chatId, 'Выполняю ручную проверку состояния системы...', { parse_mode: 'Markdown' });
    await checkSystemHealth(chatId);
});

bot.onText(/📋 Список всех приложений/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }
    await listAllPm2Apps(chatId);
});


// --- Обработка команд из подменю "Управление" ---

// Обработчик для перезапуска: запрашивает пароль
bot.onText(/🔄 Перезапустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.', { parse_mode: 'Markdown' });
        return;
    }
    userStates[chatId] = USER_STATE_AWAITING_PASSWORD_RESTART; // Устанавливаем состояние ожидания пароля для перезапуска
    await sendTelegramMessage(chatId, 'Введите административный пароль для *перезапуска* сервера:', { parse_mode: 'Markdown' });
});

// Обработчик для остановки: запрашивает пароль
bot.onText(/⏹️ Остановить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.', { parse_mode: 'Markdown' });
        return;
    }
    userStates[chatId] = USER_STATE_AWAITING_PASSWORD_STOP; // Устанавливаем состояние ожидания пароля для остановки
    await sendTelegramMessage(chatId, 'Введите административный пароль для *остановки* сервера:', { parse_mode: 'Markdown' });
});

bot.onText(/▶️ Запустить сервер/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет прав на выполнение этой команды.', { parse_mode: 'Markdown' });
        return;
    }
    await startPm2App(chatId);
});


// --- Универсальный обработчик текстовых сообщений (для пароля) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Игнорируем команды, кнопки (которые обрабатываются onText) и сообщения от неавторизованных пользователей
    if (msg.text.startsWith('/') || String(chatId) !== String(CHAT_ID) || !text) {
        return;
    }

    const currentState = userStates[chatId];

    // Обработка ввода пароля для перезапуска
    if (currentState === USER_STATE_AWAITING_PASSWORD_RESTART) {
        if (text === ADMIN_PASSWORD) {
            userStates[chatId] = USER_STATE_CONFIRM_RESTART; // Переход к подтверждению после верного пароля
            await sendMessageWithKeyboard(chatId, 'Пароль верный. Вы уверены, что хотите *перезапустить* сервер? Это может прервать текущие операции.', confirmationKeyboard, { parse_mode: 'Markdown' });
        } else {
            userStates[chatId] = USER_STATE_MANAGEMENT; // Сброс состояния после неверного ввода
            await sendTelegramMessage(chatId, 'Неверный пароль. Действие отменено.', { parse_mode: 'Markdown' });
            await sendMessageWithKeyboard(chatId, 'Возвращаемся в меню управления.', managementKeyboard, { parse_mode: 'Markdown' });
        }
        return; // Обработали сообщение, выходим
    }

    // Обработка ввода пароля для остановки
    if (currentState === USER_STATE_AWAITING_PASSWORD_STOP) {
        if (text === ADMIN_PASSWORD) {
            userStates[chatId] = USER_STATE_CONFIRM_STOP; // Переход к подтверждению после верного пароля
            await sendMessageWithKeyboard(chatId, 'Пароль верный. Вы уверены, что хотите *остановить* сервер? Это полностью остановит работу приложения!', confirmationKeyboard, { parse_mode: 'Markdown' });
        } else {
            userStates[chatId] = USER_STATE_MANAGEMENT; // Сброс состояния после неверного ввода
            await sendTelegramMessage(chatId, 'Неверный пароль. Действие отменено.', { parse_mode: 'Markdown' });
            await sendMessageWithKeyboard(chatId, 'Возвращаемся в меню управления.', managementKeyboard, { parse_mode: 'Markdown' });
        }
        return; // Обработали сообщение, выходим
    }

    // Если сообщение не является паролем для ожидаемых действий и не является кнопкой
    // (кнопки обрабатываются bot.onText автоматически), то это может быть произвольный текст.
    // Вы можете добавить сюда логику для обработки других текстовых сообщений,
    // если они не должны быть обработаны как команды или пароли.
    // Например, можно просто игнорировать или отвечать "Неизвестная команда".
    // В данном случае, если это не команда и не пароль, оно просто игнорируется,
    // так как других обработчиков произвольного текста нет.
});


// --- Обработка кнопок подтверждения "Да" и "Нет" ---
bot.onText(/✅ Да/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }

    const currentState = userStates[chatId];
    if (currentState === USER_STATE_CONFIRM_RESTART) {
        await restartPm2App(chatId);
    } else if (currentState === USER_STATE_CONFIRM_STOP) {
        await stopPm2App(chatId);
    } else {
        await sendTelegramMessage(chatId, 'Не могу определить, какое действие нужно подтвердить. Пожалуйста, попробуйте еще раз.', { parse_mode: 'Markdown' });
    }

    // Возвращаемся в меню управления после выполнения действия
    userStates[chatId] = USER_STATE_MANAGEMENT;
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в меню управления. Выберите действие:', managementKeyboard, { parse_mode: 'Markdown' });
});

bot.onText(/❌ Нет/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) {
        await sendTelegramMessage(chatId, 'Извините, у вас нет доступа к этому боту.', { parse_mode: 'Markdown' });
        return;
    }

    await sendTelegramMessage(chatId, 'Действие отменено.', { parse_mode: 'Markdown' });
    // Возвращаемся в меню управления
    userStates[chatId] = USER_STATE_MANAGEMENT;
    await sendMessageWithKeyboard(chatId, 'Возвращаемся в меню управления. Выберите действие:', managementKeyboard, { parse_mode: 'Markdown' });
});


// --- Запуск системных проверок и мониторинга логов ---
// Периодическая проверка состояния системы
setInterval(() => checkSystemHealth(CHAT_ID), CHECK_INTERVAL_MS);

// Подключение к PM2 для прослушивания событий
connectAndListenPm2Events();

// Запуск отслеживания файлов логов
startLogWatcher();

console.log('PM2 Log & Status Telegram Bot is running and listening for commands and events...');

// Обработка ошибок опроса Telegram API
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
    // Дополнительная обработка ошибок: например, отправка уведомления администратору
    sendTelegramMessage(CHAT_ID, `🔴 Ошибка опроса Telegram API: ${error.message}`, { parse_mode: 'Markdown' });
});