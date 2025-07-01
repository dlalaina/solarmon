const path = require('path');
const mysql = require('mysql2/promise');

const logger = require('./logger')('email');
const telegramNotifier = require('./telegramNotifier');
const emailProcessor = require('./emailProcessor');
const diagnosticLogger = require('./diagnosticLogger');

/**
 * Processa e-mails de alerta da Growatt e Solarman.
 * @param {mysql.Pool} pool - O pool de conexões MySQL já inicializado.
 * @param {object} credentials - O objeto de credenciais carregado.
 */
async function processAllEmails(pool, credentials) {
    const adminChatId = credentials.telegram.chatId;

    // imapConfig precisa ser definido aqui para ter acesso às credenciais.
    const imapConfig = {
        user: credentials.email.user,
        password: credentials.email.password,
        host: credentials.email.host,
        port: credentials.email.port,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        timeout: 30000
    };

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
}

module.exports = {
    processAllEmails
};
