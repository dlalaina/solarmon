// alarmManager.js
const telegramNotifier = require('./telegramNotifier');
const { getFormattedTimestamp } = require('./utils');

/**
 * Checks for and manages alarm conditions based on data in solar_data and plant_config.
 * @param {object} pool - The MySQL connection pool.
 */
async function checkAndManageAlarms(pool) {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // --- 1. Get all currently ACTIVE alarms from the database ---
        const [activeAlarmsRows] = await connection.execute(
            `SELECT alarm_id, plant_name, inverter_id, alarm_type, problem_details
             FROM alarms
             WHERE cleared_at IS NULL`
        );

        const activeAlarmsMap = new Map();
        activeAlarmsRows.forEach(alarm => {
            const alarmKey = `${alarm.plant_name}_${alarm.inverter_id}_${alarm.alarm_type}_${alarm.problem_details || ''}`;
            activeAlarmsMap.set(alarmKey, alarm);
        });

        const stillActiveDetectedKeys = new Set();

        // --- Alarm Detection Queries ---

        // --- 2a. IPV Alarms: STRING_DOWN and HALF_STRING_WORKING ---
        const [dayIpvAlarms] = await connection.execute(`
            SELECT
                sd.plant_name,
                sd.inverter_id,
                CAST(sd.ipv1 AS DECIMAL(10,2)) AS ipv1,
                CAST(sd.ipv2 AS DECIMAL(10,2)) AS ipv2,
                CAST(sd.ipv3 AS DECIMAL(10,2)) AS ipv3,
                CAST(sd.ipv4 AS DECIMAL(10,2)) AS ipv4,
                CAST(sd.ipv5 AS DECIMAL(10,2)) AS ipv5,
                CAST(sd.ipv6 AS DECIMAL(10,2)) AS ipv6,
                CAST(sd.ipv7 AS DECIMAL(10,2)) AS ipv7,
                CAST(sd.ipv8 AS DECIMAL(10,2)) AS ipv8,
                CAST(GREATEST(
                    COALESCE(sd.ipv1, 0),
                    COALESCE(sd.ipv2, 0),
                    COALESCE(sd.ipv3, 0),
                    COALESCE(sd.ipv4, 0),
                    COALESCE(sd.ipv5, 0),
                    COALESCE(sd.ipv6, 0),
                    COALESCE(sd.ipv7, 0),
                    COALESCE(sd.ipv8, 0)
                ) AS DECIMAL(10,2)) AS greatest_ipv_in_group,
                pc.num_strings,
                pc.string_grouping_type
            FROM solar_data sd
            JOIN plant_config pc ON sd.plant_name = pc.plant_name AND sd.inverter_id = pc.inverter_id
            WHERE
                sd.last_update_time >= CURDATE()
                AND sd.status <> -1
                AND (
                    COALESCE(sd.ipv1, 0) <= 0.5 OR COALESCE(sd.ipv2, 0) <= 0.5 OR COALESCE(sd.ipv3, 0) <= 0.5 OR COALESCE(sd.ipv4, 0) <= 0.5 OR
                    COALESCE(sd.ipv5, 0) <= 0.5 OR COALESCE(sd.ipv6, 0) <= 0.5 OR COALESCE(sd.ipv7, 0) <= 0.5 OR COALESCE(sd.ipv8, 0) <= 0.5
                    OR GREATEST(
                        COALESCE(sd.ipv1, 0), COALESCE(sd.ipv2, 0), COALESCE(sd.ipv3, 0), COALESCE(sd.ipv4, 0),
                        COALESCE(sd.ipv5, 0), COALESCE(sd.ipv6, 0), COALESCE(sd.ipv7, 0), COALESCE(sd.ipv8, 0)
                    ) >= 13.0
                )
            ORDER BY sd.last_update_time DESC
            LIMIT 100
        `);

        // --- Bloco de preparação dos dados ---
        dayIpvAlarms.forEach(detection => {
            for (let i = 1; i <= detection.num_strings; i++) {
                const ipvKey = `ipv${i}`;
                detection[ipvKey] = parseFloat(detection[ipvKey] || 0);
            }
            detection.greatest_ipv_in_group = parseFloat(detection.greatest_ipv_in_group || 0);
        });
        // --- Fim do bloco de preparação dos dados ---

        // NOVO: Buscar contagens consecutivas existentes para HALF_STRING_WORKING e STRING_DOWN
        const [consecutiveCountsRows] = await connection.execute(
            `SELECT plant_name, inverter_id, alarm_type, consecutive_count
             FROM consecutive_alarm_counts
             WHERE alarm_type IN ('HALF_STRING_WORKING', 'STRING_DOWN')` // <-- MUDANÇA AQUI
        );
        const consecutiveCountsMap = new Map();
        consecutiveCountsRows.forEach(row => {
            const key = `${row.plant_name}_${row.inverter_id}_${row.alarm_type}`; // <-- MUDANÇA AQUI: Adiciona alarm_type à chave
            consecutiveCountsMap.set(key, row.consecutive_count);
        });

        // --- Loop principal de detecção e gerenciamento de alarmes ---
        for (const detection of dayIpvAlarms) {
            const plantName = detection.plant_name;
            const inverterId = detection.inverter_id;
            const numStrings = detection.num_strings;
            const greatestIpv = detection.greatest_ipv_in_group;

            // --- STRING_DOWN Detection ---
            for (let i = 1; i <= numStrings; i++) {
                const ipvKey = `ipv${i}`;
                const problemDetails = `String ${i} (Fora)`;
                const alarmType = 'STRING_DOWN';
                const alarmSeverity = 'High';

                // NOVO: Lógica de contagem consecutiva para STRING_DOWN
                const consecutiveKey_SD = `${plantName}_${inverterId}_${alarmType}_${problemDetails}`; // Chave para a contagem consecutiva de STRING_DOWN
                let consecutiveCount_SD = consecutiveCountsMap.get(consecutiveKey_SD) || 0;

                if (detection[ipvKey] <= 0.5 && greatestIpv > 8.0) {
                    consecutiveCount_SD++; // Incrementa a contagem se a condição for metida
                    consecutiveCountsMap.set(consecutiveKey_SD, consecutiveCount_SD); // Atualiza no mapa

                    if (consecutiveCount_SD >= 2) { // Só dispara o alarme se a contagem for >= 2
                        const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetails}`;
                        if (!activeAlarmsMap.has(alarmKey)) {
                            const message = `String ${i} do inversor ${inverterId} da planta ${plantName} está com produção próxima de zero (${(detection[ipvKey] || 0).toFixed(2)}A) enquanto outras strings estão ativas (pico: ${greatestIpv.toFixed(2)}A).`;
                            await connection.execute(
                                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                                [plantName, inverterId, alarmType, alarmSeverity, problemDetails, message]
                            );
                            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetails})`);
                            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: STRING_DOWN</b> 🚨\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: String ${i} (Fora)\nProdução da String ${i}: ${(detection[ipvKey] || 0).toFixed(2)}A\nPico do Inversor: ${greatestIpv.toFixed(2)}A`);
                        }
                        stillActiveDetectedKeys.add(alarmKey);
                    } else {
                        console.log(`[${getFormattedTimestamp()}] STRING_DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${i} (Contagem consecutiva: ${consecutiveCount_SD}/2) - Alarme não disparado ainda.`);
                    }
                } else { // Se a condição STRING_DOWN NÃO for metida
                    if (consecutiveCount_SD > 0) { // Reseta a contagem apenas se ela era maior que 0
                        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para STRING_DOWN para Planta: ${plantName}, Inversor: ${inverterId}, String: ${i}.`);
                        consecutiveCountsMap.set(consecutiveKey_SD, 0); // Reseta no mapa
                    }
                }
            }

            // --- HALF_STRING_WORKING Detection ---
            if (greatestIpv >= 13.0) {
                const stringGroupingType = detection.string_grouping_type;
                let isHalfStringWorking = false;
                let halfWorkingStringIpv = 0;
                let halfWorkingStringNum = 0;

                const lowerHalfThreshold = 0.30 * greatestIpv;
                const upperHalfThreshold = 0.70 * greatestIpv;

                for (let i = 1; i <= numStrings; i++) {
                    const ipvKey = `ipv${i}`;
                    const currentIpvValue = detection[ipvKey] || 0;
                    let shouldCheckThisStringForHalfWorking = false;

                    switch (stringGroupingType) {
                        case 'ALL_2P':
                            shouldCheckThisStringForHalfWorking = true;
                            break;
                        case 'MIXED_4S_4_2P':
                            if (i >= 5 && i <= 8) shouldCheckThisStringForHalfWorking = true;
                            break;
                        case 'MIXED_6_2P_2S':
                            if (i >= 1 && i <= 6) shouldCheckThisStringForHalfWorking = true;
                            break;
                        default:
                            break;
                    }

                    if (shouldCheckThisStringForHalfWorking) {
                        if (currentIpvValue >= lowerHalfThreshold && currentIpvValue <= upperHalfThreshold && currentIpvValue < greatestIpv) {
                            isHalfStringWorking = true;
                            halfWorkingStringIpv = currentIpvValue;
                            halfWorkingStringNum = i;
                            break;
                        }
                    }
                }

                // Lógica de contagem consecutiva para HALF_STRING_WORKING
                const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF_STRING_WORKING`; // Chave para a contagem consecutiva de HALF_STRING_WORKING
                let consecutiveCount_HSW = consecutiveCountsMap.get(consecutiveKey_HSW) || 0;

                if (isHalfStringWorking) {
                    consecutiveCount_HSW++; // Incrementa a contagem se a condição for met
                    consecutiveCountsMap.set(consecutiveKey_HSW, consecutiveCount_HSW); // Atualiza no mapa

                    if (consecutiveCount_HSW >= 4) { // Só dispara o alarme se a contagem for >= 4
                        const problemDetails = `String ${halfWorkingStringNum} (Metade fora)`;
                        const alarmType = 'HALF_STRING_WORKING';
                        const alarmSeverity = 'Medium';
                        const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetails}`;

                        if (!activeAlarmsMap.has(alarmKey)) {
                            const message = `String ${halfWorkingStringNum} do inversor ${inverterId} da planta ${plantName} está com produção de ${halfWorkingStringIpv.toFixed(2)}A, o que está entre 30% e 70% da string de maior produção (${greatestIpv.toFixed(2)}A). Isso indica uma série funcionando em paralelo.`;
                            await connection.execute(
                                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                                [plantName, inverterId, alarmType, alarmSeverity, problemDetails, message]
                            );
                            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetails})`);
                            await telegramNotifier.sendTelegramMessage(`⚠️ <b>NOVO ALARME: METADE DA STRING TRABALHANDO</b> ⚠️\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: String ${halfWorkingStringNum} (Metade Fora)\nProdução da String ${halfWorkingStringNum}: ${halfWorkingStringIpv.toFixed(2)}A\nPico do Inversor: ${greatestIpv.toFixed(2)}A`);
                        }
                        stillActiveDetectedKeys.add(alarmKey);
                    } else {
                        console.log(`[${getFormattedTimestamp()}] HALF_STRING_WORKING detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${halfWorkingStringNum} (Contagem consecutiva: ${consecutiveCount_HSW}/4) - Alarme não disparado ainda.`);
                    }
                } else { // Se a condição HALF_STRING_WORKING NÃO for metida
                    if (consecutiveCount_HSW > 0) { // Reseta a contagem apenas se ela era maior que 0
                        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF_STRING_WORKING para Planta: ${plantName}, Inversor: ${inverterId}.`);
                        consecutiveCountsMap.set(consecutiveKey_HSW, 0);
                    }
                }
            } else { // Se greatestIpv < 13.0 (Não se qualifica para HALF_STRING_WORKING)
                const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF_STRING_WORKING`;
                if (consecutiveCountsMap.has(consecutiveKey_HSW) && consecutiveCountsMap.get(consecutiveKey_HSW) > 0) {
                    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF_STRING_WORKING para Planta: ${plantName}, Inversor: ${inverterId} (Pico IPV abaixo do limite).`);
                    consecutiveCountsMap.set(consecutiveKey_HSW, 0);
                }
            }
        }

        // --- 2b. Inverter Offline Alarms ---
        const [inverterOfflineAlarms] = await connection.execute(`
            SELECT
                pc.plant_name,
                pc.inverter_id,
                sd.status
            FROM
                plant_config pc
            LEFT JOIN
                solar_data sd ON pc.plant_name = sd.plant_name AND pc.inverter_id = sd.inverter_id
                AND sd.last_update_time = (SELECT MAX(last_update_time) FROM solar_data WHERE plant_name = pc.plant_name AND inverter_id = pc.inverter_id)
            WHERE
                sd.last_update_time IS NULL
                OR sd.last_update_time < NOW() - INTERVAL 30 MINUTE
                OR sd.status = -1
        `);
        await processDetections(
            inverterOfflineAlarms,
            'INVERTER_OFFLINE',
            'Inversor Offline',
            'Critical',
            'Inversor está offline ou sem dados recentes (ou status -1).',
            connection,
            activeAlarmsMap,
            stillActiveDetectedKeys
        );

        // --- 3. Process alarms that are no longer detected (i.e., they've cleared) ---
        for (const [alarmKey, alarm] of activeAlarmsMap.entries()) {
            if (stillActiveDetectedKeys.has(alarmKey)) {
                continue;
            }

            // Alarmes de e-mail do Growatt não são auto-limpáveis pelo script.
            if (alarm.alarm_type === 'GROWATT_EMAIL_EVENT') {
                continue;
            }

            // Lógica de limpeza para alarmes STRING_DOWN e HALF_STRING_WORKING
            if (alarm.alarm_type === 'STRING_DOWN' || alarm.alarm_type === 'HALF_STRING_WORKING') {
                // Busca os dados mais recentes para reavaliar a condição
                const [currentInverterData] = await connection.execute(`
                    SELECT
                        CAST(GREATEST(
                            COALESCE(sd.ipv1, 0), COALESCE(sd.ipv2, 0), COALESCE(sd.ipv3, 0), COALESCE(sd.ipv4, 0),
                            COALESCE(sd.ipv5, 0), COALESCE(sd.ipv6, 0), COALESCE(sd.ipv7, 0), COALESCE(sd.ipv8, 0)
                        ) AS DECIMAL(10,2)) AS greatest_ipv_in_group,
                        pc.num_strings,
                        pc.string_grouping_type,
                        sd.status
                    FROM solar_data sd
                    JOIN plant_config pc ON sd.plant_name = pc.plant_name AND sd.inverter_id = pc.inverter_id
                    WHERE sd.plant_name = ? AND sd.inverter_id = ?
                    ORDER BY sd.last_update_time DESC
                    LIMIT 1
                `, [alarm.plant_name, alarm.inverter_id]);

                const currentGreatestIpv = currentInverterData.length > 0 ? parseFloat(currentInverterData[0].greatest_ipv_in_group || 0) : 0;
                const currentStatus = currentInverterData.length > 0 ? currentInverterData[0].status : null;
                const currentNumStrings = currentInverterData.length > 0 ? currentInverterData[0].num_strings : 0;
                const currentStringGroupingType = currentInverterData.length > 0 ? currentInverterData[0].string_grouping_type : null;

                let shouldClearThisIpvAlarm = false;

                // Só limpa se o inversor não estiver offline
                if (currentStatus !== -1) {
                    if (alarm.alarm_type === 'STRING_DOWN' && currentGreatestIpv > 8.0) {
                        const stringNumber = parseInt(alarm.problem_details.match(/String (\d+)/)[1]);
                        const [stringIpvCheck] = await connection.execute(
                            `SELECT ipv${stringNumber} FROM solar_data WHERE plant_name = ? AND inverter_id = ? ORDER BY last_update_time DESC LIMIT 1`,
                            [alarm.plant_name, alarm.inverter_id]
                        );
                        const currentStringIpv = stringIpvCheck.length > 0 ? parseFloat(stringIpvCheck[0][`ipv${stringNumber}`] || 0) : 0;

                        if (currentStringIpv > 0.5) { // Se a string voltou a produzir
                            shouldClearThisIpvAlarm = true;
                        }
                    } else if (alarm.alarm_type === 'HALF_STRING_WORKING' && currentGreatestIpv >= 13.0) {
                        const stringNumber = parseInt(alarm.problem_details.match(/String (\d+)/)[1]);
                        const [stringIpvCheck] = await connection.execute(
                            `SELECT ipv${stringNumber} FROM solar_data WHERE plant_name = ? AND inverter_id = ? ORDER BY last_update_time DESC LIMIT 1`,
                            [alarm.plant_name, alarm.inverter_id]
                        );
                        const currentStringIpv = stringIpvCheck.length > 0 ? parseFloat(stringIpvCheck[0][`ipv${stringNumber}`] || 0) : 0;

                        const lowerHalfThreshold = 0.30 * currentGreatestIpv;
                        const upperHalfThreshold = 0.70 * currentGreatestIpv;

                        // Se a string NÃO estiver mais na faixa de "metade"
                        if (!(currentStringIpv >= lowerHalfThreshold && currentStringIpv <= upperHalfThreshold && currentStringIpv < currentGreatestIpv)) {
                            shouldClearThisIpvAlarm = true;
                        }
                    }
                }

                if (shouldClearThisIpvAlarm) {
                    await connection.execute(
                        `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                        [alarm.alarm_id]
                    );
                    console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''}) - Condição de IPV para limpeza satisfeita.`);
                    await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/_/g, ' ')}</b> ✅\nPlanta: <b>${alarm.plant_name}</b>\nInversor: <b>${alarm.inverter_id}</b>\nDetalhes: ${alarm.problem_details || 'N/A'}`);
                } else {
                    // Se o alarme NÃO foi limpo, ele ainda está ativo, então o mantemos no stillActiveDetectedKeys.
                    // Isso é importante para que não seja limpo erroneamente pelo bloco final.
                    stillActiveDetectedKeys.add(alarmKey);
                }
            } else {
                // Limpa outros tipos de alarmes se eles não estiverem mais na lista de detecções ativas
                await connection.execute(
                    `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                    [alarm.alarm_id]
                );
                console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''})`);
                await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/_/g, ' ')}</b> ✅\nPlanta: <b>${alarm.plant_name}</b>\nInversor: <b>${alarm.inverter_id}</b>\nDetalhes: ${alarm.problem_details || 'N/A'}`);
            }
        }

        // --- Persistir contagens consecutivas atualizadas ---
        for (const [key, count] of consecutiveCountsMap.entries()) {
            const [plantName, inverterId, alarmType, problemDetailsPart] = key.split('_'); // Ajustado para pegar problemDetailsPart
            // Se o alarmType for 'STRING_DOWN', o problemDetailsPart será parte da chave
            const actualProblemDetails = (alarmType === 'STRING_DOWN' && problemDetailsPart) ? problemDetailsPart : '';

            if (count > 0) {
                await connection.execute(
                    `INSERT INTO consecutive_alarm_counts (plant_name, inverter_id, alarm_type, problem_details, consecutive_count)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE consecutive_count = VALUES(consecutive_count)`,
                    [plantName, inverterId, alarmType, actualProblemDetails, count] // Adicionado problem_details
                );
            } else {
                // Se a contagem é 0, significa que a condição não é mais metida, então podemos remover o registro.
                await connection.execute(
                    `DELETE FROM consecutive_alarm_counts
                     WHERE plant_name = ? AND inverter_id = ? AND alarm_type = ? AND problem_details = ?`, // Adicionado problem_details
                    [plantName, inverterId, alarmType, actualProblemDetails]
                );
            }
        }

        await connection.commit();
    } catch (alarmError) {
        if (connection) {
            await connection.rollback();
        }
        console.error(`[${getFormattedTimestamp()}] Erro ao gerenciar alarmes: ${alarmError.message}`);
        throw alarmError;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

/**
 * Handles inserting new alarms into the database and marking them as still active.
 * @param {Array<Object>} detections - Array of detected alarm objects.
 * @param {string} alarmType - The type of the alarm.
 * @param {string} problemDetails - A short description.
 * @param {string} alarmSeverity - The severity level.
 * @param {string} message - A detailed message.
 * @param {mysql.Connection} connection - The MySQL database connection.
 * @param {Map} activeAlarmsMap - Map of currently active alarms.
 * @param {Set} stillActiveDetectedKeys - Set to track alarms still active.
 */
async function processDetections(detections, alarmType, problemDetails, alarmSeverity, message, connection, activeAlarmsMap, stillActiveDetectedKeys) {
    for (const detection of detections) {
        const key = `${detection.plant_name}_${detection.inverter_id}_${alarmType}_${problemDetails || ''}`;
        if (!activeAlarmsMap.has(key)) {
            await connection.execute(
                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [detection.plant_name, detection.inverter_id, alarmType, alarmSeverity, problemDetails || '', message]
            );
            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${detection.plant_name}, Inversor: ${detection.inverter_id} (${problemDetails || ''})`);
            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: ${alarmType.replace(/_/g, ' ')}</b> 🚨\nPlanta: <b>${detection.plant_name}</b>\nInversor: <b>${detection.inverter_id}</b>\nDetalhes: ${problemDetails || 'N/A'}\n<i>${message}</i>`);
        }
        stillActiveDetectedKeys.add(key);
    }
}

module.exports = {
    checkAndManageAlarms,
};
