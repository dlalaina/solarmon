// database.js
const logger = require('./logger')('main');
const moment = require('moment-timezone');

/**
 * Mapeia os dados brutos da API Growatt para um formato padronizado.
 * @param {object} d - O objeto de dados do dispositivo Growatt.
 * @returns {{sourceData: object, lastUpdateTimeValue: string|null}}
 */
function mapGrowattData(d) {
    const sourceData = {
        gen_today: d.deviceData.eToday,
        gen_total: d.deviceData.eTotal,
        epv1_today: d.historyLast?.epv1Today,
        epv2_today: d.historyLast?.epv2Today,
        epv3_today: d.historyLast?.epv3Today,
        epv4_today: d.historyLast?.epv4Today,
        epv5_today: d.historyLast?.epv5Today,
        epv6_today: d.historyLast?.epv6Today,
        epv7_today: d.historyLast?.epv7Today,
        epv8_today: d.historyLast?.epv8Today,
        bdc_status: d.deviceData.bdcStatus,
        pto_status: d.deviceData.ptoStatus,
        status: d.deviceData.status,
        temperature: d.historyLast?.temperature,
        temperature2: d.historyLast?.temperature2,
        temperature3: d.historyLast?.temperature3,
        temperature4: d.historyLast?.temperature4,
        temperature5: d.historyLast?.temperature5,
        nominal_power: d.deviceData.nominalPower,
        frequency_ac: d.historyLast?.fac,
        output_power: d.deviceData.pac,
        update_status: d.deviceData.status,
        voltage_ac1: d.historyLast?.vacr,
        voltage_ac2: d.historyLast?.vacs,
        voltage_ac3: d.historyLast?.vact,
        warn_code: d.historyLast?.warnCode,
        pid_fault_code: d.historyLast?.pidFaultCode,
        warn_bit: d.historyLast?.WarnBit,
        warn_code1: d.historyLast?.warnCode1,
        fault_code2: d.historyLast?.faultCode2,
        fault_code1: d.historyLast?.faultCode1,
        fault_value: d.historyLast?.faultValue,
    };
    const lastUpdateTimeValue = d.deviceData.lastUpdateTime ? moment(d.deviceData.lastUpdateTime).format('YYYY-MM-DD HH:mm:ss') : null;
    return { sourceData, lastUpdateTimeValue };
}

/**
 * Mapeia os dados brutos da API Solarman para um formato padronizado.
 * @param {object} d - O objeto de dados do dispositivo Solarman.
 * @returns {{sourceData: object, lastUpdateTimeValue: string|null}}
 */
function mapSolarmanData(d) {
    const dataListMap = {};
    if (d.dataList && Array.isArray(d.dataList)) {
        d.dataList.forEach(item => {
            dataListMap[item.key] = item.value;
        });
    }

    const sourceData = {
        gen_today: dataListMap.Etdy_ge1,
        gen_total: dataListMap.Et_ge0,
        status: dataListMap.INV_ST1,
        temperature2: dataListMap.IGBT_T1,
        temperature3: dataListMap.T_AC_RDT1,
        temperature5: dataListMap.T_IDT1,
        nominal_power: dataListMap.Pr1,
        frequency_ac: dataListMap.A_Fo1,
        output_power: dataListMap.APo_t1,
        voltage_ac1: dataListMap.AV1,
        voltage_ac2: dataListMap.AV2,
        voltage_ac3: dataListMap.AV3,
    };

    let lastUpdateTimeValue = null;
    if (d.collectionTime != null) {
        const epochSeconds = parseInt(d.collectionTime);
        if (!isNaN(epochSeconds)) {
            lastUpdateTimeValue = moment.unix(epochSeconds).tz('America/Sao_Paulo').format('YYYY-MM-DD HH:mm:ss');
        }
    }
    return { sourceData, lastUpdateTimeValue };
}

/**
 * Mapeia os dados brutos da API Solplanet para um formato padronizado.
 * @param {object} d - O objeto de dados do dispositivo Solplanet.
 * @returns {{sourceData: object, lastUpdateTimeValue: string|null}}
 */
