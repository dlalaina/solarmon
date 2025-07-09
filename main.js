#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { promisify } = require('util');
const mysql = require('mysql2/promise');

const growattApi = require('./growattApi');
const solarmanApi = require('./solarmanApi');
const solplanetApi = require('./solplanetApi'); // NOVO: Importa a API Solplanet
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
const logs_dir = path.join(__dirname, 'logs'); // Define logs_dir aqui

/**
 * Manages log files: compresses old .log files and deletes files older than 90 days.
 * This is necessary because short-lived cron processes may not trigger winston's internal rotation/cleanup.
 */
async function manageLogFiles() {
    logger.info('Iniciando gerenciamento de arquivos de log...');
    try {
        await fs.mkdir(logs_dir, { recursive: true }); // Ensure logs directory exists
        const files = await fs.readdir(logs_dir);
        const now = new Date();
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(now.getDate() - 90);

        // Get today's date string in YYYY-MM-DD format to avoid compressing the current day's log
        const todayDateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        for (const file of files) {
            const filePath = path.join(logs_dir, file);

            // Ignorar symlinks para evitar processá-los como arquivos
            const stats = await fs.lstat(filePath);
            if (stats.isSymbolicLink() || file.startsWith('schema_update')) {
                continue;
            }

            // 1. Deletar arquivos com mais de 90 dias (usa mtime do arquivo real)
            if (stats.mtime < ninetyDaysAgo) {
                await fs.unlink(filePath);
                logger.info(`Arquivo de log antigo deletado: ${file}`);
                continue; // Pula para o próximo arquivo
            }

            // 2. Compactar arquivos .log de dias anteriores.
            // O padrão de arquivo agora é 'categoria-YYYY-MM-DD.log'.
            const logFileRegex = /(.+)-(\d{4}-\d{2}-\d{2})\.log$/;
            const match = file.match(logFileRegex);

            // Apenas processa o arquivo se ele corresponder ao padrão E a data não for a de hoje.
            if (match && match[2] !== todayDateString) {
                try {
                    const fileContent = await fs.readFile(filePath);
                    const compressedContent = await gzip(fileContent);
                    await fs.writeFile(`${filePath}.gz`, compressedContent);
                    logger.info(`Arquivo de log compactado: ${file} -> ${file}.gz`);
                    await fs.unlink(filePath);
                } catch (compressionError) {
                    logger.error(`Erro ao compactar ou remover o arquivo de log ${file}: ${compressionError.message}`);
                }
            }
        }
    } catch (error) {
        logger.error(`Erro ao gerenciar arquivos de log: ${error.message}`);
    }
    logger.info('Gerenciamento de arquivos de log concluído.');
}

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

/**
 * Fetches, processes, and stores data from the Growatt API.
 * @param {mysql.Pool} dbPool - The MySQL connection pool.
 * @param {Array<Object>} plantConfigs - The pre-fetched plant configurations.
 */
