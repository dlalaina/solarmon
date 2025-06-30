#!/usr/bin/env node

const path = require('path');
const mysql = require('mysql2/promise');

const logger = require('./logger')('email');
const telegramNotifier = require('./telegramNotifier');
const emailProcessor = require('./emailProcessor');
const diagnosticLogger = require('./diagnosticLogger');

let credentials;
try {
    credentials = require('./credentials.json');
} catch (error) {
    logger.error("ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.");
    logger.error(error.stack);
    process.exit(1);
}

const dbConfig = {
    host: credentials.mysql.host,
    user: credentials.mysql.user,
    password: credentials.mysql.password,
    database: credentials.mysql.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
};

let pool;

const imapConfig = {
    user: credentials.email.user,
    password: credentials.email.password,
    host: credentials.email.host,
    port: credentials.email.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    timeout: 30000
};

(async () => {
    const startTime = Date.now();
    try {
        pool = mysql.createPool(dbConfig);
        logger.info('Pool de conexão MySQL criado para processamento de e-mails.');

        telegramNotifier.init(credentials.telegram.botToken, credentials.telegram.chatId);
        const adminChatId = credentials.telegram.chatId; // Obtém o ID do chat do administrador

        // --- Processamento de e-mails Growatt ---
        logger.info('Iniciando processamento de e-mails Growatt.');
        await emailProcessor.processEmails(
            imapConfig,
            pool,
            telegramNotifier,
            diagnosticLogger,
            'growatt',
            'growatt_alert', // <--- Nova tag customizada para Growatt
            adminChatId // Passa o ID do chat do administrador
        );
        logger.info('Processamento de e-mails Growatt concluído.');

        // --- Processamento de e-mails Solarman ---
        logger.info('Iniciando processamento de e-mails Solarman.');
        await emailProcessor.processEmails(
            imapConfig,
            pool,
            telegramNotifier,
            diagnosticLogger,
            'solarman',
            'solarman_alert', // <--- Nova tag customizada para Solarman
            adminChatId // Passa o ID do chat do administrador
        );
        logger.info('Processamento de e-mails Solarman concluído.');

    } catch (error) {
        logger.error(`Erro fatal na execução do script de e-mail: ${error.stack}`);
        await telegramNotifier.sendTelegramMessage(`🔥 <b>ERRO CRÍTICO NO SCRIPT DE E-MAIL!</b> 🔥\nDetalhes: ${error.message}\nVerifique o log para mais informações.`);
    } finally {
        if (pool) {
            await pool.end();
            logger.info('Pool de conexão MySQL encerrado para processamento de e-mails.');
        }
        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(3);
        logger.info(`Execução total (processEmailAlarms): ${duration}s`);
    }
})();
