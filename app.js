#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const mysql = require('mysql2/promise');

const growattApi = require('./growattApi');
const database = require('./database');
const alarmManager = require('./alarmManager');
const telegramNotifier = require('./telegramNotifier');
const { getFormattedTimestamp } = require('./utils');

// --- Load Credentials from external file ---
let credentials;
try {
  credentials = require('./credentials.json');
} catch (error) {
  console.error(`[${getFormattedTimestamp()}] ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.`);
  console.error(error.message);
  process.exit(1); // Exit the script if credentials cannot be loaded
}

// Configurações e pool do banco de dados
const dbConfig = {
  host: credentials.mysql.host,
  user: credentials.mysql.user,
  password: credentials.mysql.password,
  database: credentials.mysql.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};
let pool; // Declarado aqui para ser acessível em outras funções

// Diretório de logs
const logs_dir = path.join(__dirname, 'logs');

// Função principal de recuperação e processamento de dados
async function retrieveAndProcessData() {
  try {
    // Login na API Growatt
    const growatt = await growattApi.login(credentials.growatt.user, credentials.growatt.password);
    console.log(`[${getFormattedTimestamp()}] Login Growatt realizado com sucesso.`);

    // Recuperar todos os dados da planta
    const growattOptions = {
      plantData: true,
      deviceData: true,
      deviceType: true,
      weather: false,
      chartLastArray: true,
    };
    const getAllPlantDataRaw = await growattApi.getAllPlantData(growatt, growattOptions);
    const dataForProcessing = { plants: getAllPlantDataRaw };

    // Salvar dados brutos em arquivo
    const raw_data_dir = path.join(__dirname, 'raw_data');
    await fs.mkdir(raw_data_dir, { recursive: true });
    const fullFilePath = path.join(raw_data_dir, `full_${require('./utils').getFormattedDateForFilename()}.json`);
    await fs.writeFile(fullFilePath, JSON.stringify(dataForProcessing, null, ' '));
    console.log(`[${getFormattedTimestamp()}] Dados brutos salvos em ${fullFilePath}`);

    // Inserir dados no MySQL
    await database.insertDataIntoMySQL(pool, dataForProcessing);
    console.log(`[${getFormattedTimestamp()}] Dados Growatt inseridos/atualizados no MySQL.`);

    // Verificar e gerenciar alarmes
    await alarmManager.checkAndManageAlarms(pool);
    console.log(`[${getFormattedTimestamp()}] Verificação e gerenciamento de alarmes concluído.`);

    // Logout da API Growatt
    try {
      await growattApi.logout(growatt);
      console.log(`[${getFormattedTimestamp()}] Logout Growatt realizado com sucesso.`);
    } catch (logoutError) {
      console.warn(`[${getFormattedTimestamp()}] Falha ao deslogar da Growatt:`, logoutError.message);
    }

  } catch (error) {
    console.error(`[${getFormattedTimestamp()}] Erro durante a recuperação/processamento de dados:`, error.message);
    await fs.writeFile(path.join(logs_dir, 'error.log'), `[${getFormattedTimestamp()}] Erro de recuperação/processamento: ${error.stack}\n`, { flag: 'a' });
    throw error; // Re-throw to be caught by the main IIFE
  }
}

// Immediately Invoked Async Function (IIFE) to run the script
(async () => {
  console.time('Execução total');
  try {
    // Garante que o diretório de logs exista antes de qualquer outra operação
    await fs.mkdir(logs_dir, { recursive: true });

    // Inicializa o pool de conexão MySQL
    pool = mysql.createPool(dbConfig);
    console.log(`[${getFormattedTimestamp()}] Pool de conexão MySQL criado.`);

    // Configura o notifier do Telegram para usar as credenciais
    telegramNotifier.init(credentials.telegram.botToken, credentials.telegram.chatId);

    await retrieveAndProcessData();

  } catch (error) {
    console.error(`[${getFormattedTimestamp()}] Erro fatal na execução:`, error.message);
    await fs.writeFile(path.join(logs_dir, 'error.log'), `[${getFormattedTimestamp()}] Erro fatal: ${error.stack}\n`, { flag: 'a' });
    await telegramNotifier.sendTelegramMessage(`🔥 <b>ERRO CRÍTICO NA EXECUÇÃO DO SCRIPT!</b> 🔥\nDetalhes: ${error.message}\nVerifique o log para mais informações.`);
  } finally {
    if (pool) {
      await pool.end();
      console.log(`[${getFormattedTimestamp()}] Conexão com o banco de dados encerrada.`);
    }
    console.timeEnd('Execução total');
  }
})();
