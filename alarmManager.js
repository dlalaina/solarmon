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
            // Garante que a chave do activeAlarmsMap seja consistente com a forma como problem_details é gerada.
            // Se problem_details for NULL no DB, ele será uma string vazia aqui.
            // ALTERAÇÃO: O alarm_type agora usará '-' em vez de '_'.
            const alarmKey = `${alarm.plant_name}_${alarm.inverter_id}_${alarm.alarm_type}_${alarm.problem_details || ''}`;
            activeAlarmsMap.set(alarmKey, alarm);
        });

        const stillActiveDetectedKeys = new Set();

        // --- Alarm Detection Queries ---

        // --- 2a. Current String Alarms: STRING-DOWN and HALF-STRING-WORKING ---
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
                pc.string_grouping_type,
                pc.active_strings_config,
                pc.api_type
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
            for (let i = 1; i <= 16; i++) {
                const currentStringKey = `currentString${i}`;
                detection[currentStringKey] = parseFloat(detection[currentStringKey] || 0);
            }
            detection.greatest_current_string = parseFloat(detection.greatest_current_string || 0);
        });
        // --- Fim do bloco de preparação dos dados ---

        // NOVO: Buscar contagens consecutivas existentes para HALF-STRING-WORKING e STRING-DOWN
        const [consecutiveCountsRows] = await connection.execute(
            // ALTERAÇÃO: Usar '-' nos nomes dos alarmes na query SQL.
            `SELECT plant_name, inverter_id, alarm_type, consecutive_count, problem_details
             FROM consecutive_alarm_counts
             WHERE alarm_type IN ('HALF-STRING-WORKING', 'STRING-DOWN')`
        );
        const consecutiveCountsMap = new Map();
        consecutiveCountsRows.forEach(row => {
            // Garante que a chave carregada do DB seja consistente.
            // Se problem_details for NULL no DB, ele será uma string vazia aqui.
            const key = `${row.plant_name}_${row.inverter_id}_${row.alarm_type}_${row.problem_details || ''}`;
            consecutiveCountsMap.set(key, row.consecutive_count);
        });

        // --- Loop principal de detecção e gerenciamento de alarmes ---
        for (const detection of dayIpvAlarms) {
            const plantName = detection.plant_name;
            const inverterId = detection.inverter_id;
            const greatestCurrentString = detection.greatest_current_string;
            const stringGroupingType = detection.string_grouping_type;
            const apiType = detection.api_type;

            // Obter e validar activeStringsConfig
            let activeStrings = [];
            if (Array.isArray(detection.active_strings_config)) {
                activeStrings = detection.active_strings_config;
            } else if (detection.active_strings_config === null || detection.active_strings_config === undefined) {
                console.warn(`[${getFormattedTimestamp()}] active_strings_config é NULO/UNDEFINED para Planta: ${plantName}, Inversor: ${inverterId}. Usando array vazio.`);
                activeStrings = [];
            } else {
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

            if (!Array.isArray(activeStrings) || activeStrings.length === 0) {
                console.warn(`[${getFormattedTimestamp()}] Pulando inversor ${inverterId} da planta ${plantName} devido a active_strings_config inválido ou vazio.`);
                continue;
            }

            // --- STRING-DOWN Detection ---
            for (const stringNum of activeStrings) {
                const currentStringKey = `currentString${stringNum}`;
                const alarmType = 'STRING-DOWN'; // ALTERAÇÃO: de STRING_DOWN para STRING-DOWN
                const alarmSeverity = 'High';

                let problemDetailsForAlarm = `String ${stringNum} (Fora)`;
                let telegramMessageDetails = `String ${stringNum} (Fora)`;

                if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
                    const mpptToStringsMap = {
                        1: '1,2,3',
                        2: '4,5,6',
                        3: '7,8,9',
                        4: '10,11,12',
                        // Adicione mais mapeamentos conforme a necessidade do seu modelo de inversor/MPPTs
                    };
                    const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
                    problemDetailsForAlarm = `MPPT ${stringNum} (Strings ${mappedStrings}) Fora`;
                    telegramMessageDetails = `MPPT ${stringNum} (Strings ${mappedStrings}) Fora`;
                }

                // A chave para o mapa de contagens consecutivas DEVE usar problemDetailsForAlarm
                const consecutiveKey_SD = `${plantName}_${inverterId}_${alarmType}_${problemDetailsForAlarm}`;
                let consecutiveCount_SD = consecutiveCountsMap.get(consecutiveKey_SD) || 0;

                const stringCurrentValue = detection[currentStringKey] !== undefined ? parseFloat(detection[currentStringKey] || 0) : null;

                if (stringCurrentValue === null) {
                    console.warn(`[${getFormattedTimestamp()}] Dados de currentString${stringNum} não encontrados para Inversor: ${inverterId} na Planta: ${plantName}, apesar de estar em active_strings_config. Pulando esta string.`);
                    continue;
                }

                if (stringCurrentValue <= 0.5 && greatestCurrentString > 8.0) {
                    consecutiveCount_SD++;
                    consecutiveCountsMap.set(consecutiveKey_SD, consecutiveCount_SD);

                    if (consecutiveCount_SD >= 2) {
                        const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetailsForAlarm}`;
                        if (!activeAlarmsMap.has(alarmKey)) {
                            const message = `String ${stringNum} do inversor ${inverterId} da planta ${plantName} está com produção próxima de zero (${stringCurrentValue.toFixed(2)}A) enquanto outras strings estão ativas (pico: ${greatestCurrentString.toFixed(2)}A).`;
                            await connection.execute(
                                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                                [plantName, inverterId, alarmType, alarmSeverity, problemDetailsForAlarm, message]
                            );
                            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetailsForAlarm})`);
                            // ALTERAÇÃO: replace do '-' por espaço no Telegram
                            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> 🚨\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${telegramMessageDetails}\nProdução da String ${stringNum}: ${stringCurrentValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
                        }
                        stillActiveDetectedKeys.add(alarmKey);
                    } else {
                        console.log(`[${getFormattedTimestamp()}] STRING-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_SD}/2) - Alarme não disparado ainda.`);
                    }
                } else {
                    // Se a condição não é mais atendida, resetamos a contagem para 0
                    if (consecutiveCount_SD > 0) {
                        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para STRING-DOWN para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum}.`);
                        consecutiveCountsMap.set(consecutiveKey_SD, 0); // Usa a chave consistente aqui

                        const alarmKeyToClear = `${plantName}_${inverterId}_${alarmType}_${problemDetailsForAlarm}`;
                        if (activeAlarmsMap.has(alarmKeyToClear)) {
                             console.log(`[${getFormattedTimestamp()}] Condição de STRING-DOWN resolvida para ${plantName} - ${inverterId} - ${problemDetailsForAlarm}. Será limpo no final.`);
                        }
                    }
                }
            }

            // --- HALF-STRING-WORKING Detection ---
            for (const stringNum of activeStrings) { // Iterar por cada string para HALF-STRING-WORKING também
                const currentStringKey = `currentString${stringNum}`;
                const currentStringValue = detection[currentStringKey] !== undefined ? parseFloat(detection[currentStringKey] || 0) : null;

                if (currentStringValue === null) {
                    console.warn(`[${getFormattedTimestamp()}] Dados de currentString${stringNum} não encontrados para HALF-STRING-WORKING para Inversor: ${inverterId} na Planta: ${plantName}. Pulando esta string.`);
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
                        if (stringNum >= 1 && stringNum <= 6) shouldCheckThisStringForHalfWorking = true;
                        break;
                    default:
                        // Para outros stringGroupingType, não verifica HALF-STRING-WORKING por padrão.
                        break;
                }

                if (shouldCheckThisStringForHalfWorking && greatestCurrentString >= 13.0) {
                    const lowerHalfThreshold = 0.30 * greatestCurrentString;
                    const upperHalfThreshold = 0.70 * greatestCurrentString;

                    let halfWorkingProblemDetails = `String ${stringNum} (Metade Fora)`;
                    let halfWorkingTelegramDetails = `String ${stringNum} (Metade Fora)`;

                    if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
                        const mpptToStringsMap = {
                            1: '1,2,3', 2: '4,5,6', 3: '7,8,9', 4: '10,11,12',
                        };
                        const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
                        halfWorkingProblemDetails = `MPPT ${stringNum} (Strings ${mappedStrings}) Metade Fora`;
                        halfWorkingTelegramDetails = `MPPT ${stringNum} (Strings ${mappedStrings}) Metade Fora`;
                    }

                    const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`; // ALTERAÇÃO: de HALF_STRING_WORKING para HALF-STRING-WORKING
                    let consecutiveCount_HSW = consecutiveCountsMap.get(consecutiveKey_HSW) || 0;

                    if (currentStringValue >= lowerHalfThreshold && currentStringValue <= upperHalfThreshold && currentStringValue < greatestCurrentString) {
                        consecutiveCount_HSW++;
                        consecutiveCountsMap.set(consecutiveKey_HSW, consecutiveCount_HSW);

                        if (consecutiveCount_HSW >= 4) {
                            const alarmType = 'HALF-STRING-WORKING'; // ALTERAÇÃO: de HALF_STRING_WORKING para HALF-STRING-WORKING
                            const alarmSeverity = 'Medium';
                            const alarmKey = `${plantName}_${inverterId}_${alarmType}_${halfWorkingProblemDetails}`;

                            if (!activeAlarmsMap.has(alarmKey)) {
                                const message = `String ${stringNum} do inversor ${inverterId} da planta ${plantName} está com produção de ${currentStringValue.toFixed(2)}A, o que está entre 30% e 70% da string de maior produção (${greatestCurrentString.toFixed(2)}A). Isso indica uma série funcionando em paralelo.`;
                                await connection.execute(
                                    `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                                     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                                    [plantName, inverterId, alarmType, alarmSeverity, halfWorkingProblemDetails, message]
                                );
                                console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${halfWorkingProblemDetails})`);
                                // ALTERAÇÃO: replace do '-' por espaço no Telegram
                                await telegramNotifier.sendTelegramMessage(`⚠️ <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> ⚠️\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${halfWorkingTelegramDetails}\nProdução da String ${stringNum}: ${currentStringValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
                            }
                            stillActiveDetectedKeys.add(alarmKey);
                        } else {
                            console.log(`[${getFormattedTimestamp()}] HALF-STRING-WORKING detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_HSW}/4) - Alarme não disparado ainda.`);
                        }
                    } else {
                        // Se a condição não é mais atendida, resetamos a contagem para 0
                        if (consecutiveCount_HSW > 0) {
                            console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF-STRING-WORKING para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum}.`);
                            consecutiveCountsMap.set(consecutiveKey_HSW, 0);

                            const alarmKeyToClear = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
                            if (activeAlarmsMap.has(alarmKeyToClear)) {
                                console.log(`[${getFormattedTimestamp()}] Condição de HALF-STRING-WORKING resolvida para ${plantName} - ${inverterId} - ${halfWorkingProblemDetails}. Será limpo no final.`);
                            }
                        }
                    }
                } else {
                    // Se não deve verificar HALF-STRING-WORKING ou greatestCurrentString está abaixo do limite,
                    // garante que a contagem seja resetada para esta string específica, caso haja uma contagem ativa.
                    let potentialProblemDetails = `String ${stringNum} (Metade Fora)`;
                    if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
                        const mpptToStringsMap = {
                            1: '1,2,3', 2: '4,5,6', 3: '7,8,9', 4: '10,11,12',
                        };
                        const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
                        potentialProblemDetails = `MPPT ${stringNum} (Strings ${mappedStrings}) Metade Fora`;
                    }
                    const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${potentialProblemDetails}`; // ALTERAÇÃO: de HALF_STRING_WORKING para HALF-STRING-WORKING
                    if (consecutiveCountsMap.has(consecutiveKey_HSW) && consecutiveCountsMap.get(consecutiveKey_HSW) > 0) {
                           console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF-STRING-WORKING para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Condição não atendida ou pico de corrente baixo).`);
                           consecutiveCountsMap.set(consecutiveKey_HSW, 0);
                    }
                }
            } // Fim do loop for activeStrings para HALF-STRING-WORKING

        } // Fim do loop principal for dayIpvAlarms

        // --- 2b. Inverter Offline Alarms ---
        const [inverterOfflineAlarms] = await connection.execute(`
            SELECT
                pc.plant_name,
                pc.inverter_id,
                sd.status,
                pc.api_type,
                sd.last_update_time
            FROM
                plant_config pc
            LEFT JOIN
                solar_data sd ON pc.plant_name = sd.plant_name AND pc.inverter_id = sd.inverter_id
                AND sd.last_update_time = (SELECT MAX(last_update_time) FROM solar_data WHERE plant_name = pc.plant_name AND inverter_id = pc.inverter_id)
            WHERE
                (pc.api_type = 'Growatt' AND (sd.last_update_time IS NULL OR sd.last_update_time < NOW() - INTERVAL 30 MINUTE OR sd.status = -1))
                OR
                (pc.api_type = 'Solarman' AND sd.status = -1)
        `);
        // ALTERAÇÃO: Passar alarmType como 'INVERTER-OFFLINE'
        await processDetections(
            inverterOfflineAlarms,
            'INVERTER-OFFLINE', // ALTERAÇÃO: de INVERTER_OFFLINE para INVERTER-OFFLINE
            'Inversor Offline', // problemDetails para INVERTER-OFFLINE
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

            // ALTERAÇÃO: Comparar com o novo nome 'GROWATT-EMAIL-EVENT'
            if (alarm.alarm_type === 'GROWATT-EMAIL-EVENT') {
                continue;
            }

            // ALTERAÇÃO: Comparar com os novos nomes 'STRING-DOWN', 'HALF-STRING-WORKING', 'INVERTER-OFFLINE'
            if (alarm.alarm_type === 'STRING-DOWN' || alarm.alarm_type === 'HALF-STRING-WORKING' || alarm.alarm_type === 'INVERTER-OFFLINE') {
                await connection.execute(
                    `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                    [alarm.alarm_id]
                );
                console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''})`);
                // ALTERAÇÃO: replace do '-' por espaço no Telegram
                await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/-/g, ' ')}</b> ✅\nPlanta: <b>${alarm.plant_name}</b>\nInversor: <b>${alarm.inverter_id}</b>\nDetalhes: ${alarm.problem_details || 'N/A'}`);
            } else {
                await connection.execute(
                    `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                    [alarm.alarm_id]
                );
                console.log(`[${getFormattedTimestamp()}] ALARME LIMPO (Genérico): ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''})`);
                // ALTERAÇÃO: replace do '-' por espaço no Telegram
                await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/-/g, ' ')}</b> ✅\nPlanta: <b>${alarm.plant_name}</b>\nInversor: <b>${alarm.inverter_id}</b>\nDetalhes: ${alarm.problem_details || 'N/A'}`);
            }
        }

        // --- Persistir contagens consecutivas atualizadas ---
        for (const [key, count] of consecutiveCountsMap.entries()) {
            // ALTERAÇÃO: Nova lógica de extração das partes da chave para lidar com '-'
            // Exemplo de chave: TOORU-PGA2_JTM4D4V00P_STRING-DOWN_String 7 (Fora)
            const parts = key.split('_');

            if (parts.length < 4) { // Espera pelo menos 4 partes: plant_name, inverter_id, alarm_type, problem_details
                console.warn(`[${getFormattedTimestamp()}] Chave de contagem consecutiva mal formatada para persistência: ${key}. Pulando.`);
                continue;
            }

            const plantName = parts[0];
            const inverterId = parts[1];
            // O alarm_type agora pode ter hífens, mas não underscores (que são os delimitadores principais)
            // problem_details pode ter qualquer coisa, incluindo hífens e underscores
            // A melhor forma é pegar os dois primeiros e o resto como "alarm_type_problem_details_restante"
            // E depois encontrar o ÚLTIMO UNDERCORE no restante para separar alarm_type do problem_details.

            const remainingParts = parts.slice(2); // Pega as partes que contêm alarm_type e problem_details
            
            // Encontra o índice do ÚLTIMO '_' no array remainingParts que indica a separação final
            // Ex: ['STRING-DOWN', 'String 7 (Fora)'] => last underscore is in between
            // Ex: ['HALF-STRING-WORKING', 'MPPT 1 (Strings 1,2,3) Metade Fora']
            let alarmType = '';
            let problemDetails = '';

            // Se há mais de 1 parte no remainingParts, a última é o problemDetails
            if (remainingParts.length > 1) {
                problemDetails = remainingParts[remainingParts.length - 1];
                alarmType = remainingParts.slice(0, remainingParts.length - 1).join('_'); // Junta o resto, pode ter sido quebrado por underscore
            } else { // Caso só tenha uma parte (ex: "INVERTER-OFFLINE_Inversor Offline")
                const lastHyphenIndex = remainingParts[0].lastIndexOf('-');
                if (lastHyphenIndex !== -1) {
                    alarmType = remainingParts[0].substring(0, lastHyphenIndex);
                    problemDetails = remainingParts[0].substring(lastHyphenIndex + 1);
                } else {
                    alarmType = remainingParts[0]; // Sem detalhes, ou tipo sem hífen
                    problemDetails = ''; // Ou definir como uma string padrão vazia
                }
            }


            // CORREÇÃO FINAL SIMPLES: A chave foi construída como plant_inverter_alarmType_problemDetails
            // Onde alarmType já foi definido com hífens.
            // Então o split original por '_' ainda funciona, precisamos apenas remontar alarmType
            // E tratar problemDetails como a última parte.
            // A forma mais direta é:
            const problemDetailsStartIndex = key.indexOf(parts[2]); // A partir de onde alarmType começa
            const problemDetailsActual = key.substring(key.indexOf('_', key.indexOf('_') + 1) + 1); // Tudo após o segundo underscore
            
            // A nova estratégia será mais simples: a chave é `plant_inverter_ALARM_TYPE-PROBLEM_DETAILS_Problem Details`
            // Não, a chave é `plant_inverter_ALARM-TYPE_Problem Details`
            // Então, separamos por `_` duas vezes e o restante é o `ALARM-TYPE_Problem Details`
            // E dentro desse restante, o último `_` é o separador.

            // Re-evaluating the key structure and parsing.
            // The key is always `${plantName}_${inverterId}_${alarmType}_${problemDetails}`
            // where alarmType is e.g. "STRING-DOWN" or "HALF-STRING-WORKING"
            // and problemDetails is e.g. "String 7 (Fora)" or "MPPT 1 (Strings 1,2,3) Metade Fora"

            // Let's use the simplest and most robust approach:
            // Find the last underscore for problemDetails.
            // Find the second to last underscore for alarmType.

            const finalProblemDetailsLastUnderscoreIndex = key.lastIndexOf('_');
            const finalProblemDetails = key.substring(finalProblemDetailsLastUnderscoreIndex + 1);

            const potentialAlarmTypeString = key.substring(0, finalProblemDetailsLastUnderscoreIndex);
            const finalAlarmTypeLastUnderscoreIndex = potentialAlarmTypeString.lastIndexOf('_');
            const finalAlarmType = potentialAlarmTypeString.substring(finalAlarmTypeLastUnderscoreIndex + 1);

            const finalPlantName = key.substring(0, key.indexOf('_'));
            const finalInverterId = key.substring(key.indexOf('_') + 1, finalAlarmTypeLastUnderscoreIndex);


            console.log(`[${getFormattedTimestamp()}] DEBUG - Salvando no DB: Plant='${finalPlantName}', Inverter='${finalInverterId}', AlarmType='${finalAlarmType}', ProblemDetails='${finalProblemDetails}', Count=${count}`);

            if (count > 0) {
                await connection.execute(
                    `INSERT INTO consecutive_alarm_counts (plant_name, inverter_id, alarm_type, problem_details, consecutive_count, last_detected_at)
                     VALUES (?, ?, ?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE consecutive_count = VALUES(consecutive_count), last_detected_at = NOW()`,
                    [finalPlantName, finalInverterId, finalAlarmType, finalProblemDetails, count]
                );
            } else {
                await connection.execute(
                    `DELETE FROM consecutive_alarm_counts
                     WHERE plant_name = ? AND inverter_id = ? AND alarm_type = ? AND problem_details = ?`,
                    [finalPlantName, finalInverterId, finalAlarmType, finalProblemDetails]
                );
            }
        }

        await connection.commit();
    } catch (alarmError) {
        if (connection) {
            await connection.rollback();
        }
        console.error(`[${getFormattedTimestamp()}] Erro ao gerenciar alarmes: ${alarmError.message}`);
        await telegramNotifier.sendTelegramMessage(`❌ <b>ERRO NO GERENCIAMENTO DE ALARMES!</b> ❌\nDetalhes: ${alarmError.message}`);
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
        // ALTERAÇÃO: Chave do mapa agora usa o alarmType com hífens
        const key = `${detection.plant_name}_${detection.inverter_id}_${alarmType}_${problemDetails || ''}`;
        if (!activeAlarmsMap.has(key)) {
            await connection.execute(
                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [detection.plant_name, detection.inverter_id, alarmType, alarmSeverity, problemDetails || '', message]
            );
            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${detection.plant_name}, Inversor: ${detection.inverter_id} (${problemDetails || ''})`);
            // ALTERAÇÃO: replace do '-' por espaço no Telegram
            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> 🚨\nPlanta: <b>${detection.plant_name}</b>\nInversor: <b>${detection.inverter_id}</b>\nDetalhes: ${problemDetails || 'N/A'}\n<i>${message}</i>`);
        }
        stillActiveDetectedKeys.add(key);
    }
}

module.exports = {
    checkAndManageAlarms,
};
