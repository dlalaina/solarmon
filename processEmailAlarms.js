const path = require('path');
const mysql = require('mysql2/promise');

const logger = require('./logger')('email');
const telegramNotifier = require('./telegramNotifier');
const emailProcessor = require('./emailProcessor');
const diagnosticLogger = require('./diagnosticLogger');

// Define um timeout global para o processamento de e-mails para evitar que o script principal trave.
const EMAIL_PROCESSING_TIMEOUT_MS = 60000; // 60 segundos

/**
 * Processa e-mails de alerta da Growatt e Solarman.
 * @param {mysql.Pool} pool - O pool de conexões MySQL já inicializado.
 * @param {object} credentials - O objeto de credenciais carregado.
 * @param {boolean} notifyOwners - Flag para habilitar/desabilitar notificação para proprietários.
 */
async function processAllEmails(pool, credentials, notifyOwners) {
    logger.info(`Iniciando processamento de todos os e-mails em PARALELO com um timeout de ${EMAIL_PROCESSING_TIMEOUT_MS / 1000}s por provedor.`);
    const adminChatId = credentials.telegram.chatId;

    // imapConfig precisa ser definido aqui para ter acesso às credenciais.
    const imapConfig = {
        user: credentials.email.user,
        password: credentials.email.password,
        host: credentials.email.host,
        port: credentials.email.port,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        socketTimeout: 30000, // Timeout de inatividade do socket após conexão
        connTimeout: 15000 // Timeout para estabelecer a conexão inicial (15 segundos)
    };

    // Array de provedores para processamento em paralelo
    const providersToProcess = [
        { name: 'Growatt', type: 'growatt', tag: 'growatt_alert' },
        { name: 'Solarman', type: 'solarman', tag: 'solarman_alert' }
    ];

    // Mapeia cada provedor para uma promessa de processamento com timeout
    const processingTasks = providersToProcess.map(provider => {
        // Usamos uma função assíncrona auto-executável (IIFE) para encapsular a lógica de cada provedor
        return (async () => {
            try {
                const processingPromise = emailProcessor.processEmails(
                    imapConfig,
                    pool,
                    telegramNotifier,
                    diagnosticLogger,
                    provider.type,
                    provider.tag,
                    adminChatId,
                    notifyOwners // Passa a flag para a função de processamento
                );

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Timeout no processamento de e-mails ${provider.name}`)), EMAIL_PROCESSING_TIMEOUT_MS)
                );

                await Promise.race([processingPromise, timeoutPromise]);
                logger.info(`Processamento de e-mails ${provider.name} concluído com sucesso.`);
            } catch (error) {
                logger.error(`Falha no processamento de e-mails ${provider.name} (pode ser timeout): ${error.message}`);
            }
        })();
    });

    // Aguarda a conclusão de todas as tarefas de processamento (seja sucesso, falha ou timeout)
    await Promise.all(processingTasks);
}

module.exports = {
    processAllEmails
};
