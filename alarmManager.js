const telegramNotifier = require('./telegramNotifier');
const { getFormattedTimestamp } = require('./utils');

// Constante para definir o período de carência (em minutos) após a recuperação do servidor Growatt
const GROWATT_RECOVERY_GRACE_PERIOD_MINUTES = 18; // 18 minutos = 3 ciclos de 5min após o servidor voltar

/**
 * Checks for and manages alarm conditions based on data in solar_data and plant_config.
 * @param {object} pool - The MySQL connection pool.
 * @param {string} adminChatId - O ID do chat do administrador para deduplicação de notificações de proprietários.
 */
async function checkAndManageAlarms(pool, adminChatId) { // Adicionado adminChatId aqui
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

        // NOVO: Initialize stillActiveDetectedKeys with ALL currently active string/MPPT/offline alarms.
        // These types should persist overnight or during periods of no data/low production.
        const stillActiveDetectedKeys = new Set();
        for (const [key, alarm] of activeAlarmsMap.entries()) {
            if (alarm.alarm_type === 'STRING-DOWN' ||
                alarm.alarm_type === 'HALF-STRING-WORKING' ||
                alarm.alarm_type === 'MPPT-ONE-STRING-DOWN' ||
                alarm.alarm_type === 'MPPT-TWO-STRINGS-DOWN' ||
                alarm.alarm_type === 'INVERTER-OFFLINE') {
                stillActiveDetectedKeys.add(key);
            }
            // Alarmes de e-mail (GROWATT-EMAIL-EVENT, SOLARMAN-EMAIL-EVENT) NÃO são adicionados aqui,
            // pois têm lógica de limpeza diferente (manual via dashboard).
        }


        const [consecutiveCountsRows] = await connection.execute(
            `SELECT plant_name, inverter_id, alarm_type, consecutive_count, problem_details
             FROM consecutive_alarm_counts
             WHERE alarm_type IN ('HALF-STRING-WORKING', 'STRING-DOWN', 'MPPT-ONE-STRING-DOWN', 'MPPT-TWO-STRINGS-DOWN')` // Incluído novos tipos de alarme aqui
        );
        const consecutiveCountsMap = new Map();
        consecutiveCountsRows.forEach(row => {
            const key = `${row.plant_name}_${row.inverter_id}_${row.alarm_type}_${row.problem_details || ''}`;
            consecutiveCountsMap.set(key, row.consecutive_count);
        });

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
                pc.api_type,
                pi.owner_chat_id
            FROM solar_data sd
            JOIN plant_config pc ON sd.plant_name = pc.plant_name AND sd.inverter_id = pc.inverter_id
            LEFT JOIN plant_info pi ON sd.plant_name = pi.plant_name
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

        // NOVO: Buscar contagens consecutivas existentes para HALF-STRING-WORKING e STRING-DOWN e MPPT
        // A query já está atualizada acima para incluir os novos tipos de alarme na cláusula WHERE.

        // --- Loop principal de detecção e gerenciamento de alarmes ---
        for (const detection of dayIpvAlarms) {
            const plantName = detection.plant_name;
            const inverterId = detection.inverter_id;
            const greatestCurrentString = detection.greatest_current_string;
            const stringGroupingType = detection.string_grouping_type;
            const apiType = detection.api_type;
            const ownerChatId = detection.owner_chat_id;

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
			        // Enviar para o ADMIN
			        await telegramNotifier.sendTelegramMessage(`🔴 <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> 🔴\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nDetalhes: ${telegramMessageDetails}\nProdução da String ${stringNum}: ${stringCurrentValue.toFixed(2)}A\nPico do Inversor: ${greatestCurrentString.toFixed(2)}A`);
			        // Enviar para o PROPRIETÁRIO (se diferente do ADMIN e ownerChatId existir)
			        if (ownerChatId && ownerChatId !== adminChatId) {
			            const ownerAlarmMessage = `🚨 <b>NOVO ALARME</b> 🚨\nSua usina <b>${plantName}</b> está com um alerta:\nInversor: <b>${inverterId}</b>\nDetalhes: ${telegramMessageDetails}\nProdução da String ${stringNum}: ${stringCurrentValue.toFixed(2)}A`;
			            await telegramNotifier.sendTelegramMessage(ownerAlarmMessage, ownerChatId);
			            console.log(`[${getFormattedTimestamp()}] Notificação de ALARME enviada para o proprietário da Planta: ${plantName}.`);
			        }
			    }
			    stillActiveDetectedKeys.add(alarmKey); // Ensure alarm is in the set
		        } else {
			    console.log(`[${getFormattedTimestamp()}] STRING-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_SD}/2) - Alarme não disparado ainda.`);
		        }
		    } else { // String is producing > 0.5A (recovery)
		        // A string está produzindo acima do limite de "quase zero" (0.5A) E o inversor está ativo.
		        // Isso significa que a condição de STRING-DOWN não é mais atendida. Reseta a contagem.
		        if (consecutiveCount_SD > 0) { // Only reset if it was previously in a "down" state
			    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para STRING-DOWN para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (String produziu acima de 0.5A).`);
			    consecutiveCountsMap.set(consecutiveKey_SD, 0);
    
			    const alarmKeyToClear = `${plantName}_${inverterId}_${alarmType}_${problemDetailsForAlarm}`;
			    // Explicitly remove from stillActiveDetectedKeys if the condition is resolved
			    if (stillActiveDetectedKeys.has(alarmKeyToClear)) {
			        stillActiveDetectedKeys.delete(alarmKeyToClear);
			        console.log(`[${getFormattedTimestamp()}] Condição de STRING-DOWN resolvida para ${plantName} - ${inverterId} - ${problemDetailsForAlarm}. Removido de stillActiveDetectedKeys.`);
			    }
		        }
		    }
	        } else { // greatestCurrentString <= 8.0 (Inverter not producing enough, like at night or total offline)
		    // The consecutive count is kept as is (NOT reset).
		    // The alarm would have been added to stillActiveDetectedKeys at the start of this run if it was active in the DB.
		    // No need to add/remove from stillActiveDetectedKeys here, it remains "sticky".
		    if (consecutiveCount_SD > 0) {
		        console.log(`[${getFormattedTimestamp()}] STRING-DOWN em espera para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Inversor com baixa produção geral. Contagem mantida: ${consecutiveCount_SD}).`);
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
    
	        const mpptToStringsMap = {
		    1: '1,2,3', 2: '4,5,6', 3: '7,8,9', 4: '10,11,12',
	        };
	        const mappedStrings = mpptToStringsMap[stringNum] || `MPPT ${stringNum}`;
	        const problemDetailsOne = `MPPT ${stringNum} (Strings ${mappedStrings}) Uma delas Fora`;
	        const problemDetailsTwo = `MPPT ${stringNum} (Strings ${mappedStrings}) Duas delas Fora`;
	        const halfWorkingProblemDetails = `String ${stringNum} (Metade Fora)`;
    
	        const consecutiveKeyOne = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
	        const consecutiveKeyTwo = `${plantName}_${inverterId}_MPPT-TWO-STRINGS-DOWN_${problemDetailsTwo}`;
	        const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
    
	        let consecutiveCount_OSD = consecutiveCountsMap.get(consecutiveKeyOne) || 0;
	        let consecutiveCount_TSD = consecutiveCountsMap.get(consecutiveKeyTwo) || 0;
	        let consecutiveCount_HSW = consecutiveCountsMap.get(consecutiveKey_HSW) || 0;
    
	        if (greatestCurrentString < 13.0) { // Inverter not producing enough for MPPT partial fault analysis
		    // The consecutive counts are kept as is (NOT reset).
		    // The alarms would have been added to stillActiveDetectedKeys at the start of this run if active in DB.
		    // No need to add/remove from stillActiveDetectedKeys here, they remain "sticky".
		    if (consecutiveCount_OSD > 0) {
		        console.log(`[${getFormattedTimestamp()}] MPPT-ONE-STRING-DOWN em espera para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Pico de corrente baixo. Contagem mantida: ${consecutiveCount_OSD}).`);
		    }
		    if (consecutiveCount_TSD > 0) {
		        console.log(`[${getFormattedTimestamp()}] MPPT-TWO-STRINGS-DOWN em espera para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Pico de corrente baixo. Contagem mantida: ${consecutiveCount_TSD}).`);
		    }
		    if (consecutiveCount_HSW > 0) {
		        console.log(`[${getFormattedTimestamp()}] HALF-STRING-WORKING em espera para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Pico de corrente baixo. Contagem mantida: ${consecutiveCount_HSW}).`);
		    }
		    continue; // Pula a verificação de detecção para esta string com baixa produção geral
	        }
    
	        // --- SE greatestCurrentString >= 13.0 (Inversor está produzindo o suficiente) ---
	        // Agora podemos avaliar as condições dos alarmes parciais e resetar/incrementar as contagens.
    
	        // --- Lógica de Detecção para Solarman (ALL_3P) ---
	        if (apiType === 'Solarman' || stringGroupingType === 'ALL_3P') {
		    const lowerOneThreshold = 0.50 * greatestCurrentString;
		    const upperOneThreshold = 0.80 * greatestCurrentString;
		    const lowerTwoThreshold = 0.15 * greatestCurrentString;
		    const upperTwoThreshold = 0.45 * greatestCurrentString;
    
		    let detectedOneOut = false;
		    let detectedTwoOut = false;
    
		    if (currentStringValue >= lowerTwoThreshold && currentStringValue <= upperTwoThreshold) {
		        detectedTwoOut = true;
		    } else if (currentStringValue >= lowerOneThreshold && currentStringValue <= upperOneThreshold) {
		        detectedOneOut = true;
		    }
    
		    // Processa o alarme "Duas strings fora"
		    if (detectedTwoOut) {
		        consecutiveCount_TSD++;
		        consecutiveCountsMap.set(consecutiveKeyTwo, consecutiveCount_TSD);
    
		        if (consecutiveCount_TSD >= 4) {
			    const alarmType = 'MPPT-TWO-STRINGS-DOWN';
			    const alarmSeverity = 'High';
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
			        if (ownerChatId && ownerChatId !== adminChatId) {
			            const ownerAlarmMessage = `🚨 <b>NOVO ALARME</b> 🚨\nSua usina <b>${plantName}</b> está com um alerta:\nInversor: <b>${inverterId}</b>\nDetalhes: ${problemDetailsTwo}\nProdução do MPPT ${stringNum}: ${currentStringValue.toFixed(2)}A`;
			            await telegramNotifier.sendTelegramMessage(ownerAlarmMessage, ownerChatId);
			            console.log(`[${getFormattedTimestamp()}] Notificação de ALARME enviada para o proprietário da Planta: ${plantName}.`);
			        }
			    }
			    stillActiveDetectedKeys.add(alarmKey); // Ensure alarm is in the set
		        } else {
			    console.log(`[${getFormattedTimestamp()}] MPPT-TWO-STRINGS-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Contagem consecutiva: ${consecutiveCount_TSD}/4) - Alarme não disparado ainda.`);
		        }
		        // Garante que o alarme de 'Uma string fora' seja resetado se 'Duas strings fora' for detectado
		        if (consecutiveCount_OSD > 0) {
			    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para MPPT-ONE-STRING-DOWN (detectado TWO-STRINGS-DOWN).`);
			    consecutiveCountsMap.set(consecutiveKeyOne, 0);
			    const alarmKeyToClear = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
			    if (stillActiveDetectedKeys.has(alarmKeyToClear)) {
			        stillActiveDetectedKeys.delete(alarmKeyToClear);
			        console.log(`[${getFormattedTimestamp()}] Condição de MPPT-ONE-STRING-DOWN resolvida. Removido de stillActiveDetectedKeys.`);
			    }
		        }
		    } else { // "Duas strings fora" NÃO detectado neste ciclo
		        if (consecutiveCount_TSD > 0) {
			    console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para MPPT-TWO-STRINGS-DOWN... (Condição não atendida).`);
			    consecutiveCountsMap.set(consecutiveKeyTwo, 0);
			    const alarmKeyToClear = `${plantName}_${inverterId}_MPPT-TWO-STRINGS-DOWN_${problemDetailsTwo}`;
			    if (stillActiveDetectedKeys.has(alarmKeyToClear)) {
			        stillActiveDetectedKeys.delete(alarmKeyToClear);
			        console.log(`[${getFormattedTimestamp()}] Condição de MPPT-TWO-STRINGS-DOWN resolvida. Removido de stillActiveDetectedKeys.`);
			    }
		        }
    
		        // Processa o alarme "Uma string fora" (apenas se 'Duas strings fora' não foi detectado)
		        if (detectedOneOut) {
			    consecutiveCount_OSD++;
			    consecutiveCountsMap.set(consecutiveKeyOne, consecutiveCount_OSD);
    
			    if (consecutiveCount_OSD >= 4) {
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
				    if (ownerChatId && ownerChatId !== adminChatId) {
				        const ownerAlarmMessage = `🚨 <b>NOVO ALARME</b> 🚨\nSua usina <b>${plantName}</b> está com um alerta:\nInversor: <b>${inverterId}</b>\nDetalhes: ${problemDetailsOne}\nProdução do MPPT ${stringNum}: ${currentStringValue.toFixed(2)}A`;
				        await telegramNotifier.sendTelegramMessage(ownerAlarmMessage, ownerChatId);
				        console.log(`[${getFormattedTimestamp()}] Notificação de ALARME enviada para o proprietário da Planta: ${plantName}.`);
				    }
			        }
			        stillActiveDetectedKeys.add(alarmKey); // Ensure alarm is in the set
			    } else {
			        console.log(`[${getFormattedTimestamp()}] MPPT-ONE-STRING-DOWN detectado para Planta: ${plantName}, Inversor: ${inverterId}, MPPT: ${stringNum} (Contagem consecutiva: ${consecutiveCount_OSD}/4) - Alarme não disparado ainda.`);
			    }
		        } else { // "Uma string fora" NÃO detectado neste ciclo
			    if (consecutiveCount_OSD > 0) {
			        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para MPPT-ONE-STRING-DOWN... (Condição não atendida).`);
			        consecutiveCountsMap.set(consecutiveKeyOne, 0);
    
			        const alarmKeyToClear = `${plantName}_${inverterId}_MPPT-ONE-STRING-DOWN_${problemDetailsOne}`;
			        if (stillActiveDetectedKeys.has(alarmKeyToClear)) {
				    stillActiveDetectedKeys.delete(alarmKeyToClear);
				    console.log(`[${getFormattedTimestamp()}] Condição de MPPT-ONE-STRING-DOWN resolvida. Removido de stillActiveDetectedKeys.`);
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
    
		        const consecutiveKey_HSW = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
		        
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
				    if (ownerChatId && ownerChatId !== adminChatId) {
				        const ownerAlarmMessage = `🚨 <b>NOVO ALARME</b> 🚨\nSua usina <b>${plantName}</b> está com um alerta:\nInversor: <b>${inverterId}</b>\nDetalhes: ${halfWorkingProblemDetails}\nProdução da String ${stringNum}: ${currentStringValue.toFixed(2)}A`;
				        await telegramNotifier.sendTelegramMessage(ownerAlarmMessage, ownerChatId);
				        console.log(`[${getFormattedTimestamp()}] Notificação de ALARME enviada para o proprietário da Planta: ${plantName}.`);
				    }
			        }
			        stillActiveDetectedKeys.add(alarmKey); // Ensure alarm is in the set
			    } else {
			        console.log(`[${getFormattedTimestamp()}] HALF-STRING-WORKING detectado para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Contagem consecutiva: ${consecutiveCount_HSW}/4) - Alarme não disparado ainda.`);
			    }
		        } else { // Condition HALF-STRING-WORKING NOT met
			    if (consecutiveCount_HSW > 0) {
			        console.log(`[${getFormattedTimestamp()}] Resetando contagem consecutiva para HALF-STRING-WORKING para Planta: ${plantName}, Inversor: ${inverterId}, String: ${stringNum} (Condição não atendida).`);
			        consecutiveCountsMap.set(consecutiveKey_HSW, 0);
    
			        const alarmKeyToClear = `${plantName}_${inverterId}_HALF-STRING-WORKING_${halfWorkingProblemDetails}`;
			        if (stillActiveDetectedKeys.has(alarmKeyToClear)) {
				    stillActiveDetectedKeys.delete(alarmKeyToClear);
				    console.log(`[${getFormattedTimestamp()}] Condição de HALF-STRING-WORKING resolvida para ${plantName} - ${inverterId} - ${halfWorkingProblemDetails}. Removido de stillActiveDetectedKeys.`);
			        }
			    }
		        }
		    }
	        }
	    } // Fim do loop for activeStrings para MPPT Partial Fault
    
        } // Fim do loop principal for dayIpvAlarms

        // --- 2b. Inverter Offline Alarms ---
        const [growattServerStatusRows] = await connection.execute(`
            SELECT recovery_grace_period_until
            FROM growatt_server_status
            WHERE id = 1
        `);
        const growattGracePeriodUntil = growattServerStatusRows.length > 0 ? growattServerStatusRows[0].recovery_grace_period_until : null;

        const [inverterOfflineAlarms] = await connection.execute(`
            SELECT
                pc.plant_name,
                pc.inverter_id,
                sd.status,
                pc.api_type,
                sd.last_update_time,
                pi.owner_chat_id
            FROM
                plant_config pc
            LEFT JOIN
                solar_data sd ON pc.plant_name = sd.plant_name AND pc.inverter_id = sd.inverter_id
                AND sd.last_update_time = (SELECT MAX(last_update_time) FROM solar_data WHERE plant_name = pc.plant_name AND inverter_id = pc.inverter_id)
            LEFT JOIN plant_info pi ON pc.plant_name = pi.plant_name
            WHERE
                (pc.api_type = 'Growatt' AND (sd.last_update_time IS NULL OR sd.last_update_time < NOW() - INTERVAL 30 MINUTE OR sd.status = -1))
                OR
                (pc.api_type = 'Solarman' AND sd.status = -1)
        `);

        const filteredInverterOfflineAlarms = [];
        const now = new Date();

        for (const detection of inverterOfflineAlarms) {
            if (detection.api_type === 'Growatt' && growattGracePeriodUntil && now < growattGracePeriodUntil) {
                console.log(`[${getFormattedTimestamp()}] INVERSOR OFFLINE (Growatt) ignorado durante período de carência para Planta: ${detection.plant_name}, Inversor: ${detection.inverter_id}. Carência termina em: ${growattGracePeriodUntil.toLocaleString()}.`);
            } else {
                filteredInverterOfflineAlarms.push(detection);
            }
        }

        // processDetections will add NEW INVERTER-OFFLINE alarms to stillActiveDetectedKeys.
        // If an INVERTER-OFFLINE alarm from activeAlarmsMap is NOT in filteredInverterOfflineAlarms after this,
        // it implies the inverter came online (or grace period ended), and it will be implicitly cleared by the final loop.
        await processDetections(
            filteredInverterOfflineAlarms,
            'INVERTER-OFFLINE',
            'Inversor Offline',
            'Critical',
            'Inversor está offline ou sem dados recentes (ou status -1).',
            connection,
            activeAlarmsMap,
            stillActiveDetectedKeys,
            adminChatId
        );

        // --- 3. Process alarms that are no longer detected (i.e., they've cleared) ---
        for (const [alarmKey, alarm] of activeAlarmsMap.entries()) {
            // Se o alarme ainda está na lista de "ainda ativos" detectados, ou se é um alarme de email event, PULE a limpeza automática.
            if (stillActiveDetectedKeys.has(alarmKey) || alarm.alarm_type.endsWith('-EMAIL-EVENT')) {
                continue; 
            }

            // Lógica de limpeza para outros alarmes que são limpos automaticamente (String, MPPT, Offline)
            if (alarm.alarm_type === 'STRING-DOWN' || alarm.alarm_type === 'HALF-STRING-WORKING' || alarm.alarm_type === 'INVERTER-OFFLINE' ||
                alarm.alarm_type === 'MPPT-ONE-STRING-DOWN' || alarm.alarm_type === 'MPPT-TWO-STRINGS-DOWN') {
                await connection.execute(
                    `UPDATE alarms SET cleared_at = NOW() WHERE alarm_id = ?`,
                    [alarm.alarm_id]
                );
                console.log(`[${getFormattedTimestamp()}] ALARME LIMPO: ${alarm.alarm_type} para Planta: ${alarm.plant_name}, Inversor: ${alarm.inverter_id} (${alarm.problem_details || ''})`);
                // Enviar para o ADMIN
                await telegramNotifier.sendTelegramMessage(`✅ <b>ALARME RESOLVIDO: ${alarm.alarm_type.replace(/-/g, ' ')}</b> ✅\nPlanta: <b>${alarm.plant_name}</b>\nInversor: <b>${alarm.inverter_id}</b>\nDetalhes: ${alarm.problem_details || 'N/A'}`);
                // Enviar para o PROPRIETÁRIO (se diferente do ADMIN e resolvedOwnerChatId existir)
                const [plantInfo] = await connection.execute( // Re-buscando plantInfo para garantir ownerChatId
                    `SELECT owner_chat_id FROM plant_info WHERE plant_name = ?`,
                    [alarm.plant_name]
                );
                const resolvedOwnerChatId = plantInfo.length > 0 ? plantInfo[0].owner_chat_id : null;
                if (resolvedOwnerChatId && resolvedOwnerChatId !== adminChatId) {
                    const ownerResolvedMessage = `✅ <b>ALARME RESOLVIDO</b> ✅\nSua usina <b>${alarm.plant_name}</b> teve um alarme resolvido:\nInversor: <b>${alarm.inverter_id}</b>\nDetalhes: ${alarm.problem_details || 'N/A'}`;
                    await telegramNotifier.sendTelegramMessage(ownerResolvedMessage, resolvedOwnerChatId);
                    console.log(`[${getFormattedTimestamp()}] Notificação de ALARME RESOLVIDO enviada para o proprietário da Planta: ${alarm.plant_name}.`);
                }
            }
            // Não há mais um "else" genérico aqui. Alarmes que não se enquadram nas condições acima
            // ou que não são explicitamente removidos de stillActiveDetectedKeys NÃO serão limpos automaticamente.
        }

        // --- Persistir contagens consecutivas atualizadas ---
        for (const [key, count] of consecutiveCountsMap.entries()) {
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
 * @param {string} adminChatId - O ID do chat do administrador para deduplicação de notificações de proprietários.
 */
async function processDetections(detections, alarmType, problemDetails, alarmSeverity, message, connection, activeAlarmsMap, stillActiveDetectedKeys, adminChatId) {
    for (const detection of detections) {
        const key = `${detection.plant_name}_${detection.inverter_id}_${alarmType}_${problemDetails || ''}`;
        if (!activeAlarmsMap.has(key)) {
            await connection.execute(
                `INSERT INTO alarms (plant_name, inverter_id, alarm_type, alarm_severity, problem_details, message, triggered_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [detection.plant_name, detection.inverter_id, alarmType, alarmSeverity, problemDetails || '', message]
            );
            console.log(`[${getFormattedTimestamp()}] NOVO ALARME: ${alarmType} para Planta: ${detection.plant_name}, Inversor: ${detection.inverter_id} (${problemDetails || ''})`);
            await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME: ${alarmType.replace(/-/g, ' ')}</b> 🚨\nPlanta: <b>${detection.plant_name}</b>\nInversor: <b>${detection.inverter_id}</b>\nDetalhes: ${problemDetails || 'N/A'}\n<i>${message}</i>`);
            if (detection.owner_chat_id && detection.owner_chat_id !== adminChatId) {
                const ownerAlarmMessage = `🚨 <b>NOVO ALARME</b> 🚨\nSua usina <b>${detection.plant_name}</b> está com um alerta:\nInversor: <b>${detection.inverter_id}</b>\nDetalhes: ${problemDetails || 'N/A'}\n<i>${message}</i>`;
                await telegramNotifier.sendTelegramMessage(ownerAlarmMessage, detection.owner_chat_id);
                console.log(`[${getFormattedTimestamp()}] Notificação de ALARME enviada para o proprietário da Planta: ${detection.plant_name}.`);
            }
        }
        stillActiveDetectedKeys.add(key); // Ensure alarm is in the set
    }
}

module.exports = {
    checkAndManageAlarms,
};

