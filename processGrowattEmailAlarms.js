#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const mysql = require('mysql2/promise');

const { getFormattedTimestamp } = require('./utils');
const telegramNotifier = require('./telegramNotifier');
const emailProcessor = require('./emailProcessor');
const diagnosticLogger = require('./diagnosticLogger');

const logs_dir = path.join(__dirname, 'logs');

let credentials;
try {
  credentials = require('./credentials.json');
} catch (error) {
  console.error(`[${getFormattedTimestamp()}] ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.`);
  console.error(error.message);
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

// --- IMAP Configuration for Zoho Mail (MOVIDO PARA AQUI) ---
// Aumentar o timeout de autenticação para 30 segundos (30000 ms)
const imapConfig = {
    user: credentials.email.user,
    password: credentials.email.password,
    host: credentials.email.host,
    port: credentials.email.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    timeout: 30000 // Aumenta o timeout para 30 segundos
};

(async () => {
  console.time('Execução total (processGrowattEmailAlarms)');
  try {
    await fs.mkdir(logs_dir, { recursive: true });

    pool = mysql.createPool(dbConfig);
    console.log(`[${getFormattedTimestamp()}] Pool de conexão MySQL criado para processamento de e-mails.`);

    telegramNotifier.init(credentials.telegram.botToken, credentials.telegram.chatId);

    await emailProcessor.processEmails(
      imapConfig, // Passando a configuração do IMAP
      pool,
      telegramNotifier,
      diagnosticLogger
    );

    console.log(`[${getFormattedTimestamp()}] Processamento de e-mails concluído.`);

  } catch (error) {
    console.error(`[${getFormattedTimestamp()}] Erro fatal na execução do script de e-mail:`, error.message);
    await fs.writeFile(path.join(logs_dir, 'error.log'), `[${getFormattedTimestamp()}] Erro fatal processGrowattEmailAlarms: ${error.stack}\n`, { flag: 'a' });
    await telegramNotifier.sendTelegramMessage(`🔥 <b>ERRO CRÍTICO NO SCRIPT DE E-MAIL!</b> 🔥\nDetalhes: ${error.message}\nVerifique o log para mais informações.`);
  } finally {
    if (pool) {
      await pool.end();
      console.log(`[${getFormattedTimestamp()}] Pool de conexão MySQL encerrado para processamento de e-mails.`);
    }
    console.timeEnd('Execução total (processGrowattEmailAlarms)');
  }
})();
