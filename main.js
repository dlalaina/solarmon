#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const mysql = require('mysql2/promise');

const growattApi = require('./growattApi');
const solarmanApi = require('./solarmanApi'); // NOVO: Importa a API Solarman
const database = require('./database');
const alarmManager = require('./alarmManager');
const telegramNotifier = require('./telegramNotifier');
const { checkAndManageAlarms } = require('./alarmManager');
const { getFormattedTimestamp } = require('./utils');

// --- Carrega Credenciais de arquivo externo ---
let credentials;
try {
  credentials = require('./credentials.json');
} catch (error) {
  console.error(`[${getFormattedTimestamp()}] ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.`);
  console.error(error.message);
  process.exit(1); // Sai do script se as credenciais não puderem ser carregadas
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

// Diretórios
const logs_dir = path.join(__dirname, 'logs');
const raw_data_dir = path.join(__dirname, 'raw_data'); // Define raw_data_dir aqui

// Função para buscar a configuração da planta do banco de dados
async function getPlantConfig(dbPool) {
    let connection;
    try {
        connection = await dbPool.getConnection();
        const [rows] = await connection.execute('SELECT plant_name, inverter_id, api_type FROM plant_config');
        return rows;
    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] Erro ao buscar plant_config:`, error.message);
        throw new Error(`Falha ao carregar configuração da planta do MySQL: ${error.message}`);
    } finally {
        if (connection) connection.release();
    }
}

// NOVO: Função para atualizar o status do servidor Growatt no banco de dados
async function updateGrowattServerStatus(dbPool, isSuccess) {
    let connection;
    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const GROWATT_RECOVERY_GRACE_PERIOD_MINUTES = 18; // Deve ser a mesma constante definida em alarmManager.js

        if (isSuccess) {
            // Se a chamada à API da Growatt foi bem-sucedida
            await connection.execute(`
                INSERT INTO growatt_server_status (id, last_successful_api_call, last_api_status, recovery_grace_period_until)
                VALUES (1, NOW(), 'OK', NULL)
                ON DUPLICATE KEY UPDATE
                    last_successful_api_call = NOW(),
                    last_api_status = 'OK',
                    recovery_grace_period_until = CASE
                        WHEN last_api_status = 'ERROR' THEN NOW() + INTERVAL ? MINUTE
                        ELSE recovery_grace_period_until
                    END;
            `, [GROWATT_RECOVERY_GRACE_PERIOD_MINUTES]);
            console.log(`[${getFormattedTimestamp()}] Status do servidor Growatt atualizado para SUCESSO.`);
        } else {
            // Se a chamada à API da Growatt falhou
            await connection.execute(`
                INSERT INTO growatt_server_status (id, last_successful_api_call, last_api_status, recovery_grace_period_until)
                VALUES (1, NULL, 'ERROR', NULL)
                ON DUPLICATE KEY UPDATE
                    last_api_status = 'ERROR',
                    recovery_grace_period_until = NULL;
            `);
            console.error(`[${getFormattedTimestamp()}] Status do servidor Growatt atualizado para ERRO.`);
        }

        await connection.commit();
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        console.error(`[${getFormattedTimestamp()}] Erro ao atualizar o status do servidor Growatt no banco de dados:`, error.message);
        // Não relança o erro aqui para não parar o fluxo principal,
        // mas é importante logá-lo.
    } finally {
        if (connection) {
            connection.release();
        }
    }
}


// Função principal de recuperação e processamento de dados
async function retrieveAndProcessData() {
  try {
    // Garante que o diretório raw_data exista
    await fs.mkdir(raw_data_dir, { recursive: true });

    // --- Busca de Dados GROWATT ---
    console.log(`[${getFormattedTimestamp()}] Iniciando busca de dados Growatt...`);
    let growattApiSuccess = false; // Flag para rastrear o sucesso da API Growatt

    try {
        const growatt = await growattApi.login(credentials.growatt.user, credentials.growatt.password);
        console.log(`[${getFormattedTimestamp()}] Login Growatt realizado com sucesso.`);

        const growattOptions = {
            plantData: true,
            deviceData: true,
            deviceType: true,
            weather: false,
            chartLastArray: true,
        };
        const getAllPlantDataRaw = await growattApi.getAllPlantData(growatt, growattOptions);
        const growattDataForProcessing = { plants: getAllPlantDataRaw };

        const growattFullFilePath = path.join(raw_data_dir, `growatt_full_${require('./utils').getFormattedDateForFilename()}.json`);
        await fs.writeFile(growattFullFilePath, JSON.stringify(growattDataForProcessing, null, ' '));
        console.log(`[${getFormattedTimestamp()}] Dados brutos Growatt salvos em ${growattFullFilePath}`);

        // Inserir dados Growatt no MySQL
        await database.insertDataIntoMySQL(pool, growattDataForProcessing);
        console.log(`[${getFormattedTimestamp()}] Dados Growatt inseridos/atualizados no MySQL.`);

        try {
            await growattApi.logout(growatt);
            console.log(`[${getFormattedTimestamp()}] Logout Growatt realizado com sucesso.`);
        } catch (logoutError) {
            console.warn(`[${getFormattedTimestamp()}] Falha ao deslogar da Growatt:`, logoutError.message);
        }
        growattApiSuccess = true; // Marca como sucesso
    } catch (growattError) {
        console.error(`[${getFormattedTimestamp()}] Erro durante a busca de dados Growatt:`, growattError.message);
        growattApiSuccess = false; // Marca como falha
        // Não relança o erro aqui para permitir o processamento Solarman e o gerenciamento de alarmes.
    } finally {
        // NOVO: Atualiza o status do servidor Growatt no DB, independentemente do sucesso
        await updateGrowattServerStatus(pool, growattApiSuccess);
        console.log(`[${getFormattedTimestamp()}] Busca de dados Growatt concluída.`);
    }

    // --- Busca de Dados SOLARMAN --- NOVO BLOCO
    console.log(`[${getFormattedTimestamp()}] Iniciando busca de dados Solarman...`);
    const plantConfigs = await getPlantConfig(pool); // Busca todas as configurações de plantas
    const solarmanInverters = plantConfigs.filter(config => config.api_type === 'Solarman'); // Filtra inversores Solarman

    if (solarmanInverters.length > 0) {
        // Obtém o token Solarman uma vez para todas as requisições de dados
        const solarmanToken = await solarmanApi.getSolarmanToken(
            credentials.solarman.appId,
            credentials.solarman.appSecret,
            credentials.solarman.email,
            credentials.solarman.password_sha256,
            credentials.solarman.orgId
        );
        console.log(`[${getFormattedTimestamp()}] Token Solarman obtido para acesso aos inversores.`);

        const solarmanRawData = {}; // Objeto para armazenar todos os dados brutos da Solarman
        for (const inverter of solarmanInverters) {
            try {
                const deviceSn = inverter.inverter_id;
                const data = await solarmanApi.getSolarmanCurrentData(solarmanToken, deviceSn);
                solarmanRawData[deviceSn] = data; // Armazena dados brutos pelo número de série (deviceSn)
                console.log(`[${getFormattedTimestamp()}] Dados Solarman para ${deviceSn} coletados.`);
            } catch (solarmanFetchError) {
                console.error(`[${getFormattedTimestamp()}] Erro ao buscar dados Solarman para ${inverter.inverter_id}:`, solarmanFetchError.message);
                // Continua para o próximo inversor mesmo se um falhar
            }
        }

        const solarmanFullFilePath = path.join(raw_data_dir, `solarman_full_${require('./utils').getFormattedDateForFilename()}.json`);
        await fs.writeFile(solarmanFullFilePath, JSON.stringify(solarmanRawData, null, ' '));
        console.log(`[${getFormattedTimestamp()}] Dados brutos Solarman salvos em ${solarmanFullFilePath}`);

        // --- PREPARAR DADOS SOLARMAN PARA database.insertDataIntoMySQL ---
        // Construir a estrutura esperada por database.js: { plants: { "plant_name": { plantName: "...", devices: { "inverter_id": {...} } } } }
        const solarmanPlantsData = {};
        for (const inverter of solarmanInverters) {
            const plantName = inverter.plant_name;
            const deviceSn = inverter.inverter_id;

            if (solarmanRawData[deviceSn]) { // Garante que temos dados brutos para este inversor
                if (!solarmanPlantsData[plantName]) {
                    solarmanPlantsData[plantName] = {
                        plantName: plantName,
                        devices: {}
                    };
                }
                solarmanPlantsData[plantName].devices[deviceSn] = solarmanRawData[deviceSn];
            } else {
                console.warn(`[${getFormattedTimestamp()}] Aviso: Dados brutos não encontrados para o inversor Solarman ${deviceSn}. Pulando processamento para este inversor.`);
            }
        }

        const solarmanDataForProcessing = { plants: solarmanPlantsData }; // Encapsula em 'plants'

        // Inserir dados Solarman no MySQL
        await database.insertDataIntoMySQL(pool, solarmanDataForProcessing);
        console.log(`[${getFormattedTimestamp()}] Dados Solarman inseridos/atualizados no MySQL.`);

    } else {
        console.log(`[${getFormattedTimestamp()}] Nenhuma planta Solarman configurada em 'plant_config'. Pulando busca de dados Solarman.`);
    }
    console.log(`[${getFormattedTimestamp()}] Busca de dados Solarman concluída.`);


    // --- Gerenciamento de Alarmes ---
    await checkAndManageAlarms(pool, credentials.telegram.chatId);
    console.log(`[${getFormattedTimestamp()}] Verificação e gerenciamento de alarmes concluído.`);

  } catch (error) {
    console.error(`[${getFormattedTimestamp()}] Erro durante a recuperação/processamento de dados:`, error.message);
    await fs.writeFile(path.join(logs_dir, 'error.log'), `[${getFormattedTimestamp()}] Erro de recuperação/processamento: ${error.stack}\n`, { flag: 'a' });
    throw error; // Re-throw para ser capturado pela IIFE principal
  }
}

// Função Assíncrona Invocada Imediatamente (IIFE) para executar o script
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
    await telegramNotifier.sendTelegramMessage(`🔥 <b>ERRO CRÍTICO NA EXECUÇÃO DO SCRIPT!</b> 🔥\nDetalhes: ${error.message}\\nVerifique o log para mais informações.`);
  } finally {
    if (pool) {
      await pool.end();
      console.log(`[${getFormattedTimestamp()}] Conexão com o banco de dados encerrada.`);
    }
    console.timeEnd('Execução total');
  }
})();

