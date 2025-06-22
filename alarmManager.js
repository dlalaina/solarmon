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
	        const alarmType = 'STRING-DOWN';
	        const alarmSeverity = 'High';
    
	        let problemDetailsForAlarm = `String ${stringNum} (Fora)`;
	        let telegramMessageDetails = `String ${stringNum} (Fora)`;
    
	        if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
		    const mpptToStringsMap = {
		        1: '1,2,3',
		        2: '4,5,6',
		        3: '7,8,9',
		        4: '10,11,12',
		    };
		    const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
		    problemDetailsForAlarm = `MPPT ${stringNum} (Strings ${mappedStrings}) Fora`;
		    telegramMessageDetails = `MPPT ${stringNum} (Strings ${mappedStrings}) Fora`;
	        }
    
	        const consecutiveKey_SD = `${plantName}_${inverterId}_${alarmType}_${problemDetailsForAlarm}`;
	        let consecutiveCount_SD = consecutiveCountsMap.get(consecutiveKey_SD) || 0;
    
	        const stringCurrentValue = detection[currentStringKey] !== undefined ? parseFloat(detection[currentStringKey] || 0) : null;
    
	        if (stringCurrentValue === null) {
		    console.warn(`[${getFormattedTimestamp()}] Dados de currentString${stringNum} não encontrados para Inversor: ${inverterId} na Planta: ${plantName}, apesar de estar em active_strings_config. Pulando esta string.`);
		    continue;
	        }
    
	        // --- CONDIÇÃO CHAVE: Só checa STRING-DOWN se o inversor estiver produzindo ativamente ---
	        if (greatestCurrentString > 8.0) { // O inversor está produzindo o suficiente para a análise
		    if (stringCurrentValue <= 0.5) { // A string está com produção próxima de zero
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
			        await telegramNotifier.sendTelegramMessage(`🔴 <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> 🔴\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${telegramMessageDetails}\nProdução da String ${stringNum}: ${stringCurrentValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
			    }
			    stillActiveDetectedKeys.add(alarmKey);
		        } else {
			    console.log(`[${getFormattedTimestamp()}] STRING-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_SD}/2) - Alarme não disparado ainda.`);
		        }
		    } else {
		        // A string está produzindo acima do limite de "quase zero" (0.5A) E o inversor está ativo.
		        // Isso significa que a condição de STRING-DOWN não é mais atendida. Reseta a contagem.
		        if (consecutiveCount_SD > 0) {
			    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para STRING-DOWN para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (String produziu acima de 0.5A).`);
			    consecutiveCountsMap.set(consecutiveKey_SD, 0);
    
			    const alarmKeyToClear = `${plantName}_${inverterId}_${alarmType}_${problemDetailsForAlarm}`;
			    if (activeAlarmsMap.has(alarmKeyToClear)) {
			        console.log(`[${getFormattedTimestamp()}] Condição de STRING-DOWN resolvida para ${plantName} - ${inverterId} - ${problemDetailsForAlarm}. Será limpo no final.`);
			    }
		        }
		    }
	        } else {
		    // --- SE greatestCurrentString <= 8.0 (Inversor não está produzindo o suficiente) ---
		    // Não fazemos a checagem do alarme, e portanto, NÃO alteramos a contagem consecutiva.
		    // O alarme só será limpo pelo loop final se a sua chave não for re-adicionada à stillActiveDetectedKeys
		    // quando o inversor voltar a produzir e a condição do alarme não for mais detectada.
		    if (consecutiveCount_SD > 0) {
		        console.log(`[${getFormattedTimestamp()}] STRING-DOWN em espera para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Inversor com baixa produção geral. Contagem mantida: ${consecutiveCount_SD}).`);
		    }

            // NOVO: Se o alarme STRING-DOWN para esta string já estiver ativo,
            // e o inversor estiver com baixa produção geral, não o limpe.
            // Mantenha-o na lista de ativos detectados para que não seja removido.
            const alarmKeyForProblemDetails = `String ${stringNum} (Fora)`; // Default problem details
            let problemDetailsKeyForExistingAlarm = alarmKeyForProblemDetails;

            if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
                const mpptToStringsMap = {
                    1: '1,2,3', 2: '4,5,6', 3: '7,8,9', 4: '10,11,12',
                };
                const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
                problemDetailsKeyForExistingAlarm = `MPPT ${stringNum} (Strings ${mappedStrings}) Fora`;
            }
            
            const alarmKey_SD_Full = `${plantName}_${inverterId}_${alarmType}_${problemDetailsKeyForExistingAlarm}`;

            if (activeAlarmsMap.has(alarmKey_SD_Full)) {
                // Se o alarme STRING-DOWN para esta string/MPPT já existe no DB,
                // e o inversor está em baixa produção, mantenha-o como ativo detectado
                stillActiveDetectedKeys.add(alarmKey_SD_Full);
                console.log(`[${getFormattedTimestamp()}] Mantendo alarme STRING-DOWN ativo para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Inversor com baixa produção geral, alarme existente).`);
            }
	        }
	    } // Fim do loop for activeStrings para STRING-DOWN

	    // --- MPPT Partial Fault (ONE-STRING-DOWN / TWO-STRINGS-DOWN) Detection ---
	    for (const stringNum of activeStrings) {
	        const currentStringKey = `currentString${stringNum}`;
	        const currentStringValue = detection[currentStringKey] !== undefined ? parseFloat(detection[currentStringKey] || 0) : null;
    
	        if (currentStringValue === null) {
		    console.warn(`[${getFormattedTimestamp()}] Dados de currentString${stringNum} não encontrados para detecção de falha parcial para Inversor: ${inverterId} na Planta: ${plantName}. Pulando esta string.`);
		    continue;
	        }
    
	        // Define os detalhes comuns para as mensagens de alarme de MPPT (usado no else do greatestCurrentString < 13.0)
	        const mpptToStringsMap = {
		    1: '1,2,3', 2: '4,5,6', 3: '7,8,9', 4: '10,11,12', // Expanda este mapa conforme necessário para seus MPPTs
	        };
	        const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
	        const problemDetailsOne = `MPPT ${stringNum} (Strings ${mappedStrings}) Uma delas Fora`;
	        const problemDetailsTwo = `MPPT ${stringNum} (Strings ${mappedStrings}) Duas delas Fora`;
	        const halfWorkingProblemDetails = `String ${stringNum} (Metade Fora)`; // Para HALF-STRING-WORKING
    
	        // CHAVE: Apenas verifica se o inversor está produzindo o suficiente para fazer uma análise.
	        // Se greatestCurrentString < 13.0, NÃO DEVE RESETAR AS CONTAGENS.
	        if (greatestCurrentString < 13.0) { // Mantenha este limiar de corrente de pico
		    // Se o inversor não está produzindo o suficiente, os alarmes parciais estão "em espera".
		    // NÃO RESETAMOS as contagens consecutivas neste cenário.
		    // Elas só serão resetadas se a condição do alarme for explicitamente resolvida DURANTE o dia.
		    const consecutiveKeyOne = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
		    const consecutiveKeyTwo = `${plantName}_${inverterId}_MPPT-TWO-STRINGS-DOWN_${problemDetailsTwo}`;
		    const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;

                    // --- INÍCIO DA ALTERAÇÃO SUGERIDA PARA MANTER ALARMES ATIVOS ---
                    // Se o alarme já estiver ativo no banco de dados, adicione-o a stillActiveDetectedKeys
                    // para evitar que seja limpo erroneamente devido à baixa produção geral.
                    const alarmKeyOne = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
                    if (activeAlarmsMap.has(alarmKeyOne)) {
                        stillActiveDetectedKeys.add(alarmKeyOne);
                        console.log(`[${getFormattedTimestamp()}] Mantendo alarme MPPT-ONE-STRING-DOWN ativo para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Inversor com baixa produção geral, alarme existente).`);
                    }

                    const alarmKeyTwo = `${plantName}_${inverterId}_MPPT-TWO-STRINGS-DOWN_${problemDetailsTwo}`;
                    if (activeAlarmsMap.has(alarmKeyTwo)) {
                        stillActiveDetectedKeys.add(alarmKeyTwo);
                        console.log(`[${getFormattedTimestamp()}] Mantendo alarme MPPT-TWO-STRINGS-DOWN ativo para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Inversor com baixa produção geral, alarme existente).`);
                    }

                    const alarmKeyHSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
                    if (activeAlarmsMap.has(alarmKeyHSW)) {
                        stillActiveDetectedKeys.add(alarmKeyHSW);
                        console.log(`[${getFormattedTimestamp()}] Mantendo alarme HALF-STRING-WORKING ativo para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Inversor com baixa produção geral, alarme existente).`);
                    }
                    // --- FIM DA ALTERAÇÃO SUGERIDA ---

		    if (consecutiveCountsMap.has(consecutiveKeyOne) && consecutiveCountsMap.get(consecutiveKeyOne) > 0) {
		        console.log(`[${getFormattedTimestamp()}] MPPT-ONE-STRING-DOWN em espera para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Pico de corrente baixo. Contagem mantida: ${consecutiveCountsMap.get(consecutiveKeyOne)}).`);
		    }
		    if (consecutiveCountsMap.has(consecutiveKeyTwo) && consecutiveCountsMap.get(consecutiveKeyTwo) > 0) {
		        console.log(`[${getFormattedTimestamp()}] MPPT-TWO-STRINGS-DOWN em espera para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Pico de corrente baixo. Contagem mantida: ${consecutiveCountsMap.get(consecutiveKeyTwo)}).`);
		    }
		    if (consecutiveCountsMap.has(consecutiveKey_HSW) && consecutiveCountsMap.get(consecutiveKey_HSW) > 0) {
		        console.log(`[${getFormattedTimestamp()}] HALF-STRING-WORKING em espera para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Pico de corrente baixo. Contagem mantida: ${consecutiveCountsMap.get(consecutiveKey_HSW)}).`);
		    }
		    continue; // Pula a verificação de detecção para esta string com baixa produção geral
	        }
    
	        // --- SE greatestCurrentString >= 13.0 (Inversor está produzindo o suficiente) ---
	        // Agora podemos avaliar as condições dos alarmes parciais e resetar/incrementar as contagens.
    
	        // --- Lógica de Detecção para Solarman (ALL_3P) ---
	        if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
		    const consecutiveKeyOne = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
		    const consecutiveKeyTwo = `${plantName}_${inverterId}_MPPT-TWO-STRINGS-DOWN_${problemDetailsTwo}`;
    
		    // Limiares para 3 strings:
		    const lowerOneThreshold = 0.50 * greatestCurrentString;
		    const upperOneThreshold = 0.80 * greatestCurrentString;
		    const lowerTwoThreshold = 0.15 * greatestCurrentString;
		    const upperTwoThreshold = 0.45 * greatestCurrentString;
    
		    let detectedOneOut = false;
		    let detectedTwoOut = false;
    
		    // Verifica "Duas strings fora" primeiro, pois é uma condição mais severa e exclusiva
		    if (currentStringValue >= lowerTwoThreshold && currentStringValue <= upperTwoThreshold) {
		        detectedTwoOut = true;
		    }
		    // Se não detectou duas fora, verifica "Uma string fora"
		    else if (currentStringValue >= lowerOneThreshold && currentStringValue <= upperOneThreshold) {
		        detectedOneOut = true;
		    }
    
		    // Processa o alarme "Duas strings fora"
		    if (detectedTwoOut) {
		        let consecutiveCount_TSD = consecutiveCountsMap.get(consecutiveKeyTwo) || 0;
		        consecutiveCount_TSD++;
		        consecutiveCountsMap.set(consecutiveKeyTwo, consecutiveCount_TSD);
    
		        if (consecutiveCount_TSD >= 4) { // Requer 4 detecções consecutivas
			    const alarmType = 'MPPT-TWO-STRINGS-DOWN';
			    const alarmSeverity = 'High'; // Mais severo
			    const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetailsTwo}`;
    
			    if (!activeAlarmsMap.has(alarmKey)) {
			        const message = `MPPT ${stringNum} (Strings ${mappedStrings}) do inversor ${inverterId} da planta ${plantName} está com produção de ${currentStringValue.toFixed(2)}A, o que está entre ${ (lowerTwoThreshold/greatestCurrentString*100).toFixed(0)}% e ${(upperTwoThreshold/greatestCurrentString*100).toFixed(0)}% da corrente do maior MPPT (${greatestCurrentString.toFixed(2)}A). Isso indica DUAS STRINGS FORA.`;
			        await connection.execute(
				    `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
				     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
				    [plantName, inverterId, alarmType, alarmSeverity, problemDetailsTwo, message]
			        );
			        console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetailsTwo})`);
			        await telegramNotifier.sendTelegramMessage(`🔥 <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> 🔥\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${problemDetailsTwo}\nProdução do MPPT ${stringNum}: ${currentStringValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
			    }
			    stillActiveDetectedKeys.add(alarmKey);
		        } else {
			    console.log(`[${getFormattedTimestamp()}] MPPT-TWO-STRINGS-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Contagem consecutiva: ${consecutiveCount_TSD}/4) - Alarme não disparado ainda.`);
		        }
		        // Garante que o alarme de 'Uma string fora' seja resetado se 'Duas strings fora' for detectado
		        if (consecutiveCountsMap.has(consecutiveKeyOne) && consecutiveCountsMap.get(consecutiveKeyOne) > 0) {
			    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para MPPT-ONE-STRING-DOWN (detectado TWO-STRINGS-DOWN).`);
			    consecutiveCountsMap.set(consecutiveKeyOne, 0);
		        }
    
		    } else {
		        // Se "Duas strings fora" não foi detectado NESTE CICLO, reseta sua contagem
		        if (consecutiveCountsMap.has(consecutiveKeyTwo) && consecutiveCountsMap.get(consecutiveKeyTwo) > 0) {
			    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para MPPT-TWO-STRINGS-DOWN para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Condição não atendida).`);
			    consecutiveCountsMap.set(consecutiveKeyTwo, 0);
			    const alarmKeyToClear = `${plantName}_${inverterId}_MPPT-TWO-STRINGS-DOWN_${problemDetailsTwo}`;
			    if (activeAlarmsMap.has(alarmKeyToClear)) {
			        console.log(`[${getFormattedTimestamp()}] Condição de MPPT-TWO-STRINGS-DOWN resolvida para ${plantName} - ${inverterId} - ${problemDetailsTwo}. Será limpo no final.`);
			    }
		        }
    
		        // Processa o alarme "Uma string fora" (apenas se 'Duas strings fora' não foi detectado)
		        if (detectedOneOut) {
			    let consecutiveCount_OSD = consecutiveCountsMap.get(consecutiveKeyOne) || 0;
			    consecutiveCount_OSD++;
			    consecutiveCountsMap.set(consecutiveKeyOne, consecutiveCount_OSD);
    
			    if (consecutiveCount_OSD >= 4) { // Requer 4 detecções consecutivas
			        const alarmType = 'MPPT-ONE-STRING-DOWN';
			        const alarmSeverity = 'Medium';
			        const alarmKey = `${plantName}_${inverterId}_${alarmType}_${problemDetailsOne}`;
    
			        if (!activeAlarmsMap.has(alarmKey)) {
				    const message = `MPPT ${stringNum} (Strings ${mappedStrings}) do inversor ${inverterId} da planta ${plantName} está com produção de ${currentStringValue.toFixed(2)}A, o que está entre ${ (lowerOneThreshold/greatestCurrentString*100).toFixed(0)}% e ${(upperOneThreshold/greatestCurrentString*100).toFixed(0)}% da corrente do maior MPPT (${greatestCurrentString.toFixed(2)}A). Isso indica UMA STRING FORA.`;
				    await connection.execute(
				        `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
				         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
				        [plantName, inverterId, alarmType, alarmSeverity, problemDetailsOne, message]
				    );
				    console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} (${problemDetailsOne})`);
				    await telegramNotifier.sendTelegramMessage(`⚠️ <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> ⚠️\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${problemDetailsOne}\nProdução do MPPT ${stringNum}: ${currentStringValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
			        }
			        stillActiveDetectedKeys.add(alarmKey);
			    } else {
			        console.log(`[${getFormattedTimestamp()}] MPPT-ONE-STRING-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Contagem consecutiva: ${consecutiveCount_OSD}/4) - Alarme não disparado ainda.`);
			    }
		        } else {
			    // Se "Uma string fora" não foi detectado NESTE CICLO, reseta sua contagem
			    if (consecutiveCountsMap.has(consecutiveKeyOne) && consecutiveCountsMap.get(consecutiveKeyOne) > 0) {
			        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para MPPT-ONE-STRING-DOWN para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Condição não atendida).`);
			        consecutiveCountsMap.set(consecutiveKeyOne, 0);
			        const alarmKeyToClear = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
			        if (activeAlarmsMap.has(alarmKeyToClear)) {
				    console.log(`[${getFormattedTimestamp()}] Condição de MPPT-ONE-STRING-DOWN resolvida para ${plantName} - ${inverterId} - ${problemDetailsOne}. Será limpo no final.`);
			        }
			    }
		        }
		    }
	        }
	        // --- Lógica de Detecção para Outros stringGroupingType (Growatt, 2P etc.) ---
	        else {
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
			    break;
		    }
    
		    if (shouldCheckThisStringForHalfWorking) { // greatestCurrentString >= 13.0 já foi verificado acima
		        const lowerHalfThreshold = 0.30 * greatestCurrentString;
		        const upperHalfThreshold = 0.70 * greatestCurrentString;
    
		        // halfWorkingProblemDetails já definido no escopo superior deste `if (greatestCurrentString < 13.0)`
		        // let halfWorkingProblemDetails = `String ${stringNum} (Metade Fora)`; // Remova esta linha repetida
    
		        const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
		        let consecutiveCount_HSW = consecutiveCountsMap.get(consecutiveKey_HSW) || 0;
    
		        if (currentStringValue >= lowerHalfThreshold && currentStringValue <= upperHalfThreshold && currentStringValue < greatestCurrentString) {
			    consecutiveCount_HSW++;
			    consecutiveCountsMap.set(consecutiveKey_HSW, consecutiveCount_HSW);
    
			    if (consecutiveCount_HSW >= 4) {
			        const alarmType = 'HALF-STRING-WORKING';
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
				    await telegramNotifier.sendTelegramMessage(`⚠️ <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> ⚠️\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${halfWorkingProblemDetails}\nProdução da String ${stringNum}: ${currentStringValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
			        }
			        stillActiveDetectedKeys.add(alarmKey);
			    } else {
			        console.log(`[${getFormattedTimestamp()}] HALF-STRING-WORKING detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_HSW}/4) - Alarme não disparado ainda.`);
			    }
		        } else {
			    // A condição HALF-STRING-WORKING não é mais atendida ENQUANTO o inversor está produzindo ativamente.
			    // Reseta a contagem.
			    if (consecutiveCount_HSW > 0) {
			        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF-STRING-WORKING para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Condição não atendida).`);
			        consecutiveCountsMap.set(consecutiveKey_HSW, 0);
    
			        const alarmKeyToClear = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
			        if (activeAlarmsMap.has(alarmKeyToClear)) {
				    console.log(`[${getFormattedTimestamp()}] Condição de HALF-STRING-WORKING resolvida para ${plantName} - ${inverterId} - ${halfWorkingProblemDetails}. Será limpo no final.`);
			        }
			    }
		        }
		    }
	        }
	    } // Fim do loop for activeStrings para MPPT Partial Fault
    
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
