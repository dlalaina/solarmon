// database.js
const { getFormattedTimestamp } = require('./utils');

/**
 * Inserts transformed Growatt data into the MySQL database.
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
      `SELECT plant_name, inverter_id, string_grouping_type, active_strings_config
       FROM plant_config`
    );

    const plantConfigsMap = new Map();
    plantConfigsRows.forEach(config => {
      plantConfigsMap.set(`${config.plant_name}_${config.inverter_id}`, {
        stringGroupingType: config.string_grouping_type,
        activeStringsConfig: config.active_strings_config
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
          // Continue to the next device, as we don't have configuration for this one
          continue;
        }

let activeStrings = [];
        // Guardamos o valor bruto para inspecionar
        const rawActiveStringsConfig = currentPlantConfig.activeStringsConfig;

        try {
            // Se o valor já for um array, use-o diretamente.
            // Se for uma string (caso o driver não faça o parsing automático ou venha de outra fonte), tente parsear.
            if (Array.isArray(rawActiveStringsConfig)) {
                activeStrings = rawActiveStringsConfig;
            } else if (typeof rawActiveStringsConfig === 'string') {
                activeStrings = JSON.parse(rawActiveStringsConfig);
            } else if (rawActiveStringsConfig === null || rawActiveStringsConfig === undefined) {
                // Lida com casos onde a configuração pode ser nula ou indefinida no banco
                activeStrings = [];
            } else {
                // Caso seja um tipo inesperado
                console.warn(`[${getFormattedTimestamp()}] active_strings_config com tipo inesperado (${typeof rawActiveStringsConfig}) para Inversor: ${deviceId} na Planta: ${plantName}. Esperado array ou string JSON. Usando array vazio.`);
                activeStrings = [];
            }

            // Esta verificação adicional ainda é útil para garantir que o resultado final seja um array
            if (!Array.isArray(activeStrings)) {
                console.warn(`[${getFormattedTimestamp()}] active_strings_config inválido para Inversor: ${deviceId} na Planta: ${plantName}. Resultado final não é um array. Usando array vazio.`);
                activeStrings = [];
            }
        } catch (e) {
            console.error(`[${getFormattedTimestamp()}] Erro ao parsear/processar active_strings_config para Inversor: ${deviceId} na Planta: ${plantName}. Erro: ${e.message}. Usando array vazio.`);
            activeStrings = [];
        }

        // Re-introduzindo a definição de lastUpdateTimeFormatted
        const lastUpdateTimeFormatted = d.deviceData.lastUpdateTime ? new Date(d.deviceData.lastUpdateTime) : null;

        const rowData = {
          plant_name: plantName,
          inverter_id: deviceId,
          bdc_status: d.deviceData.bdcStatus != null ? parseInt(d.deviceData.bdcStatus) : null,
          device_model: d.deviceData.deviceModel || null,
          e_today: d.deviceData.eToday != null ? parseFloat(d.deviceData.eToday) : null,
          e_total: d.deviceData.eTotal != null ? parseFloat(d.deviceData.eTotal) : null,
          // Campos que dependem de d.historyLast: agora verificam d.historyLast antes de acessar suas propriedades.
          // Se d.historyLast for null/undefined/{}, esses campos serão null, como esperado para offline.
          epv1_today: (d.historyLast && d.historyLast.epv1Today != null) ? parseFloat(d.historyLast.epv1Today) : null,
          epv2_today: (d.historyLast && d.historyLast.epv2Today != null) ? parseFloat(d.historyLast.epv2Today) : null,
          epv3_today: (d.historyLast && d.historyLast.epv3Today != null) ? parseFloat(d.historyLast.epv3Today) : null,
          epv4_today: (d.historyLast && d.historyLast.epv4Today != null) ? parseFloat(d.historyLast.epv4Today) : null,
          epv5_today: (d.historyLast && d.historyLast.epv5Today != null) ? parseFloat(d.historyLast.epv5Today) : null,
          epv6_today: (d.historyLast && d.historyLast.epv6Today != null) ? parseFloat(d.historyLast.epv6Today) : null,
          epv7_today: (d.historyLast && d.historyLast.epv7Today != null) ? parseFloat(d.historyLast.epv7Today) : null,
          epv8_today: (d.historyLast && d.historyLast.epv8Today != null) ? parseFloat(d.historyLast.epv8Today) : null,
          last_update_time: lastUpdateTimeFormatted, // Usando a variável definida acima
          pto_status: d.deviceData.ptoStatus != null ? parseInt(d.deviceData.ptoStatus) : null,
          // CRUCIAL: 'status' vem de d.deviceData, não de d.historyLast, para capturar o -1 de offline
          status: d.deviceData.status != null ? parseInt(d.deviceData.status) : null,
          temperature: (d.historyLast && d.historyLast.temperature != null) ? parseFloat(d.historyLast.temperature) : null,
          temperature2: (d.historyLast && d.historyLast.temperature2 != null) ? parseFloat(d.historyLast.temperature2) : null,
          temperature3: (d.historyLast && d.historyLast.temperature3 != null) ? parseFloat(d.historyLast.temperature3) : null,
          temperature4: (d.historyLast && d.historyLast.temperature4 != null) ? parseFloat(d.historyLast.temperature4) : null,
          temperature5: (d.historyLast && d.historyLast.temperature5 != null) ? parseFloat(d.historyLast.temperature5) : null,
          update_status: d.deviceData.status != null ? parseInt(d.deviceData.status) : null, // Assuming this is redundant with the main status field or for a different purpose
          vacr: (d.historyLast && d.historyLast.vacr != null) ? parseFloat(d.historyLast.vacr) : null,
          vacs: (d.historyLast && d.historyLast.vacs != null) ? parseFloat(d.historyLast.vacs) : null,
          vact: (d.historyLast && d.historyLast.vact != null) ? parseFloat(d.historyLast.vact) : null,
          vpv1: (d.historyLast && d.historyLast.vpv1 != null) ? parseFloat(d.historyLast.vpv1) : null,
          vpv2: (d.historyLast && d.historyLast.vpv2 != null) ? parseFloat(d.historyLast.vpv2) : null,
          vpv3: (d.historyLast && d.historyLast.vpv3 != null) ? parseFloat(d.historyLast.vpv3) : null,
          vpv4: (d.historyLast && d.historyLast.vpv4 != null) ? parseFloat(d.historyLast.vpv4) : null,
          vpv5: (d.historyLast && d.historyLast.vpv5 != null) ? parseFloat(d.historyLast.vpv5) : null,
          vpv6: (d.historyLast && d.historyLast.vpv6 != null) ? parseFloat(d.historyLast.vpv6) : null,
          vpv7: (d.historyLast && d.historyLast.vpv7 != null) ? parseFloat(d.historyLast.vpv7) : null,
          vpv8: (d.historyLast && d.historyLast.vpv8 != null) ? parseFloat(d.historyLast.vpv8) : null,
          warn_code: (d.historyLast && d.historyLast.warnCode != null) ? parseInt(d.historyLast.warnCode) : null,
          pid_fault_code: (d.historyLast && d.historyLast.pidFaultCode != null) ? parseInt(d.historyLast.pidFaultCode) : null,
          warn_bit: (d.historyLast && d.historyLast.WarnBit != null) ? parseInt(d.historyLast.WarnBit) : null,
          warn_code1: (d.historyLast && d.historyLast.warnCode1 != null) ? parseInt(d.historyLast.warnCode1) : null,
          fault_code2: (d.historyLast && d.historyLast.faultCode2 != null) ? parseInt(d.historyLast.faultCode2) : null,
          fault_code1: (d.historyLast && d.historyLast.faultCode1 != null) ? parseInt(d.historyLast.faultCode1) : null,
          fault_value: (d.historyLast && d.historyLast.faultValue != null) ? parseInt(d.historyLast.faultValue) : null,
        };

        // Populate currentStringX based on string_grouping_type and active_strings_config
        for (const stringNum of activeStrings) {
          const currentStringCol = `currentString${stringNum}`;
          if (currentPlantConfig.stringGroupingType === 'ALL_1S') {
            // If ALL_1S, use d.historyLast.currentString<X> directly
            if (d.historyLast && d.historyLast[currentStringCol] != null) {
              rowData[currentStringCol] = parseFloat(d.historyLast[currentStringCol]);
            } else {
              rowData[currentStringCol] = null; // Ensure it's null if not present or d.historyLast is missing
            }
          } else {
            // If not ALL_1S, use d.historyLast.ipv<X> for corresponding currentString<X>
            const ipvCol = `ipv${stringNum}`;
            if (d.historyLast && d.historyLast[ipvCol] != null) {
              rowData[currentStringCol] = parseFloat(d.historyLast[ipvCol]);
            } else {
              rowData[currentStringCol] = null; // Ensure it's null if not present or d.historyLast is missing
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
