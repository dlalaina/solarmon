// database.js
const { getFormattedTimestamp } = require('./utils');
const moment = require('moment-timezone');

/**
 * Inserts transformed Growatt/Solarman data into the MySQL database.
 * @param {object} pool - The MySQL connection pool.
 * @param {object} data - The data object with a 'plants' property containing plant and device data.
 * @returns {Promise<void>}
 */
async function insertDataIntoMySQL(pool, data) {
  if (!data || !data.plants || typeof data.plants !== 'object') {
    throw new Error('Dados inválidos para inserção: estrutura "plants" ausente ou incorreta.');
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
        console.warn(`[${getFormattedTimestamp()}] Planta ignorada: ${plantName} - sem dados de dispositivos para inserção.`);
        continue;
      }

      for (const [deviceId, deviceData] of Object.entries(plantInfo.devices)) {
        const d = deviceData;

        // Retrieve plant configuration for the current device
        const plantConfigKey = `${plantName}_${deviceId}`;
        const currentPlantConfig = plantConfigsMap.get(plantConfigKey);

        if (!currentPlantConfig) {
          console.warn(`[${getFormattedTimestamp()}] Configuração da planta não encontrada para Inversor: ${deviceId} na Planta: ${plantName}. Ignorando inserção de dados PV.`);
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
            console.warn(`[${getFormattedTimestamp()}] active_strings_config com tipo inesperado (${typeof rawActiveStringsConfig}) para Inversor: ${deviceId} na Planta: ${plantName}. Esperado array ou string JSON. Usando array vazio.`);
            activeStrings = [];
          }

          if (!Array.isArray(activeStrings)) {
            console.warn(`[${getFormattedTimestamp()}] active_strings_config inválido para Inversor: ${deviceId} na Planta: ${plantName}. Resultado final não é um array. Usando array vazio.`);
            activeStrings = [];
          }
        } catch (e) {
          console.error(`[${getFormattedTimestamp()}] Erro ao parsear/processar active_strings_config para Inversor: ${deviceId} na Planta: ${plantName}. Erro: ${e.message}. Usando array vazio.`);
          activeStrings = [];
        }

        // --- Mapeamento de Dados Brutos ---
        let sourceData = {};
        let lastUpdateTimeValue = null;

        if (currentPlantConfig.apiType === 'Solarman') {
            const dataListMap = {};
            if (d.dataList && Array.isArray(d.dataList)) {
                d.dataList.forEach(item => {
                    dataListMap[item.key] = item.value;
                });
            }

            sourceData = {
                e_today: dataListMap.Etdy_ge1,
                e_total: dataListMap.Et_ge0,
                status: dataListMap.INV_ST1, // Inverterstatus como string (Grid connected/Offline)
                temperature2: dataListMap.IGBT_T1,
                temperature3: dataListMap.T_AC_RDT1,
                temperature5: dataListMap.T_IDT1,
                vacr: dataListMap.AV1,
                vacs: dataListMap.AV2,
                vact: dataListMap.AV3,
            };
            
            if (d.collectionTime != null) {
                const epochSeconds = parseInt(d.collectionTime);
                if (!isNaN(epochSeconds)) {
                    lastUpdateTimeValue = moment.unix(epochSeconds).tz('America/Sao_Paulo').format('YYYY-MM-DD HH:mm:ss');
                }
            }

        } else {
            // Mapeamento para Growatt
            sourceData = {
                e_today: d.deviceData.eToday,
                e_total: d.deviceData.eTotal,
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
                status: d.deviceData.status, // Growatt status é numérico
                temperature: d.historyLast?.temperature,
                temperature2: d.historyLast?.temperature2,
                temperature3: d.historyLast?.temperature3,
                temperature4: d.historyLast?.temperature4,
                temperature5: d.historyLast?.temperature5,
                update_status: d.deviceData.status,
                vacr: d.historyLast?.vacr,
                vacs: d.historyLast?.vacs,
                vact: d.historyLast?.vact,
                warn_code: d.historyLast?.warnCode,
                pid_fault_code: d.historyLast?.pidFaultCode,
                warn_bit: d.historyLast?.WarnBit,
                warn_code1: d.historyLast?.warnCode1,
                fault_code2: d.historyLast?.faultCode2,
                fault_code1: d.historyLast?.faultCode1,
                fault_value: d.historyLast?.faultValue,
            };
            lastUpdateTimeValue = d.deviceData.lastUpdateTime ? moment(d.deviceData.lastUpdateTime).format('YYYY-MM-DD HH:mm:ss') : null;
        }

        const rowData = {
          plant_name: plantName,
          inverter_id: deviceId,
          device_model: currentPlantConfig.apiType === 'Solarman'
                        ? null
                        : (d.deviceData?.deviceModel || null),
          
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
          
          e_today: sourceData.e_today != null ? parseFloat(sourceData.e_today) : null,
          e_total: sourceData.e_total != null ? parseFloat(sourceData.e_total) : null,
          last_update_time: lastUpdateTimeValue,
          status: (() => {
              if (currentPlantConfig.apiType === 'Solarman' && typeof sourceData.status === 'string') {
                  const lowerCaseStatus = sourceData.status.toLowerCase();
                  if (lowerCaseStatus === 'grid connected') return 0; // On-line
                  if (lowerCaseStatus === 'offline') return -1; // Off-line, padronizado com Growatt
                  return null; // Retorna null para outros status desconhecidos do Solarman
              }
              // Para Growatt (já é numérico) ou se sourceData.status não for string para Solarman
              return sourceData.status != null ? parseInt(sourceData.status) : null;
          })(),
          temperature2: sourceData.temperature2 != null ? parseFloat(sourceData.temperature2) : null,
          temperature3: sourceData.temperature3 != null ? parseFloat(sourceData.temperature3) : null,
          temperature5: sourceData.temperature5 != null ? parseFloat(sourceData.temperature5) : null,
          vacr: sourceData.vacr != null ? parseFloat(sourceData.vacr) : null,
          vacs: sourceData.vacs != null ? parseFloat(sourceData.vacs) : null,
          vact: sourceData.vact != null ? parseFloat(sourceData.vact) : null,
        };

        // Populate ipvX, vpvX and currentStringX dynamically based on activeStrings and api_type
        for (const stringNum of activeStrings) {
            const ipvCol = `ipv${stringNum}`;
            const vpvCol = `vpv${stringNum}`;
            const currentStringCol = `currentString${stringNum}`;

            if (currentPlantConfig.apiType === 'Solarman') {
                const dataListMap = {}; 
                if (d.dataList && Array.isArray(d.dataList)) {
                    d.dataList.forEach(item => {
                        dataListMap[item.key] = item.value;
                    });
                }
                rowData[ipvCol] = dataListMap[`DC${stringNum}`] != null ? parseFloat(dataListMap[`DC${stringNum}`]) : null;
                rowData[vpvCol] = dataListMap[`DV${stringNum}`] != null ? parseFloat(dataListMap[`DV${stringNum}`]) : null;

            } else {
                // Growatt (usa d.historyLast.ipvX e d.historyLast.vpvX)
                rowData[ipvCol] = (d.historyLast && d.historyLast[ipvCol] != null) ? parseFloat(d.historyLast[ipvCol]) : null;
                rowData[vpvCol] = (d.historyLast && d.historyLast[vpvCol] != null) ? parseFloat(d.historyLast[vpvCol]) : null;
            }

            // Lógica para currentStringX, baseada em string_grouping_type
            if (currentPlantConfig.stringGroupingType === 'ALL_1S') {
                if (d.historyLast && d.historyLast[currentStringCol] != null) {
                    rowData[currentStringCol] = parseFloat(d.historyLast[currentStringCol]);
                } else {
                    rowData[currentStringCol] = null;
                }
            } else {
                rowData[currentStringCol] = rowData[ipvCol];
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
        console.log(`[${getFormattedTimestamp()}] Inserido/Atualizado dado para Planta: ${plantName}, Inversor: ${deviceId}`);
      }
    }
    await connection.commit();
  } catch (dbError) {
    if (connection) {
      await connection.rollback();
    }
    throw new Error(`Erro ao inserir dados no MySQL: ${dbError.message}`);
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

module.exports = {
  insertDataIntoMySQL
};
