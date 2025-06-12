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

    for (const [plantId, plantInfo] of Object.entries(data.plants)) {
      const plantName = plantInfo.plantName;

      // ESTA CONDIÇÃO DEVE PERMANECER! Uma planta sem 'devices' não faz sentido para inserção.
      if (!plantInfo.devices) {
        console.warn(`[${getFormattedTimestamp()}] Planta ignorada: ${plantName} - sem dados de dispositivos para inserção.`);
        continue;
      }

      for (const [deviceId, deviceData] of Object.entries(plantInfo.devices)) {
        const d = deviceData;

        // INÍCIO DA MODIFICAÇÃO CHAVE (Corrigindo o erro da mensagem anterior):
        // A condição original era: if (!d.deviceData || !d.historyLast || Object.keys(d.historyLast).length === 0)
        // O usuário quer inserir mesmo quando historyLast está vazio (inversor offline).
        // Assim, a condição deve ser APENAS se d.deviceData não existe.
        if (!d.deviceData) {
          console.warn(`[${getFormattedTimestamp()}] Dispositivo ignorado: ${deviceId} (${plantName}) - sem dados de dispositivo válidos para inserção.`);
          continue;
        }
        // FIM DA MODIFICAÇÃO CHAVE

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
          ipv1: (d.historyLast && d.historyLast.ipv1 != null) ? parseFloat(d.historyLast.ipv1) : null,
          ipv2: (d.historyLast && d.historyLast.ipv2 != null) ? parseFloat(d.historyLast.ipv2) : null,
          ipv3: (d.historyLast && d.historyLast.ipv3 != null) ? parseFloat(d.historyLast.ipv3) : null,
          ipv4: (d.historyLast && d.historyLast.ipv4 != null) ? parseFloat(d.historyLast.ipv4) : null,
          ipv5: (d.historyLast && d.historyLast.ipv5 != null) ? parseFloat(d.historyLast.ipv5) : null,
          ipv6: (d.historyLast && d.historyLast.ipv6 != null) ? parseFloat(d.historyLast.ipv6) : null,
          ipv7: (d.historyLast && d.historyLast.ipv7 != null) ? parseFloat(d.historyLast.ipv7) : null,
          ipv8: (d.historyLast && d.historyLast.ipv8 != null) ? parseFloat(d.historyLast.ipv8) : null,
          last_update_time: lastUpdateTimeFormatted,
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
          warning_value1: (d.historyLast && d.historyLast.warningValue1 != null) ? parseFloat(d.historyLast.warningValue1) : null,
          warning_value2: (d.historyLast && d.historyLast.warningValue2 != null) ? parseFloat(d.historyLast.warningValue2) : null,
          warning_value3: (d.historyLast && d.historyLast.warningValue3 != null) ? parseFloat(d.historyLast.warningValue3) : null,
          fault_type: (d.historyLast && d.historyLast.faultType != null) ? parseInt(d.historyLast.faultType) : null,
        };

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
  insertDataIntoMySQL,
};
