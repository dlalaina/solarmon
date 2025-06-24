// diagnosticLogger.js
const { getFormattedTimestamp } = require('./utils');

/**
 * Captures and saves diagnostic codes from the latest solar_data entry
 * for a given plant and inverter, associated with an event description.
 * @param {object} connection - An active MySQL database connection.
 * @param {string} plantName - The name of the plant.
 * @param {string} inverterId - The ID of the inverter.
 * @param {string} eventDescription - A description of the event (e.g., from an email alarm).
 * @returns {Promise<void>}
 */
async function captureAndSaveDiagnosticCodes(connection, plantName, inverterId, eventDescription) {
    try {
        const [latestSolarData] = await connection.execute(
            `SELECT
                warn_code, pid_fault_code, warn_bit, warn_code1,
                fault_code2, fault_code1, fault_value,
                warning_value2, warning_value1, warning_value3,
                fault_type, pto_status, bdc_status
            FROM solar_data
            WHERE plant_name = ? AND inverter_id = ?
            ORDER BY last_update_time DESC
            LIMIT 1`,
            [plantName, inverterId]
        );

        if (latestSolarData.length > 0) {
            const data = latestSolarData[0];
            await connection.execute(
                `INSERT INTO growatt_event_diagnostics (
                    plant_name, inverter_id, event_description, captured_at,
                    warn_code, pid_fault_code, warn_bit, warn_code1,
                    fault_code2, fault_code1, fault_value,
                    warning_value2, warning_value1, warning_value3,
                    fault_type, pto_status, bdc_status
                ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    plantName, inverterId, eventDescription,
                    data.warn_code, data.pid_fault_code, data.warn_bit, data.warn_code1,
                    data.fault_code2, data.fault_code1, data.fault_value,
                    data.warning_value2, data.warning_value1, data.warning_value3,
                    data.fault_type, data.pto_status, data.bdc_status
                ]
            );
            console.log(`[${getFormattedTimestamp()}] Códigos de diagnóstico salvos para evento "${eventDescription}" (Planta: ${plantName}, Inversor: ${inverterId}).`);
        } else {
            console.warn(`[${getFormattedTimestamp()}] Nenhuma entrada de solar_data encontrada para Planta: ${plantName}, Inversor: ${inverterId} ao registrar códigos de diagnóstico para evento "${eventDescription}".`);
        }
    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] ERRO ao salvar códigos de diagnóstico para evento "${eventDescription}" (Planta: ${plantName}, Inversor: ${inverterId}):`, error.message);
        throw error; // Re-throw to be handled by the caller
    }
}

module.exports = {
  captureAndSaveDiagnosticCodes,
};
