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

        // --- 2a. Current String Alarms: STRING_DOWN and HALF_STRING_WORKING ---
        const [dayIpvAlarms] = await connection.execute(`
            SELECT
                sd.plant_name,
                sd.inverter_id,
                CAST(sd.currentString1 AS DECIMAL(10,2)) AS currentString1,
                CAST(sd.currentString2 AS DECIMAL(10,2)) AS currentString2,
                CAST(sd.currentString3 AS DECIMAL(10,2)) AS currentString3,
                CAST(sd.currentString4 AS DECIMAL(10,2)) AS currentString4,
                CAST(sd.currentString5 AS DECIMAL(10,2)) AS currentString5,
                CAST(sd.currentString6 AS DECIMAL(10,2)) AS currentString6,
                CAST(sd.currentString7 AS DECIMAL(10,2)) AS currentString7,
                CAST(sd.currentString8 AS DECIMAL(10,2)) AS currentString8,
                CAST(sd.currentString9 AS DECIMAL(10,2)) AS currentString9,
                CAST(sd.currentString10 AS DECIMAL(10,2)) AS currentString10,
                CAST(sd.currentString11 AS DECIMAL(10,2)) AS currentString11,
                CAST(sd.currentString12 AS DECIMAL(10,2)) AS currentString12,
                CAST(sd.currentString13 AS DECIMAL(10,2)) AS currentString13,
                CAST(sd.currentString14 AS DECIMAL(10,2)) AS currentString14,
                CAST(sd.currentString15 AS DECIMAL(10,2)) AS currentString15,
                CAST(sd.currentString16 AS DECIMAL(10,2)) AS currentString16,
                CAST(GREATEST(
                    COALESCE(sd.currentString1, 0),
                    COALESCE(sd.currentString2, 0),
                    COALESCE(sd.currentString3, 0),
                    COALESCE(sd.currentString4, 0),
                    COALESCE(sd.currentString5, 0),
                    COALESCE(sd.currentString6, 0),
                    COALESCE(sd.currentString7, 0),
                    COALESCE(sd.currentString8, 0),
                    COALESCE(sd.currentString9, 0),
                    COALESCE(sd.currentString10, 0),
                    COALESCE(sd.currentString11, 0),
                    COALESCE(sd.currentString12, 0),
                    COALESCE(sd.currentString13, 0),
                    COALESCE(sd.currentString14, 0),
                    COALESCE(sd.currentString15, 0),
                    COALESCE(sd.currentString16, 0)
                ) AS DECIMAL(10,2)) AS greatest_current_string,
                pc.num_strings, -- Manter por enquanto, será removido depois
                pc.string_grouping_type,
                pc.active_strings_config -- ADICIONADO: Obter a configuração de strings ativas
            FROM solar_data sd
            JOIN plant_config pc ON sd.plant_name = pc.plant_name AND sd.inverter_id = pc.inverter_id
            WHERE
                sd.last_update_time >= CURDATE()
                AND sd.status <> -1
                AND (
                    COALESCE(sd.currentString1, 0) <= 0.5 OR COALESCE(sd.currentString2, 0) <= 0.5 OR COALESCE(sd.currentString3, 0) <= 0.5 OR COALESCE(sd.currentString4, 0) <= 0.5 OR
                    COALESCE(sd.currentString5, 0) <= 0.5 OR COALESCE(sd.currentString6, 0) <= 0.5 OR COALESCE(sd.currentString7, 0) <= 0.5 OR COALESCE(sd.currentString8, 0) <= 0.5 OR
                    COALESCE(sd.currentString9, 0) <= 0.5 OR COALESCE(sd.currentString10, 0) <= 0.5 OR COALESCE(sd.currentString11, 0) <= 0.5 OR COALESCE(sd.currentString12, 0) <= 0.5 OR
                    COALESCE(sd.currentString13, 0) <= 0.5 OR COALESCE(sd.currentString14, 0) <= 0.5 OR COALESCE(sd.currentString15, 0) <= 0.5 OR COALESCE(sd.currentString16, 0) <= 0.5
                ) OR GREATEST(
                    COALESCE(sd.currentString1, 0), COALESCE(sd.currentString2, 0), COALESCE(sd.currentString3, 0), COALESCE(sd.currentString4, 0),
                    COALESCE(sd.currentString5, 0), COALESCE(sd.currentString6, 0), COALESCE(sd.currentString7, 0), COALESCE(sd.currentString8, 0),
                    COALESCE(sd.currentString9, 0), COALESCE(sd.currentString10, 0), COALESCE(sd.currentString11, 0), COALESCE(sd.currentString12, 0),
                    COALESCE(sd.currentString13, 0), COALESCE(sd.currentString14, 0), COALESCE(sd.currentString15, 0), COALESCE(sd.currentString16, 0)
                ) >= 13.0
            ORDER BY sd.last_update_time DESC
            LIMIT 100
        `);

        // --- Bloco de preparação dos dados ---
        dayIpvAlarms.forEach(detection => {
            for (let i = 1; i <= 16; i++) { // Iterar por todas as 16 strings possíveis para garantir que todas sejam parseadas
                const currentStringKey = `currentString${i}`;
                detection[currentStringKey] = parseFloat(detection[currentStringKey] || 0);
            }
            detection.greatest_current_string = parseFloat(detection.greatest_current_string || 0);
        });
        // --- Fim do bloco de preparação dos dados --- 

        // NOVO: Buscar contagens consecutivas existentes para HALF_STRING_WORKING e STRING_DOWN
        const [consecutiveCountsRows] = await connection.execute(
            `SELECT plant_name, inverter_id, alarm_type, consecutive_count, problem_details
             FROM consecutive_alarm_counts
             WHERE alarm_type IN ('HALF_STRING_WORKING', 'STRING_DOWN')`
        );
        const consecutiveCountsMap = new Map();
        consecutiveCountsRows.forEach(row => {
            const key = `${row.plant_name}_${row.inverter_id}_${row.alarm_type}_${row.problem_details || ''}`;
            consecutiveCountsMap.set(key, row.consecutive_count);
        });

        // --- Loop principal de detecção e gerenciamento de alarmes ---
        for (const detection of dayIpvAlarms) {
            const plantName = detection.plant_name;
            const inverterId = detection.inverter_id;
            // const numStrings = detection.num_strings; // Será removido futuramente
            const greatestCurrentString = detection.greatest_current_string;
            const stringGroupingType = detection.string_grouping_type; // Ainda é usado

            // Obter e validar activeStringsConfig
            let activeStrings = [];
            // O driver do MySQL já deve retornar a coluna JSON como um array JS
            if (Array.isArray(detection.active_strings_config)) {
                activeStrings = detection.active_strings_config;
            } else if (detection.active_strings_config === null || detection.active_strings_config === undefined) {
                console.warn(`[${getFormattedTimestamp()}] active_strings_config é NULO/UNDEFINED para Planta: ${plantName}, Inversor: ${inverterId}. Usando array vazio.`);
                // Dependendo do seu caso, você pode querer um comportamento padrão aqui
                // como activeStrings = Array.from({length: detection.num_strings}, (_, i) => i + 1); 
                // Mas isso dependeria de num_strings, que você quer remover.
                // Se a config for crucial, o ideal é que ela SEMPRE seja um array válido.
                activeStrings = []; // Se não houver config, não processa strings específicas.
            } else {
                // Caso seja uma string por algum motivo, tente parsear (menos provável com JSON type)
                try {
                    activeStrings = JSON.parse(detection.active_strings_config);
                    if (!Array.isArray(activeStrings)) {
                        console.warn(`[${getFormattedTimestamp()}] active_strings_config inválido (não é array após parse) para Planta: ${plantName}, Inversor: ${inverterId}. Usando array vazio.`);
                        activeStrings = [];
                    }
                } catch (parseError) {
                    console.error(`[${getFormattedTimestamp()}] Erro ao parsear active_strings_config (esperado array ou string JSON) para Planta: ${plantName}, Inversor: ${inverterId}. Erro: ${parseError.message}. Usando array vazio.`);
                    activeStrings = [];
                }
            }
            
            // Se activeStrings ainda não for um array válido aqui, pule o inversor
            if (!Array.isArray(activeStrings) || activeStrings.length === 0) {
                console.warn(`[${getFormattedTimestamp()}] Pulando inversor ${inverterId} da planta ${plantName} devido a active_strings_config inválido ou vazio.`);
                continue; // Pular este inversor se a configuração de strings estiver inválida/ausente ou vazia.
            }

            // --- STRING_DOWN Detection ---
            for (const stringNum of activeStrings) { // Iterar sobre os NÚMEROS das strings ativas
                const currentStringKey = `currentString${stringNum}`;
                const problemDetails = `String ${stringNum} (Fora)`;
                const alarmType = 'STRING_DOWN';
                const alarmSeverity = 'High';

		const consecutiveKey_SD = `${plantName}_${inverterId}_${alarmType}_${problemDetails}`; // Chave para a contagem consecutiva de STRING_DOWN
                let consecutiveCount_SD = consecutiveCountsMap.get(consecutiveKey_SD) || 0;

                // Certifique-se de que detection[currentStringKey] existe e é um número. Usamos `|| 0` para fallback.
                // Mas é crucial que a query MySQL retorne essas colunas. Se `stringNum` for maior que o máximo selecionado,\
                // detection[currentStringKey] será `undefined`.\
                const stringCurrentValue = detection[currentStringKey] !== undefined ? parseFloat(detection[currentStringKey] || 0) : null; 

                if (stringCurrentValue === null) {
                    // Se a string não foi selecionada pela query (ex: stringNum > 16) ou não tem dados,\
                    // não podemos avaliá-la. Isso é um aviso, não um erro de parsing.\
                    // Se o seu `active_strings_config` pode ter números de string que não são capturados pela query,\
                    // então este aviso é esperado. Caso contrário, revise a query ou a config.\
                    console.warn(`[${getFormattedTimestamp()}] Dados de currentString${stringNum} não encontrados para Inversor: ${inverterId} na Planta: ${plantName}, apesar de estar em active_strings_config. Pulando esta string.`);
                    continue; 
                }

                if (stringCurrentValue <= 0.5 && greatestCurrentString > 8.0) {
                    consecutiveCount_SD++;
                    consecutiveCountsMap.set(consecutiveKey_SD, consecutiveCount_SD);

                    if (consecutiveCount_SD >= 2) {
                        const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetails}`;
                        if (!activeAlarmsMap.has(alarmKey)) {
                            const message = `String ${stringNum} do inversor ${inverterId} da planta ${plantName} está com produção próxima de zero (${stringCurrentValue.toFixed(2)}A) enquanto outras strings estão ativas (pico: ${greatestCurrentString.toFixed(2)}A).`;
                            await connection.execute(
                                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                                [plantName, inverterId, alarmType, alarmSeverity, problemDetails, message]
                            );
                            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetails})`);
                            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: STRING_DOWN</b> 🚨\\nPlanta: <b>${plantName}</b>\\nInversor: <b>${inverterId}</b>\\nDetalhes: String ${stringNum} (Fora)\\nProdução da String ${stringNum}: ${stringCurrentValue.toFixed(2)}A\\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
                        }
                        stillActiveDetectedKeys.add(alarmKey);
                    } else {
                        console.log(`[${getFormattedTimestamp()}] STRING_DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_SD}/2) - Alarme não disparado ainda.`);
                    }
                } else {
                    if (consecutiveCount_SD > 0) {
                        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para STRING_DOWN para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum}.`);
                        consecutiveCountsMap.set(consecutiveKey_SD, 0);
                    }
                }
            }

            // --- HALF_STRING_WORKING Detection ---
            if (greatestCurrentString >= 13.0) {
                const stringGroupingType = detection.string_grouping_type;
                let isHalfStringWorking = false;
                let halfWorkingStringValue = 0;
                let halfWorkingStringNum = 0;

                const lowerHalfThreshold = 0.30 * greatestCurrentString;
                const upperHalfThreshold = 0.70 * greatestCurrentString;

                for (const stringNum of activeStrings) { // Iterar sobre os NÚMEROS das strings ativas
                    const currentStringKey = `currentString${stringNum}`;
                    const currentStringValue = detection[currentStringKey] !== undefined ? parseFloat(detection[currentStringKey] || 0) : null;

                    if (currentStringValue === null) {
                        console.warn(`[${getFormattedTimestamp()}] Dados de currentString${stringNum} não encontrados para HALF_STRING_WORKING para Inversor: ${inverterId} na Planta: ${plantName}. Pulando esta string.`);
                        continue;
                    }

                    let shouldCheckThisStringForHalfWorking = false;

                    switch (stringGroupingType) {
                        case 'ALL_2P':
                            shouldCheckThisStringForHalfWorking = true;
                            break;
                        case 'MIXED_4S_4_2P':
                            if (stringNum >= 5 && stringNum <= 8) shouldCheckThisStringForHalfWorking = true;
                            break;
                        case 'MIXED_6_2P_2S':
                            if (stringNum >= 1 && stringNum >= 1 && stringNum <= 6) shouldCheckThisStringForHalfWorking = true;
                            break;
                        default:
                            break;
                    }

                    if (shouldCheckThisStringForHalfWorking) {
                        if (currentStringValue >= lowerHalfThreshold && currentStringValue <= upperHalfThreshold && currentStringValue < greatestCurrentString) {
                            isHalfStringWorking = true;
                            halfWorkingStringValue = currentStringValue;
                            halfWorkingStringNum = stringNum;
                            break;
                        }
                    }
                }

                const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF_STRING_WORKING_`;
                let consecutiveCount_HSW = consecutiveCountsMap.get(consecutiveKey_HSW) || 0;

                if (isHalfStringWorking) {
                    consecutiveCount_HSW++;
                    consecutiveCountsMap.set(consecutiveKey_HSW, consecutiveCount_HSW);

                    if (consecutiveCount_HSW >= 4) {
                        const problemDetails = `String ${halfWorkingStringNum} (Metade fora)`;
                        const alarmType = 'HALF_STRING_WORKING';
                        const alarmSeverity = 'Medium';
                        const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetails}`;

                        if (!activeAlarmsMap.has(alarmKey)) {
                            const message = `String ${halfWorkingStringNum} do inversor ${inverterId} da planta ${plantName} está com produção de ${halfWorkingStringValue.toFixed(2)}A, o que está entre 30% e 70% da string de maior produção (${greatestCurrentString.toFixed(2)}A). Isso indica uma série funcionando em paralelo.`;
                            await connection.execute(
                                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                                [plantName, inverterId, alarmType, alarmSeverity, problemDetails, message]
                            );
                            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetails})`);
                            await telegramNotifier.sendTelegramMessage(`⚠️ <b>NOVO ALARME: METADE DA STRING TRABALHANDO</b> ⚠️\\nPlanta: <b>${plantName}</b>\\nInversor: <b>${inverterId}</b>\\nDetalhes: String ${halfWorkingStringNum} (Metade Fora)\\nProdução da String ${halfWorkingStringNum}: ${halfWorkingStringValue.toFixed(2)}A\\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
                        }
                        stillActiveDetectedKeys.add(alarmKey);
                    } else {
                        console.log(`[${getFormattedTimestamp()}] HALF_STRING_WORKING detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${halfWorkingStringNum} (Contagem consecutiva: ${consecutiveCount_HSW}/4) - Alarme não disparado ainda.`);
                    }
                } else {
                    if (consecutiveCount_HSW > 0) {
                        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF_STRING_WORKING para Planta: ${plantName}, Inversor: ${inverterId}.`);
                        consecutiveCountsMap.set(consecutiveKey_HSW, 0);
                    }
                }
            } else {
                const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF_STRING_WORKING_`;
                if (consecutiveCountsMap.has(consecutiveKey_HSW) && consecutiveCountsMap.get(consecutiveKey_HSW) > 0) {
                    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF_STRING_WORKING para Planta: ${plantName}, Inversor: ${inverterId} (Pico de Corrente da String abaixo do limite).`);
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

            if (alarm.alarm_type === 'GROWATT_EMAIL_EVENT') {
                continue;
            }

            if (alarm.alarm_type === 'STRING_DOWN' || alarm.alarm_type === 'HALF_STRING_WORKING') {
                const [currentInverterData] = await connection.execute(`
                    SELECT
                        CAST(GREATEST(
                            COALESCE(sd.currentString1, 0), COALESCE(sd.currentString2, 0), COALESCE(sd.currentString3, 0), COALESCE(sd.currentString4, 0),
                            COALESCE(sd.currentString5, 0), COALESCE(sd.currentString6, 0), COALESCE(sd.currentString7, 0), COALESCE(sd.currentString8, 0),
                            COALESCE(sd.currentString9, 0), COALESCE(sd.currentString10, 0), COALESCE(sd.currentString11, 0), COALESCE(sd.currentString12, 0),
                            COALESCE(sd.currentString13, 0), COALESCE(sd.currentString14, 0), COALESCE(sd.currentString15, 0), COALESCE(sd.currentString16, 0)
                        ) AS DECIMAL(10,2)) AS greatest_current_string,
                        pc.num_strings, -- Manter por enquanto
                        pc.string_grouping_type,
                        pc.active_strings_config, -- ADICIONADO AQUI TAMBÉM
                        sd.status
                    FROM solar_data sd
                    JOIN plant_config pc ON sd.plant_name = pc.plant_name AND sd.inverter_id = pc.inverter_id
                    WHERE sd.plant_name = ? AND sd.inverter_id = ?
                    ORDER BY sd.last_update_time DESC
                    LIMIT 1
                `, [alarm.plant_name, alarm.inverter_id]);

                const currentGreatestCurrentString = currentInverterData.length > 0 ? parseFloat(currentInverterData[0].greatest_current_string || 0) : 0;
                const currentStatus = currentInverterData.length > 0 ? currentInverterData[0].status : null;
                const currentStringGroupingType = currentInverterData.length > 0 ? currentInverterData[0].string_grouping_type : null;
                
                let currentActiveStrings = [];
                if (currentInverterData.length > 0 && Array.isArray(currentInverterData[0].active_strings_config)) {
                    currentActiveStrings = currentInverterData[0].active_strings_config;
                } else {
                    console.warn(`[${getFormattedTimestamp()}] active_strings_config ausente ou inválido para reavaliação de alarme de Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id}. Assumindo todas as strings.`);
                    // Fallback se a config estiver ausente para limpeza. Se você deletar num_strings, ajuste isso.\
                    // Por enquanto, vou manter um array genérico de 1 a 16 para a reavaliação, mas o ideal é que active_strings_config seja confiável.\
                    currentActiveStrings = Array.from({length: 16}, (_, i) => i + 1);
                }

                let shouldClearThisIpvAlarm = false;

                if (currentStatus !== -1) {
                    const stringNumber = parseInt(alarm.problem_details.match(/String (\d+)/)[1]);
                    const currentStringKey = `currentString${stringNumber}`;

                    const [currentStringCheck] = await connection.execute(
                        `SELECT currentString${stringNumber} FROM solar_data WHERE plant_name = ? AND inverter_id = ? ORDER BY last_update_time DESC LIMIT 1`,
                        [alarm.plant_name, alarm.inverter_id]
                    );
                    const currentStringValue = currentStringCheck.length > 0 ? parseFloat(currentStringCheck[0][currentStringKey] || 0) : 0;

                    // Verificar se a string que disparou o alarme ainda está na lista de strings ativas.\
                    // Se uma string for desativada via active_strings_config, o alarme deve ser limpo.\
                    if (!currentActiveStrings.includes(stringNumber)) {
                        shouldClearThisIpvAlarm = true;
                        console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details}) - String não está mais em active_strings_config.`);
                    } else if (alarm.alarm_type === 'STRING_DOWN' && currentGreatestCurrentString > 8.0) {
                        if (currentStringValue > 0.5) { 
                            shouldClearThisIpvAlarm = true;
                        }
                    } else if (alarm.alarm_type === 'HALF_STRING_WORKING' && currentGreatestCurrentString >= 13.0) {
                        const lowerHalfThreshold = 0.30 * currentGreatestCurrentString;
                        const upperHalfThreshold = 0.70 * currentGreatestCurrentString;

                        if (!(currentStringValue >= lowerHalfThreshold && currentStringValue <= upperHalfThreshold && currentStringValue < currentGreatestCurrentString)) {
                            shouldClearThisIpvAlarm = true;
                        }
                    }
                }

                if (shouldClearThisIpvAlarm) {
                    await connection.execute(
                        `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                        [alarm.alarm_id]
                    );
                    console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''}) - Condição de Corrente da String para limpeza satisfeita.`);
                    await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/_/g, ' ')}</b> ✅\\nPlanta: <b>${alarm.plant_name}</b>\\nInversor: <b>${alarm.inverter_id}</b>\\nDetalhes: ${alarm.problem_details || 'N/A'}`);
                } else {
                    stillActiveDetectedKeys.add(alarmKey);
                }
            } else {
                await connection.execute(
                    `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                    [alarm.alarm_id]
                );
                console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''})`);
                await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/_/g, ' ')}</b> ✅\\nPlanta: <b>${alarm.plant_name}</b>\\nInversor: <b>${alarm.inverter_id}</b>\\nDetalhes: ${alarm.problem_details || 'N/A'}`);
            }
        }

        // --- Persistir contagens consecutivas atualizadas ---
        for (const [key, count] of consecutiveCountsMap.entries()) {
            const [plantName, inverterId, alarmType, problemDetailsPart] = key.split('_');
            const actualProblemDetails = (alarmType === 'STRING_DOWN' && problemDetailsPart !== undefined) ? problemDetailsPart : '';

            if (count > 0) {
                await connection.execute(
                    `INSERT INTO consecutive_alarm_counts (plant_name, inverter_id, alarm_type, problem_details, consecutive_count)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE consecutive_count = VALUES(consecutive_count)`,
                    [plantName, inverterId, alarmType, actualProblemDetails, count]
                );
            } else {
                await connection.execute(
                    `DELETE FROM consecutive_alarm_counts
                     WHERE plant_name = ? AND inverter_id = ? AND alarm_type = ? AND problem_details = ?`,
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
            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: ${alarmType.replace(/_/g, ' ')}</b> 🚨\\nPlanta: <b>${detection.plant_name}</b>\\nInversor: <b>${detection.inverter_id}</b>\\nDetalhes: ${problemDetails || 'N/A'}\\n<i>${message}</i>`);
        }
        stillActiveDetectedKeys.add(key);
    }
}

module.exports = {
    checkAndManageAlarms,
};