function mapSolplanetData(d) {
    const result = d.result || {};
    const sourceData = {
        gen_today: result.etoday?.[0] ? parseFloat(result.etoday[0]) : null,
        gen_total: result.etotal?.[0] ? parseFloat(result.etotal[0]) * 1000 : null, // Convert MWh to kWh
        voltage_ac1: result.vac?.[0] ? parseFloat(result.vac[0]) : null,
        voltage_ac2: result.vac?.[1] ? parseFloat(result.vac[1]) : null,
        voltage_ac3: result.vac?.[2] ? parseFloat(result.vac[2]) : null,
        nominal_power: result.maxoutputpower?.[0] ? parseFloat(result.maxoutputpower[0]) : null,
        frequency_ac: result.fac?.[0] ? parseFloat(result.fac[0]) : null,
        output_power: result.pac?.[0] ? parseFloat(result.pac[0]) : null,
        status: result.status, // Será mapeado para -1, 1, etc., posteriormente
        device_model: result.devtypename || null,
        temperature: result.temperature?.[0] ? parseFloat(result.temperature[0]) : null,
    };

    // Mapeia dinamicamente os arrays ipv, vpv e str_cur
    for (let i = 1; i <= 16; i++) {
        const index = i - 1;
        // ipv e vpv têm no máximo 8 colunas no banco
        if (i <= 8) {
            if (result.ipv && result.ipv[index] != null) { // API ainda envia 'ipv'
                sourceData[`current_mppt${i}`] = parseFloat(result.ipv[index]);
            }
            if (result.vpv && result.vpv[index] != null) { // API ainda envia 'vpv'
                sourceData[`voltage_mppt${i}`] = parseFloat(result.vpv[index]);
            }
        }
        // str_cur tem 16 elementos no exemplo, API envia 'str_cur'
        if (result.str_cur && result.str_cur[index] != null) {
            sourceData[`current_string${i}`] = parseFloat(result.str_cur[index]);
        }
    }

    const lastUpdateTimeValue = result.ludt?.[0] ? moment(result.ludt[0]).format('YYYY-MM-DD HH:mm:ss') : null;

    return { sourceData, lastUpdateTimeValue };
}

/**
 * Inserts transformed Growatt/Solarman data into the MySQL database.
 * @param {object} pool - The MySQL connection pool.
 * @param {object} data - The data object with a 'plants' property containing plant and device data.
 * @returns {Promise<void>}
 */