async function processGrowattData(dbPool, plantConfigs) {
    logger.info('Iniciando busca de dados Growatt...');
    let growattApiSuccess = false;

    try {
        const growatt = await growattApi.login(credentials.growatt.user, credentials.growatt.password);
        logger.info('Login Growatt realizado com sucesso.');

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

        // --- VERIFICAÇÃO 1: Inversores na API que não estão no banco de dados ---
        for (const plantData of Object.values(getAllPlantDataRaw)) {
            const plantName = plantData.plantName;
            if (plantData.devices) {
                for (const inverterId of Object.keys(plantData.devices)) {
                    const configKey = `${plantName}_${inverterId}`;
                    if (!configuredInverters.has(configKey)) {
                        logger.warn(`Inversor da API não configurado localmente: Planta ${plantName}, Inversor ${inverterId} (Growatt). Considere adicioná-lo à plant_config.`);
                    }
                }
            }
        }

        // --- VERIFICAÇÃO 2: Inversores no banco de dados que não vieram na API ---
        // Criar um set de inversores que vieram da API para busca rápida
        const apiInverters = new Set();
        for (const plantData of Object.values(getAllPlantDataRaw)) {
            if (plantData.devices) {
                for (const inverterId of Object.keys(plantData.devices)) {
                    const apiConfigKey = `${plantData.plantName}_${inverterId}`;
                    apiInverters.add(apiConfigKey);
                }
            }
        }
        // Iterar sobre a configuração local e verificar se cada inversor está no set da API
        for (const config of plantConfigs) {
            // Verificar apenas para inversores do tipo Growatt
            if (config.api_type === 'Growatt') {
                const configKey = `${config.plant_name}_${config.inverter_id}`;
                if (!apiInverters.has(configKey)) {
                    logger.warn(`Inversor configurado não encontrado na API Growatt: Planta: ${config.plant_name}, Inversor: ${config.inverter_id}.`);
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
        await updateApiStatus(dbPool, 'Growatt', growattApiSuccess);
        logger.info('Busca de dados Growatt concluída.');
    }
}

/**
 * Fetches, processes, and stores data from the Solarman API.
 * @param {mysql.Pool} dbPool - The MySQL connection pool.
 * @param {Array<Object>} plantConfigs - The pre-fetched plant configurations.
 */
async function processSolarmanData(dbPool, plantConfigs) {
    logger.info('Iniciando busca de dados Solarman...');
    let solarmanApiSuccess = false;
    try {
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

        solarmanApiSuccess = true; // <-- CORREÇÃO: Define o sucesso aqui
    } catch (solarmanError) {
        solarmanApiSuccess = false;
        logger.error(`Erro durante a busca de dados Solarman: ${solarmanError.message}`);
    } finally {
        await updateApiStatus(dbPool, 'Solarman', solarmanApiSuccess);
        logger.info('Busca de dados Solarman concluída.');
    }
}

/**
 * Fetches, processes, and stores data from the Solplanet API.
 * @param {mysql.Pool} dbPool - The MySQL connection pool.
 * @param {Array<Object>} plantConfigs - The pre-fetched plant configurations.
 */
async function processSolplanetData(dbPool, plantConfigs) {
    logger.info('Iniciando busca de dados Solplanet...');

    if (credentials.solplanet.enabled === false) {
        logger.info('Busca de dados Solplanet desabilitada em credentials.json. Pulando.');
        return;
    }

    let solplanetApiSuccess = false;

    const solplanetInverters = plantConfigs.filter(config => config.api_type === 'Solplanet');

    if (solplanetInverters.length === 0) {
        logger.info("Nenhuma planta Solplanet configurada. Pulando busca.");
        return;
    }

    try {
        let solplanetToken = await solplanetApi.getAuthCredentials(credentials.solplanet.account, credentials.solplanet.pwd);

        const solplanetRawData = {};
        for (const inverter of solplanetInverters) {
            const deviceSn = inverter.inverter_id;
            try {
                const data = await solplanetApi.getInverterDetail(solplanetToken, deviceSn);
                solplanetRawData[deviceSn] = data;
                logger.info(`Dados Solplanet para ${deviceSn} coletados.`);
            } catch (solplanetFetchError) {
                // Verifica se o erro é de autenticação (token expirado/inválido)
                if (solplanetFetchError.response && (solplanetFetchError.response.status === 444 || solplanetFetchError.response.status === 401 || solplanetFetchError.response.status === 403)) {
                    logger.warn(`Falha de autenticação ao buscar dados para ${deviceSn}. Tentando renovar o token...`);
                    solplanetToken = await solplanetApi.forceTokenRefresh(credentials.solplanet.account, credentials.solplanet.pwd, solplanetFetchError);
                    
                    // Tenta novamente com o novo token
                    try {
                        logger.info(`Tentando novamente a busca de dados para ${deviceSn} com o novo token...`);
                        const data = await solplanetApi.getInverterDetail(solplanetToken, deviceSn);
                        solplanetRawData[deviceSn] = data;
                        logger.info(`Dados Solplanet para ${deviceSn} coletados com sucesso após renovação do token.`);
                    } catch (retryError) {
                        logger.error(`Erro ao buscar dados para ${deviceSn} mesmo após renovar o token: ${retryError.message}`);
                    }
                } else {
                    // Se for outro tipo de erro, apenas registra
                    logger.error(`Erro ao buscar dados Solplanet para ${deviceSn}: ${solplanetFetchError.message}`);
                }
            }
        }

        if (Object.keys(solplanetRawData).length > 0) {
            const solplanetFullFilePath = path.join(raw_data_dir, `solplanet_full_${getFormattedDateForFilename()}.json`);
            await fs.writeFile(solplanetFullFilePath, JSON.stringify(solplanetRawData, null, ' '));
            logger.info(`Dados brutos Solplanet salvos em ${solplanetFullFilePath}`);

            const solplanetPlantsData = {};
            for (const inverter of solplanetInverters) {
                const plantName = inverter.plant_name;
                const deviceSn = inverter.inverter_id;

                if (solplanetRawData[deviceSn]) {
                    if (!solplanetPlantsData[plantName]) {
                        solplanetPlantsData[plantName] = {
                            plantName: plantName,
                            devices: {}
                        };
                    }
                    solplanetPlantsData[plantName].devices[deviceSn] = solplanetRawData[deviceSn];
                }
            }
            const solplanetDataForProcessing = { plants: solplanetPlantsData };
            await database.insertDataIntoMySQL(dbPool, solplanetDataForProcessing);
            logger.info('Dados Solplanet inseridos/atualizados no MySQL.');
        } else {
            logger.warn('Nenhum dado bruto da Solplanet foi coletado com sucesso.');
        }
        solplanetApiSuccess = true;

    } catch (solplanetError) {
        logger.error(`Erro durante a busca de dados Solplanet: ${solplanetError.message}`);
        solplanetApiSuccess = false;
    } finally {
        await updateApiStatus(dbPool, 'Solplanet', solplanetApiSuccess);
        logger.info('Busca de dados Solplanet concluída.');
    }
}

/**
 * Lida com o cenário em que a chamada da API foi bem-sucedida.
 * @param {object} connection - Conexão com o banco de dados.
 * @param {string} apiName - Nome da API.
 * @param {object|null} existingStatus - O status atual da API no banco, se houver.
 */
async function handleApiSuccess(connection, apiName, existingStatus) {
    if (!existingStatus) {
        // Se não havia registro, significa que já estava OK, então não fazemos nada.
        return;
    }

    if (existingStatus.status === 'FAILING') {
        // A API estava falhando e agora se recuperou.
        logger.info(`API ${apiName} recuperada com sucesso.`);
        await telegramNotifier.sendTelegramMessage(
            `✅ <b>RECUPERAÇÃO DE API: ${apiName}</b> ✅\n\nA API voltou a funcionar normalmente.`
        );

        if (apiName === 'Growatt') {
            // Para Growatt, atualiza o status para 'OK' e define o período de carência.
            logger.info(`Iniciando período de carência de ${GROWATT_RECOVERY_GRACE_PERIOD_MINUTES} minutos para alarmes da Growatt.`);
            await connection.execute(
                'UPDATE api_status_monitor SET status = \'OK\', notification_sent = 0, recovery_grace_period_until = NOW() + INTERVAL ? MINUTE WHERE api_name = ?',
                [GROWATT_RECOVERY_GRACE_PERIOD_MINUTES, apiName]
            );
        } else {
            // Para outras APIs (Solarman), simplesmente remove o registro de falha.
            await connection.execute('DELETE FROM api_status_monitor WHERE api_name = ?', [apiName]);
        }
    } else if (existingStatus.status === 'OK' && apiName === 'Growatt') {
        // Se a API já está OK (Growatt em período de carência) e o período de carência já passou, limpa o registro.
        const gracePeriodUntil = new Date(existingStatus.recovery_grace_period_until);
        if (new Date() > gracePeriodUntil) {
            logger.info(`Período de carência para ${apiName} expirou. Removendo registro de status 'OK'.`);
            await connection.execute('DELETE FROM api_status_monitor WHERE api_name = ?', [apiName]);
        }
    }
}

/**
 * Lida com o cenário em que a chamada da API falhou.
 * @param {object} connection - Conexão com o banco de dados.
 * @param {string} apiName - Nome da API.
 * @param {object|null} existingStatus - O status atual da API no banco, se houver.
 */
async function handleApiFailure(connection, apiName, existingStatus) {
    if (existingStatus) {
        if (existingStatus.status === 'FAILING') {
            // A API já estava em estado de falha. Verificamos há quanto tempo.
            const firstFailureTime = new Date(existingStatus.first_failure_at);
            const now = new Date();
            const hoursSinceFailure = (now - firstFailureTime) / (1000 * 60 * 60);

            if (hoursSinceFailure >= 6 && !existingStatus.notification_sent) {
                // A falha persiste por 6 horas ou mais e a notificação ainda não foi enviada.
                logger.error(`ALERTA CRÍTICO: A API ${apiName} está falhando há mais de 6 horas.`);
                await telegramNotifier.sendTelegramMessage(
                    `🔥 <b>FALHA PERSISTENTE DE API: ${apiName}</b> 🔥\n\nA API <b>${apiName}</b> está offline ou apresentando erros graves (login, timeout, etc.) por <b>mais de 6 horas</b>.\n\nNenhuma nova notificação será enviada para esta falha até que o serviço seja restaurado.`
                );
                // Marca que a notificação foi enviada para não spamar o admin.
                await connection.execute(
                    'UPDATE api_status_monitor SET notification_sent = 1, last_checked_at = NOW(), recovery_grace_period_until = NULL WHERE api_name = ?',
                    [apiName]
                );
            } else {
                // A falha persiste, mas ainda não atingiu o limite de 6 horas ou a notificação já foi enviada.
                // Apenas atualizamos o timestamp da última verificação.
                await connection.execute(
                    'UPDATE api_status_monitor SET last_checked_at = NOW() WHERE api_name = ?',
                    [apiName]
                );
            }
        } else if (existingStatus.status === 'OK') {
            // A API estava em período de carência ('OK') mas falhou novamente.
            // Devemos reverter para 'FAILING' e registrar um novo 'first_failure_at'.
            logger.warn(`API ${apiName} falhou novamente durante o período de carência. Resetando para o estado de falha.`);
            await connection.execute(
                'UPDATE api_status_monitor SET status = \'FAILING\', first_failure_at = NOW(), last_checked_at = NOW(), notification_sent = 0, recovery_grace_period_until = NULL WHERE api_name = ?',
                [apiName]
            );
        }
    } else {
        // Esta é a primeira vez que a falha é detectada.
        logger.warn(`Primeira detecção de falha para a API ${apiName}. Iniciando monitoramento.`);
        await connection.execute(
            `INSERT INTO api_status_monitor (api_name, status, first_failure_at, last_checked_at, notification_sent, recovery_grace_period_until)
             VALUES (?, 'FAILING', NOW(), NOW(), 0, NULL)`,
            [apiName]
        );
    }
}

/**
 * Atualiza o status de uma API na tabela api_status_monitor e envia notificações se necessário.
 * @param {mysql.Pool} dbPool - O pool de conexão do MySQL.
 * @param {string} apiName - O nome da API (ex: 'Growatt', 'Solarman').
 * @param {boolean} isSuccess - True se a chamada da API foi bem-sucedida, false caso contrário.
 */
async function updateApiStatus(dbPool, apiName, isSuccess) {
    let connection;
    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [existingStatusRows] = await connection.execute(
            'SELECT * FROM api_status_monitor WHERE api_name = ? FOR UPDATE',
            [apiName]
        );
        const existingStatus = existingStatusRows[0];

        if (isSuccess) {
            await handleApiSuccess(connection, apiName, existingStatus);
        } else { // A chamada à API falhou
            await handleApiFailure(connection, apiName, existingStatus);
        }

        await connection.commit();
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        // Este erro é crítico para a lógica de monitoramento, então notificamos.
        const errorMessage = `Erro ao atualizar o status da API ${apiName} no banco de dados: ${error.message}`;
        logger.error(errorMessage);
        await telegramNotifier.sendTelegramMessage(
            `❌ <b>ERRO NO SISTEMA DE MONITORAMENTO DE API</b> ❌\n\nOcorreu um erro interno ao tentar gerenciar o estado da API <b>${apiName}</b>.\nDetalhes: ${error.message}`
        );
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

    // Busca a configuração de todas as plantas UMA VEZ para otimizar
    const allPlantConfigs = await getPlantConfig(pool);

    // Executa as buscas de dados em paralelo para otimizar o tempo
    logger.info('Iniciando buscas de dados das APIs em paralelo...');
    const results = await Promise.allSettled([
        processGrowattData(pool, allPlantConfigs),
        processSolarmanData(pool, allPlantConfigs),
        processSolplanetData(pool, allPlantConfigs) // Adicionado processamento da Solplanet
    ]);

    results.forEach((result, index) => {
        const apiNames = ['Growatt', 'Solarman', 'Solplanet'];
        const apiName = apiNames[index];
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

    // Executa o gerenciamento dos arquivos de log
    await manageLogFiles();

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
