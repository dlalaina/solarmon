#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { promisify } = require('util');
const mysql = require('mysql2/promise');

const growattApi = require('./growattApi');
const solarmanApi = require('./solarmanApi'); // NOVO: Importa a API Solarman
const database = require('./database');
const logger = require('./logger')('main');
const telegramNotifier = require('./telegramNotifier');
const { processAllEmails } = require('./processEmailAlarms'); // <-- ADICIONAR
const { checkAndManageAlarms, GROWATT_RECOVERY_GRACE_PERIOD_MINUTES } = require('./alarmManager');

const gzip = promisify(zlib.gzip);

// --- Carrega Credenciais de arquivo externo ---
let credentials;
try {
  credentials = require('./credentials.json');
} catch (error) {
  logger.error("ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.");
  logger.error(error.stack);
  process.exit(1); // Sai do script se as credenciais não puderem ser carregadas
}

// Helper function to format the date as YYYYMMDDHHmm
function getFormattedDateForFilename() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}`;
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
const raw_data_dir = path.join(__dirname, 'raw_data'); // Define raw_data_dir aqui

/**
 * Manages raw data files: compresses yesterday's files and deletes files older than 30 days.
 */
async function manageRawDataFiles() {
    logger.info('Iniciando gerenciamento de arquivos de dados brutos...');
    try {
        const files = await fs.readdir(raw_data_dir);
        const now = new Date();
        const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));
        now.setDate(now.getDate() + 30); // Reset 'now' to the original date
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayDateString = `${yesterday.getFullYear()}${String(yesterday.getMonth() + 1).padStart(2, '0')}${String(yesterday.getDate()).padStart(2, '0')}`;

        for (const file of files) {
            const filePath = path.join(raw_data_dir, file);
            const fileStats = await fs.stat(filePath);

            // 1. Deletar arquivos com mais de 30 dias
            if (fileStats.mtime < thirtyDaysAgo) {
                await fs.unlink(filePath);
                logger.info(`Arquivo antigo deletado: ${file}`);
                continue; // Pula para o próximo arquivo
            }

            // 2. Compactar arquivos .json de ontem
            if (file.endsWith('.json') && file.includes(yesterdayDateString)) {
                try {
                    const fileContent = await fs.readFile(filePath);
                    const compressedContent = await gzip(fileContent);
                    const newFilePath = `${filePath}.gz`;
                    
                    await fs.writeFile(newFilePath, compressedContent);
                    logger.info(`Arquivo compactado: ${file} -> ${file}.gz`);

                    await fs.unlink(filePath);
                    logger.info(`Arquivo original removido: ${file}`);

                } catch (compressionError) {
                    logger.error(`Erro ao compactar ou remover o arquivo ${file}: ${compressionError.message}`);
                }
            }
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(`Diretório raw_data não encontrado. Será criado na próxima execução.`);
        } else {
            logger.error(`Erro ao gerenciar arquivos de dados brutos: ${error.message}`);
        }
    }
    logger.info('Gerenciamento de arquivos de dados brutos concluído.');
}

// Função para buscar a configuração da planta do banco de dados
async function getPlantConfig(dbPool) {
    let connection;
    try {
        connection = await dbPool.getConnection();
        const [rows] = await connection.execute('SELECT plant_name, inverter_id, api_type FROM plant_config');
        return rows;
    } catch (error) {
        logger.error(`Erro ao buscar plant_config: ${error.message}`);
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
            logger.info('Status do servidor Growatt atualizado para SUCESSO.');
        } else {
            // Se a chamada à API da Growatt falhou
            await connection.execute(`
                INSERT INTO growatt_server_status (id, last_successful_api_call, last_api_status, recovery_grace_period_until)
                VALUES (1, NULL, 'ERROR', NULL)
                ON DUPLICATE KEY UPDATE
                    last_api_status = 'ERROR',
                    recovery_grace_period_until = NULL;
            `);
            logger.error('Status do servidor Growatt atualizado para ERRO.');
        }

        await connection.commit();
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        logger.error(`Erro ao atualizar o status do servidor Growatt no banco de dados: ${error.message}`);
        // Não relança o erro aqui para não parar o fluxo principal,
        // mas é importante logá-lo.
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

/**
 * Fetches, processes, and stores data from the Growatt API.
 * @param {mysql.Pool} dbPool - The MySQL connection pool.
 */
async function processGrowattData(dbPool) {
    logger.info('Iniciando busca de dados Growatt...');
    let growattApiSuccess = false;

    try {
        const growatt = await growattApi.login(credentials.growatt.user, credentials.growatt.password);
        logger.info('Login Growatt realizado com sucesso.');

        // Buscar a configuração local para verificar se os inversores da API estão configurados
        const plantConfigs = await getPlantConfig(dbPool);
        const configuredInverters = new Set(
            plantConfigs.map(pc => `${pc.plant_name}_${pc.inverter_id}`)
        );

        // Obter todos os dados da planta da API Growatt
        const growattOptions = {
            plantData: true,
            deviceData: true,
            deviceType: true,
            weather: false,
            chartLastArray: true,
        };
        const getAllPlantDataRaw = await growattApi.getAllPlantData(growatt, growattOptions);

        // Iterar sobre os dados da API para encontrar inversores não configurados
        for (const plantData of Object.values(getAllPlantDataRaw)) {
            const plantName = plantData.plantName;
            if (plantData.devices) {
                // A chave do objeto 'devices' é o serial number (inverter_id).
                // O código anterior iterava sobre os valores (Object.values) e tentava ler
                // uma propriedade 'deviceSn' que não existe no objeto de valor, resultando em 'undefined'.
                // A correção é iterar sobre as chaves (Object.keys) para obter o inverterId diretamente.
                for (const inverterId of Object.keys(plantData.devices)) {
                    const configKey = `${plantName}_${inverterId}`;
                    if (!configuredInverters.has(configKey)) {
                        logger.warn(`Planta ${plantName} Inversor ${inverterId} (Growatt) não configurado na tabela plant_config.`);
                    }
                }
            }
        }

        const growattDataForProcessing = { plants: getAllPlantDataRaw };

        const growattFullFilePath = path.join(raw_data_dir, `growatt_full_${getFormattedDateForFilename()}.json`);
        await fs.writeFile(growattFullFilePath, JSON.stringify(growattDataForProcessing, null, ' '));
        logger.info(`Dados brutos Growatt salvos em ${growattFullFilePath}`);

        await database.insertDataIntoMySQL(dbPool, growattDataForProcessing);
        logger.info('Dados Growatt inseridos/atualizados no MySQL.');

        try {
            await growattApi.logout(growatt);
            logger.info('Logout Growatt realizado com sucesso.');
        } catch (logoutError) {
            logger.warn(`Falha ao deslogar da Growatt: ${logoutError.message}`);
        }
        growattApiSuccess = true;
    } catch (growattError) {
        logger.error(`Erro durante a busca de dados Growatt: ${growattError.message}`);
        growattApiSuccess = false;
    } finally {
        await updateGrowattServerStatus(dbPool, growattApiSuccess);
        logger.info('Busca de dados Growatt concluída.');
    }
}

/**
 * Fetches, processes, and stores data from the Solarman API.
 * @param {mysql.Pool} dbPool - The MySQL connection pool.
 */
async function processSolarmanData(dbPool) {
    logger.info('Iniciando busca de dados Solarman...');
    try {
        const plantConfigs = await getPlantConfig(dbPool);
        const solarmanInverters = plantConfigs.filter(config => config.api_type === 'Solarman');

        if (solarmanInverters.length === 0) {
            logger.info("Nenhuma planta Solarman configurada. Pulando busca.");
            return;
        }

        const solarmanToken = await solarmanApi.getSolarmanToken(
            credentials.solarman.appId,
            credentials.solarman.appSecret,
            credentials.solarman.email,
            credentials.solarman.password_sha256,
            credentials.solarman.orgId
        );
        logger.info('Token Solarman obtido para acesso aos inversores.');

        const solarmanRawData = {};
        for (const inverter of solarmanInverters) {
            try {
                const deviceSn = inverter.inverter_id;
                const data = await solarmanApi.getSolarmanCurrentData(solarmanToken, deviceSn);
                solarmanRawData[deviceSn] = data;
                logger.info(`Dados Solarman para ${deviceSn} coletados.`);
            } catch (solarmanFetchError) {
                logger.error(`Erro ao buscar dados Solarman para ${inverter.inverter_id}: ${solarmanFetchError.message}`);
            }
        }

        if (Object.keys(solarmanRawData).length > 0) {
            const solarmanFullFilePath = path.join(raw_data_dir, `solarman_full_${getFormattedDateForFilename()}.json`);
            await fs.writeFile(solarmanFullFilePath, JSON.stringify(solarmanRawData, null, ' '));
            logger.info(`Dados brutos Solarman salvos em ${solarmanFullFilePath}`);

            const solarmanPlantsData = {};
            for (const inverter of solarmanInverters) {
                const plantName = inverter.plant_name;
                const deviceSn = inverter.inverter_id;

                if (solarmanRawData[deviceSn]) {
                    if (!solarmanPlantsData[plantName]) {
                        solarmanPlantsData[plantName] = {
                            plantName: plantName,
                            devices: {}
                        };
                    }
                    solarmanPlantsData[plantName].devices[deviceSn] = solarmanRawData[deviceSn];
                }
            }
            const solarmanDataForProcessing = { plants: solarmanPlantsData };
            await database.insertDataIntoMySQL(dbPool, solarmanDataForProcessing);
            logger.info('Dados Solarman inseridos/atualizados no MySQL.');
        } else {
            logger.warn('Nenhum dado bruto da Solarman foi coletado com sucesso.');
        }
    } catch (solarmanError) {
        logger.error(`Erro durante a busca de dados Solarman: ${solarmanError.message}`);
    } finally {
        logger.info('Busca de dados Solarman concluída.');
    }
}

// Função principal de recuperação e processamento de dados
async function retrieveAndProcessData() {
  try {
    // Garante que o diretório raw_data exista
    await fs.mkdir(raw_data_dir, { recursive: true });

    // Executa as buscas de dados em paralelo para otimizar o tempo
    logger.info('Iniciando buscas de dados das APIs em paralelo...');
    const results = await Promise.allSettled([
        processGrowattData(pool),
        processSolarmanData(pool)
    ]);

    results.forEach((result, index) => {
        const apiName = index === 0 ? 'Growatt' : 'Solarman';
        if (result.status === 'rejected') {
            logger.error(`Processo da API ${apiName} falhou com erro: ${result.reason}`);
        }
    });
    logger.info('Buscas de dados em paralelo concluídas.');

    // --- Processamento de E-mails de Alerta ---
    try {
        logger.info('Iniciando processamento de e-mails de alerta...');
        await processAllEmails(pool, credentials);
        logger.info('Processamento de e-mails de alerta concluído.');
    } catch (emailError) {
        logger.error(`Erro durante o processamento de e-mails, mas o script principal continuará: ${emailError.stack}`);
    }

    // --- Gerenciamento de Alarmes ---
    await checkAndManageAlarms(pool, credentials.telegram.chatId);
    logger.info('Verificação e gerenciamento de alarmes concluído.');

  } catch (error) {
    logger.error(`Erro durante a recuperação/processamento de dados: ${error.stack}`);
    throw error; // Re-throw para ser capturado pela IIFE principal
  }
}

// Função Assíncrona Invocada Imediatamente (IIFE) para executar o script
(async () => {
  const startTime = Date.now();
  try {
    // Inicializa o pool de conexão MySQL
    pool = mysql.createPool(dbConfig);
    logger.info('Pool de conexão MySQL criado.');

    // Configura o notifier do Telegram para usar as credenciais
    telegramNotifier.init(credentials.telegram.botToken, credentials.telegram.chatId);

    // Executa o gerenciamento dos arquivos de dados brutos
    await manageRawDataFiles();

    await retrieveAndProcessData();

  } catch (error) {
    logger.error(`Erro fatal na execução: ${error.stack}`);
    await telegramNotifier.sendTelegramMessage(`🔥 <b>ERRO CRÍTICO NA EXECUÇÃO DO SCRIPT!</b> 🔥\nDetalhes: ${error.message}\nVerifique o log para mais informações.`);
  } finally {
    if (pool) {
      await pool.end();
      logger.info('Conexão com o banco de dados encerrada.');
    }
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(3);
    logger.info(`Execução total: ${duration}s`);
  }
})();