async function insertDataIntoMySQL(pool, data) {
  if (!data || !data.plants || typeof data.plants !== 'object') {
    logger.error('Dados inválidos para inserção: estrutura "plants" ausente ou incorreta.');
    throw new Error('Dados inválidos para inserção.');
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Load all plant configurations into a map for efficient lookup
    const [plantConfigsRows] = await connection.execute(
      `SELECT plant_name, inverter_id, string_grouping_type, active_strings_config, api_type
        FROM plant_config`
    );

    const plantConfigsMap = new Map();
    plantConfigsRows.forEach(config => {
      plantConfigsMap.set(`${config.plant_name}_${config.inverter_id}`, {
        stringGroupingType: config.string_grouping_type,
        activeStringsConfig: config.active_strings_config,
        apiType: config.api_type
      });
    });

    for (const [plantId, plantInfo] of Object.entries(data.plants)) {
      const plantName = plantInfo.plantName;

      if (!plantInfo.devices) {
        logger.warn(`Planta ignorada: ${plantName} - sem dados de dispositivos para inserção.`);
        continue;
      }

      for (const [deviceId, deviceData] of Object.entries(plantInfo.devices)) {
        const d = deviceData;

        // Retrieve plant configuration for the current device
        const plantConfigKey = `${plantName}_${deviceId}`;
        const currentPlantConfig = plantConfigsMap.get(plantConfigKey);

        if (!currentPlantConfig) {
          logger.warn(`Configuração da planta não encontrada para Inversor: ${deviceId} na Planta: ${plantName}. Ignorando inserção de dados PV.`);
          continue;
        }

        let activeStrings = [];
        const rawActiveStringsConfig = currentPlantConfig.activeStringsConfig;

        try {
          if (Array.isArray(rawActiveStringsConfig)) {
            activeStrings = rawActiveStringsConfig;
          } else if (typeof rawActiveStringsConfig === 'string') {
            activeStrings = JSON.parse(rawActiveStringsConfig);
          } else if (rawActiveStringsConfig === null || rawActiveStringsConfig === undefined) {
            activeStrings = [];
          } else {
            logger.warn(`active_strings_config com tipo inesperado (${typeof rawActiveStringsConfig}) para Inversor: ${deviceId} na Planta: ${plantName}. Esperado array ou string JSON. Usando array vazio.`);
            activeStrings = [];
          }

          if (!Array.isArray(activeStrings)) {
            logger.warn(`active_strings_config inválido para Inversor: ${deviceId} na Planta: ${plantName}. Resultado final não é um array. Usando array vazio.`);
            activeStrings = [];
          }
        } catch (e) {
          logger.error(`Erro ao parsear/processar active_strings_config para Inversor: ${deviceId} na Planta: ${plantName}. Erro: ${e.message}. Usando array vazio.`);
          activeStrings = [];
        }

        // --- Mapeamento de Dados Brutos ---
        let sourceData, lastUpdateTimeValue;

        if (currentPlantConfig.apiType === 'Solarman') {
            ({ sourceData, lastUpdateTimeValue } = mapSolarmanData(d));
        } else if (currentPlantConfig.apiType === 'Solplanet') {
            ({ sourceData, lastUpdateTimeValue } = mapSolplanetData(d));
        } else {
            // Mapeamento para Growatt (padrão)
            ({ sourceData, lastUpdateTimeValue } = mapGrowattData(d));
        }

        const rowData = {
          plant_name: plantName,
          inverter_id: deviceId,
          device_model: sourceData.device_model || (d.deviceData?.deviceModel || null),
          
          bdc_status: sourceData.bdc_status != null ? parseInt(sourceData.bdc_status) : null,
          pto_status: sourceData.pto_status != null ? parseInt(sourceData.pto_status) : null,
          epv1_today: sourceData.epv1_today != null ? parseFloat(sourceData.epv1_today) : null,
          epv2_today: sourceData.epv2_today != null ? parseFloat(sourceData.epv2_today) : null,
          epv3_today: sourceData.epv3_today != null ? parseFloat(sourceData.epv3_today) : null,
          epv4_today: sourceData.epv4_today != null ? parseFloat(sourceData.epv4_today) : null,
          epv5_today: sourceData.epv5_today != null ? parseFloat(sourceData.epv5_today) : null,
          epv6_today: sourceData.epv6_today != null ? parseFloat(sourceData.epv6_today) : null,
          epv7_today: sourceData.epv7_today != null ? parseFloat(sourceData.epv7_today) : null,
          epv8_today: sourceData.epv8_today != null ? parseFloat(sourceData.epv8_today) : null,
          temperature: sourceData.temperature != null ? parseFloat(sourceData.temperature) : null,
          temperature4: sourceData.temperature4 != null ? parseFloat(sourceData.temperature4) : null,
          warn_code: sourceData.warn_code != null ? parseInt(sourceData.warn_code) : null,
          pid_fault_code: sourceData.pid_fault_code != null ? parseInt(sourceData.pid_fault_code) : null,
          warn_bit: sourceData.warn_bit != null ? parseInt(sourceData.warn_bit) : null,
          warn_code1: sourceData.warn_code1 != null ? parseInt(sourceData.warn_code1) : null,
          fault_code2: sourceData.fault_code2 != null ? parseInt(sourceData.fault_code2) : null,
          fault_code1: sourceData.fault_code1 != null ? parseInt(sourceData.fault_code1) : null,
          fault_value: sourceData.fault_value != null ? parseInt(sourceData.fault_value) : null,
          update_status: sourceData.update_status != null ? parseInt(sourceData.update_status) : null,
          
          gen_today: sourceData.gen_today != null ? parseFloat(sourceData.gen_today) : null,
          gen_total: sourceData.gen_total != null ? parseFloat(sourceData.gen_total) : null,
          last_update_time: lastUpdateTimeValue,
          status: (() => {
              if (currentPlantConfig.apiType === 'Solarman' && typeof sourceData.status === 'string') {
                  const lowerCaseStatus = sourceData.status.toLowerCase();
                  if (lowerCaseStatus === 'grid connected') return 1; // On-line, padronizado com Growatt (1)
                  if (lowerCaseStatus === 'offline') return -1; // Off-line, padronizado com Growatt
                  return null; // Retorna null para outros status desconhecidos do Solarman
              }
              if (currentPlantConfig.apiType === 'Solplanet') {
                  if (sourceData.status === 0) return 0;  // CORREÇÃO: Mapeia para 0 (Aguardando), não -1 (Offline)
                  if (sourceData.status === 1) return 1;  // Online (suposição)
                  // Adicionar outros mapeamentos de status da Solplanet aqui se necessário
                  return null;
              }
              // Para Growatt (já é numérico) ou se sourceData.status não for string para Solarman
              return sourceData.status != null ? parseInt(sourceData.status) : null;
          })(),
          temperature2: sourceData.temperature2 != null ? parseFloat(sourceData.temperature2) : null,
          temperature3: sourceData.temperature3 != null ? parseFloat(sourceData.temperature3) : null,
          temperature5: sourceData.temperature5 != null ? parseFloat(sourceData.temperature5) : null,
          voltage_ac1: sourceData.voltage_ac1 != null ? parseFloat(sourceData.voltage_ac1) : null,
          voltage_ac2: sourceData.voltage_ac2 != null ? parseFloat(sourceData.voltage_ac2) : null,
          voltage_ac3: sourceData.voltage_ac3 != null ? parseFloat(sourceData.voltage_ac3) : null,
          nominal_power: sourceData.nominal_power != null ? parseFloat(sourceData.nominal_power) : null,
          frequency_ac: sourceData.frequency_ac != null ? parseFloat(sourceData.frequency_ac) : null,
          output_power: sourceData.output_power != null ? parseFloat(sourceData.output_power) : null,
        };

        // Populate ipvX, vpvX and currentStringX dynamically based on activeStrings and api_type
        for (const stringNum of activeStrings) {
            const currentMpptCol = `current_mppt${stringNum}`;
            const voltageMpptCol = `voltage_mppt${stringNum}`;
            const currentStringCol = `current_string${stringNum}`;

            if (currentPlantConfig.apiType === 'Solarman') { // --- SOLARMAN ---
                const dataListMap = {}; 
                if (d.dataList && Array.isArray(d.dataList)) {
                    d.dataList.forEach(item => {
                        dataListMap[item.key] = item.value;
                    });
                }
                rowData[currentMpptCol] = dataListMap[`DC${stringNum}`] != null ? parseFloat(dataListMap[`DC${stringNum}`]) : null;
                rowData[voltageMpptCol] = dataListMap[`DV${stringNum}`] != null ? parseFloat(dataListMap[`DV${stringNum}`]) : null;
                // Para Solarman, currentString é sempre o mesmo que ipv
                rowData[currentStringCol] = rowData[currentMpptCol];

            } else if (currentPlantConfig.apiType === 'Solplanet') { // --- SOLPLANET ---
                // Apenas preenche ipv e vpv se o número da string for 8 ou menos
                if (parseInt(stringNum) <= 8) {
                    rowData[currentMpptCol] = sourceData[currentMpptCol] != null ? sourceData[currentMpptCol] : null;
                    rowData[voltageMpptCol] = sourceData[voltageMpptCol] != null ? sourceData[voltageMpptCol] : null;
                }
                // Para Solplanet, currentString vem de seu próprio campo
                rowData[currentStringCol] = sourceData[currentStringCol] != null ? sourceData[currentStringCol] : null;

            } else { // --- GROWATT (Padrão) ---
                rowData[currentMpptCol] = (d.historyLast && d.historyLast[`ipv${stringNum}`] != null) ? parseFloat(d.historyLast[`ipv${stringNum}`]) : null;
                rowData[voltageMpptCol] = (d.historyLast && d.historyLast[`vpv${stringNum}`] != null) ? parseFloat(d.historyLast[`vpv${stringNum}`]) : null;

                // Para Growatt, currentString depende do tipo de agrupamento
                if (currentPlantConfig.stringGroupingType === 'ALL_1S') {
                    if (d.historyLast && d.historyLast[`currentString${stringNum}`] != null) {
                        rowData[currentStringCol] = parseFloat(d.historyLast[`currentString${stringNum}`]);
                    } else {
                        rowData[currentStringCol] = null;
                    }
                } else {
                    rowData[currentStringCol] = rowData[currentMpptCol];
                }
            }
        }

        const columns = Object.keys(rowData).join(', ');
        const placeholders = Object.keys(rowData).map(() => '?').join(', ');
        const updateAssignments = Object.keys(rowData)
          .filter(key => key !== 'plant_name' && key !== 'inverter_id')
          .map(key => `\`${key}\` = VALUES(\`${key}\`)`)
          .join(', ');

        const sql = `INSERT INTO solar_data (${columns}) VALUES (${placeholders})
                     ON DUPLICATE KEY UPDATE ${updateAssignments}`;

        const values = Object.values(rowData);
        
        await connection.execute(sql, values);

        // Log aprimorado para incluir status e data de atualização
        const statusMap = {
          '-1': 'OFFLINE',    // Padrão Growatt e Solarman
          '0': 'AGUARDANDO',  // Padrão Growatt (Waiting)
          '1': 'ONLINE'       // Padrão Growatt (Online) e Solarman (Grid-Connected)
        };
        const statusValue = rowData.status;

        let statusText;
        if (currentPlantConfig.apiType === 'Solarman' && typeof sourceData.status === 'string') {
            // Para Solarman, o log exibe a string de status original (ex: "Grid connected").
            statusText = sourceData.status;
        } else if (currentPlantConfig.apiType === 'Solplanet' && typeof d.result?.state === 'string') {
            // Para Solplanet, usamos o campo 'state' que é mais descritivo (ex: "off-line")
            statusText = d.result.state;
        } else {
            // Para Growatt (e como fallback), usa o mapa de status numérico.
            statusText = statusMap[statusValue] || `Desconhecido (${statusValue})`;
        }

        const updateTimeText = rowData.last_update_time || 'N/A';
        logger.info(`Inserido/Atualizado dado para Planta: ${plantName}, Inversor: ${deviceId} (Status: ${statusText}, Update: ${updateTimeText})`);
      }
    }
    await connection.commit();
  } catch (dbError) {
    if (connection) {
      await connection.rollback();
    }
    logger.error(`Erro ao inserir dados no MySQL: ${dbError.stack}`);
    throw dbError;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

module.exports = {
  insertDataIntoMySQL
};
