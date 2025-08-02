// emailProcessor.js
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const emailAlarmParsers = require('./emailAlarmParsers'); // Importa o módulo de parsers
const logger = require('./logger')('email');

/**
 * Processes event emails from an IMAP mailbox based on provider type and custom tag.
 * @param {object} imapConfig - IMAP connection configuration.
 * @param {object} pool - MySQL connection pool.
 * @param {object} telegramNotifier - Module for sending Telegram messages.
 * @param {object} diagnosticLogger - Module for logging diagnostic codes.
 * @param {string} providerType - 'growatt' ou 'solarman' (ou outros).
 * @param {string} customTag - The custom IMAP tag to search for (e.g., 'growatt_alert', 'solarman_alert').
 * @param {string} adminChatId - O ID do chat do administrador para deduplicação de notificações de proprietários.
 * @param {boolean} notifyOwners - Flag para habilitar/desabilitar notificação para proprietários.
 */
async function processEmails(imapConfig, pool, telegramNotifier, diagnosticLogger, providerType, customTag, adminChatId, notifyOwners) {
    let connection;
    let imap;

    let parserFunction;
    switch (providerType) {
        case 'growatt':
            parserFunction = emailAlarmParsers.parseGrowattEmail;
            break;
        case 'solarman':
            parserFunction = emailAlarmParsers.parseSolarmanEmail;
            break;
        default:
            logger.warn(`Tipo de provedor desconhecido: ${providerType}. Pulando processamento.`);
            return;
    }

    imap = new Imap(imapConfig);

    // Função auxiliar para "promisificar" uma chamada de callback
    const imapAction = (action) => {
        return new Promise((resolve, reject) => {
            action(resolve, reject);
        });
    };

    try {
        // 1. Conectar ao servidor IMAP
        await imapAction((resolve, reject) => {
            imap.once('ready', resolve);
            imap.once('error', reject);
            imap.connect();
        });

        // 2. Abrir a caixa de entrada
        await imapAction((resolve, reject) => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) return reject(err);
                resolve(box);
            });
        });
        logger.info('Conectado à caixa de entrada IMAP.');

        // 3. Buscar UIDs
        const uids = await imapAction((resolve, reject) => {
            logger.info(`Procurando e-mails para '${providerType}' com a tag customizada: '${customTag}'.`);
            const sinceDate = new Date();
            sinceDate.setDate(sinceDate.getDate() - 1);
            // CORREÇÃO: A biblioteca 'imap' espera um objeto Date diretamente para o critério SINCE.
            // Passar uma string formatada causa o erro "Search option argument must be a Date object...".
            imap.search([['KEYWORD', customTag], ['UNKEYWORD', 'SOLARMON_PROCESSED'], ['SINCE', sinceDate]], (err, searchUids) => {
                if (err) return reject(err);
                resolve(searchUids);
            });
        });

        if (!uids || uids.length === 0) {
            logger.info(`Nenhuma nova notificação de evento ${providerType} marcada com '${customTag}', não processada, e recebida desde o dia anterior encontrada.`);
            return; // A função termina aqui, o 'finally' cuidará de fechar a conexão.
        }

        logger.info(`Encontrados ${uids.length} e-mails de evento ${providerType} (desde o dia anterior, não processados) para processar.`);

        const emailProcessingPromises = uids.map(uid => {
            return (async () => {
                                let connection; // Conexão por e-mail
                                let emailUid = uid; // O UID já é conhecido aqui da busca
                                let emailReceivedAt;
                                let idForFlagOperations = uid; // Usar UID para operações de flag (para addFlags)

                                try {
                                    connection = await pool.getConnection();
                                    await connection.beginTransaction();

                                    logger.info(`Iniciando fetch individual para UID: ${uid}.`);
                                    const f = imap.fetch([uid], { bodies: '', struct: true, attributes: ['uid', 'flags', 'date'] });

                                    // Promise para aguardar a mensagem e seu corpo/parsing
                                    const messageAndBodyPromise = new Promise((resolveMsgBody, rejectMsgBody) => {
                                        const timeoutId = setTimeout(() => {
                                            rejectMsgBody(new Error(`Timeout de 45s ao processar mensagem e corpo para UID: ${uid}`));
                                        }, 45 * 1000); // 45 segundos de timeout (menor que o timeout principal de 60s)

                                        f.on('message', (msg, seqno) => {
                                            logger.info(`Objeto de mensagem recebido para UID #${uid} (seqno: ${seqno}).`);

                                            msg.once('attributes', (attrs) => {
                                                if (attrs && attrs.uid) {
                                                    emailReceivedAt = attrs.date; // Definir data a partir dos atributos
                                                } else {
                                                    logger.warn(`WARN: Não foi possível obter atributos completos para o e-mail UID #${uid}. Usando data atual.`);
                                                    emailReceivedAt = new Date(); 
                                                }
                                                logger.info(`Atributos para e-mail UID: ${uid} processados. Data: ${emailReceivedAt}.`);
                                            });

                                            msg.on('body', (stream, info) => {
                                                let emailBodyBuffer = [];
                                                logger.debug(`Stream 'body' iniciada para UID: ${uid}. Info.which: ${info.which}`); 
                                                
                                                stream.on('data', (chunk) => {
                                                    emailBodyBuffer.push(chunk);
                                                     logger.debug(`Recebido chunk de ${chunk.length} bytes para UID: ${uid}. Total em buffer: ${emailBodyBuffer.reduce((acc, curr) => acc + curr.length, 0)} bytes.`);
                                                });

                                                stream.once('end', async () => {
                                                    const fullEmailBody = Buffer.concat(emailBodyBuffer).toString('utf8');
                                                     logger.debug(`Stream 'body' ENDED para UID: ${uid}. Tamanho total: ${fullEmailBody.length} bytes.`); 
                                                    
                                                    try {
                                                        logger.info(`Iniciando simpleParser para UID: ${uid}...`);
                                                        const parsed = await simpleParser(fullEmailBody);
                                                        clearTimeout(timeoutId);
                                                        resolveMsgBody(parsed); // Resolve a promise principal com o conteúdo parseado
                                                    } catch (parseErr) {
                                                        clearTimeout(timeoutId);
                                                        rejectMsgBody(new Error(`Erro ao analisar e-mail UID: ${uid}: ${parseErr.message}`));
                                                    }
                                                });

                                                stream.once('error', (err) => {
                                                    clearTimeout(timeoutId);
                                                    rejectMsgBody(new Error(`Erro no stream do corpo para e-mail UID: ${uid}: ${err.message}`));
                                                });

                                                stream.resume(); // Explicitamente resume a stream
                                            });

                                            msg.once('error', (err) => { // Captura erros na própria mensagem IMAP antes da stream do corpo
                                                clearTimeout(timeoutId);
                                                rejectMsgBody(new Error(`Erro na mensagem IMAP para e-mail UID: ${uid}: ${err.message}`));
                                            });
                                        });

                                        f.once('error', (err) => { // Erros do fetch em si
                                            clearTimeout(timeoutId);
                                            rejectMsgBody(new Error(`Erro no fetch IMAP para UID: ${uid}: ${err.message}`));
                                        });
                                    });

                                    const parsedEmailContent = await messageAndBodyPromise; // Aguarda a mensagem e seu corpo/parsing

                                    // Deduplicação por email_uid (garante que o mesmo e-mail não seja processado duas vezes)
                                    const [existingAlarmByEmailUid] = await connection.execute(
                                        `SELECT alarm_id FROM alarms WHERE email_uid = ?`,
                                        [emailUid]
                                    );

                                    if (existingAlarmByEmailUid.length > 0) {
                                        logger.info(`E-mail com UID ${emailUid} (${providerType}) já gerou um alarme (ID: ${existingAlarmByEmailUid[0].alarm_id}). Ignorando nova criação/atualização para evitar duplicação de e-mail.`);
                                        await connection.commit(); // Comita a transação vazia
                                        return; 
                                    }

                                    logger.info(`Iniciando processamento do e-mail (UID: ${emailUid}) para ${providerType}`);
                                    
                                    const emailContentToParse = (providerType === 'growatt') ? parsedEmailContent.html || '' : parsedEmailContent.text || '';
                                    
                                    let alarmDetails = null;
                                    if (emailContentToParse.length > 0) {
                                        if (providerType === 'solarman') {
                                            alarmDetails = parserFunction(emailContentToParse, emailReceivedAt);
                                        } else {
                                            alarmDetails = parserFunction(emailContentToParse); 
                                        }
                                    } else {
                                        logger.warn(`WARN: Corpo do e-mail UID: ${emailUid} está vazio. Não é possível extrair detalhes do alarme.`);
                                    }

                                    if (alarmDetails) {
                                        const { inverterId, plantName, eventTimeStr, eventDescription, alarmType, severity } = alarmDetails;

                                        const message = `Evento da ${providerType}: "${eventDescription}" (Planta: ${plantName}, Inversor: ${inverterId})`;
                                        const eventTime = new Date(eventTimeStr);
                                        let alarmHandled = false;

                                        // --- NOVA REGRA: Se for um evento de e-mail Growatt, verificar se já existe um alarme INVERTER-OFFLINE ---
                                        if (alarmType === 'GROWATT-EMAIL-EVENT') {
                                            const [existingOfflineAlarm] = await connection.execute(
                                                `SELECT alarm_id, problem_details FROM alarms
                                                 WHERE plant_name = ? AND inverter_id = ? AND alarm_type = 'INVERTER-OFFLINE' AND cleared_at IS NULL`,
                                                [plantName, inverterId]
                                            );

                                            if (existingOfflineAlarm.length > 0) {
                                                const alarmToUpdate = existingOfflineAlarm[0];
                                                const newProblemDetails = eventDescription;
                                                const newMessage = `Alarme de Inversor Offline atualizado com evento de e-mail: "${eventDescription}"`;

                                                logger.info(`Alarme 'INVERTER-OFFLINE' (ID: ${alarmToUpdate.alarm_id}) encontrado para ${plantName} - ${inverterId}. Atualizando com detalhes do e-mail: "${newProblemDetails}".`);

                                                await connection.execute(
                                                    `UPDATE alarms SET problem_details = ?, message = ?, triggered_at = ?, email_uid = ? WHERE alarm_id = ?`,
                                                    [newProblemDetails, newMessage, eventTime, emailUid, alarmToUpdate.alarm_id]
                                                );

                                                await telegramNotifier.sendTelegramMessage(`🔄 <b>ALARME ATUALIZADO (E-MAIL)</b> 🔄\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nStatus Anterior: Inversor Offline\nNovo Evento: <b>${newProblemDetails}</b>`, adminChatId);

                                                const [plantInfoRows] = await connection.execute(`SELECT owner_chat_id FROM plant_info WHERE plant_name = ?`, [plantName]);
                                                if (plantInfoRows.length > 0 && plantInfoRows[0].owner_chat_id) {
                                                    const ownerChatId = plantInfoRows[0].owner_chat_id;
                                                    if (notifyOwners && ownerChatId && String(ownerChatId) !== String(adminChatId)) {
                                                        const ownerUpdateMessage = `🔄 <b>ALARME ATUALIZADO</b> 🔄\nSua usina <b>${plantName}</b> teve um alarme atualizado:\nInversor: <b>${inverterId}</b>\nNovo Evento: ${newProblemDetails}`;
                                                        await telegramNotifier.sendTelegramMessage(ownerUpdateMessage, ownerChatId);
                                                        logger.info(`Notificação de ALARME ATUALIZADO (E-MAIL) enviada para o proprietário da Planta: ${plantName}`);
                                                    }
                                                }
                                                alarmHandled = true;
                                            }
                                        }

                                        // Se o alarme não foi atualizado pela nova regra, seguir o fluxo normal
                                        if (!alarmHandled) {
                                            logger.info(`Email Parsed (${providerType}, UID: ${emailUid}): Planta: ${plantName}, Inversor: ${inverterId}, Evento: "${eventDescription}"`);

                                            // Deduplicação por problema ATIVO (mesma planta, inversor, tipo, detalhes e não limpo)
                                            const [existingActiveAlarms] = await connection.execute(
                                                `SELECT alarm_id FROM alarms
                                                 WHERE plant_name = ? AND inverter_id = ? AND alarm_type = ? AND problem_details = ? AND cleared_at IS NULL`,
                                                [plantName, inverterId, alarmType, eventDescription]
                                            );

                                            if (existingActiveAlarms.length === 0) {
                                                const [insertResult] = await connection.execute(
                                                    `INSERT INTO alarms (plant_name, inverter_id, alarm_type, problem_details, alarm_severity, message, triggered_at, email_uid)
                                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                                    [plantName, inverterId, alarmType, eventDescription, severity, message, eventTime, emailUid]
                                                );
                                                const currentAlarmId = insertResult.insertId;                                            
                                                logger.info(`NOVO ALARME REGISTRADO (${providerType}): ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} - "${eventDescription}" (E-mail UID: ${emailUid}, Alarm ID: ${currentAlarmId})`);
                                                
                                                await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME (E-MAIL ${providerType.toUpperCase()})</b> 🚨\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nEvento: <b>${eventDescription}</b>`, adminChatId);

                                                const [plantInfoRows] = await connection.execute(
                                                    `SELECT owner_chat_id FROM plant_info WHERE plant_name = ?`,
                                                    [plantName]
                                                );

                                                if (plantInfoRows.length > 0 && plantInfoRows[0].owner_chat_id) {
                                                    const ownerChatId = plantInfoRows[0].owner_chat_id;
                                                    if (notifyOwners && ownerChatId && String(ownerChatId) !== String(adminChatId)) { 
                                                        const ownerAlarmMessage = `🚨 <b>NOVO ALARME</b> 🚨\nSua usina <b>${plantName}</b> está com um alerta:\nInversor: <b>${inverterId}</b>\nDetalhes: ${eventDescription}`;
                                                        await telegramNotifier.sendTelegramMessage(ownerAlarmMessage, ownerChatId);
                                                        logger.info(`Notificação de NOVO ALARME (E-MAIL) enviada para o proprietário da Planta: ${plantName}`);
                                                    } else if (String(ownerChatId) === String(adminChatId)) {
                                                        logger.info(`Proprietário da planta ${plantName} é o mesmo que o ADMIN, notificação de alarme enviada apenas uma vez.`);
                                                    }
                                                }
                                            } else {
                                                const currentAlarmId = existingActiveAlarms[0].alarm_id;
                                                await connection.execute(
                                                    `UPDATE alarms SET triggered_at = ?, email_uid = ? WHERE alarm_id = ?`,
                                                    [eventTime, emailUid, currentAlarmId]
                                                );
                                                logger.info(`ALARME ATIVO ATUALIZADO (${providerType}): ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} - "${eventDescription}" (Atualizado com E-mail UID: ${emailUid}, Alarm ID: ${currentAlarmId})`);
                                            }
                                        }

                                        if (providerType === 'growatt') {
                                            if (alarmDetails && alarmDetails.plantName && alarmDetails.inverterId) {
                                                await diagnosticLogger.captureAndSaveDiagnosticCodes(connection, alarmDetails.plantName, alarmDetails.inverterId, alarmDetails.eventDescription);
                                            } else {
                                                logger.warn(`WARN: Não foi possível capturar códigos de diagnóstico para e-mail UID: ${emailUid} devido a informações de planta/inversor ausentes.`);
                                            }
                                        }
                                        
                                    } else {
                                        logger.warn(`WARN: AlarmDetails são nulos para e-mail UID: ${emailUid}. O e-mail pode não ter um formato esperado para alarme.`);
                                    }

                                    await connection.commit();
                                    logger.info(`Transação MySQL para e-mail UID ${emailUid} comitada com sucesso.`);

                                } catch (mainError) {
                                    logger.error(`ERRO PRINCIPAL no processamento do e-mail UID: ${emailUid}: ${mainError.message}`);
                                    if (connection) {
                                        await connection.rollback();
                                        logger.info(`Transação MySQL para e-mail UID ${emailUid} revertida devido a erro.`);
                                    }
                                    throw mainError; // Re-throw para ser pego pelo Promise.allSettled
                                } finally { // Bloco finally principal para marcar o e-mail como processado
                                    if (connection) {
                                        connection.release();
                                    }
                                    // Adiciona a flag \Seen e 'SOLARMON_PROCESSED'. Envolvemos em uma Promise
                                    // para forçar o 'await' e garantir que a operação termine antes de prosseguir.
                                    if (idForFlagOperations) { 
                                        await new Promise((resolveFlag, rejectFlag) => {
                                            imap.addFlags(idForFlagOperations, ['\\Seen', 'SOLARMON_PROCESSED'], (err) => {
                                                if (err) {
                                                    // Logamos o erro mas não rejeitamos a promessa para não parar todo o fluxo
                                                    logger.error(`Erro ao adicionar flags ('\\Seen', 'SOLARMON_PROCESSED') ao e-mail ${idForFlagOperations} (${providerType}): ${err.message}`);
                                                } else {
                                                    logger.info(`E-mail ${idForFlagOperations} para ${providerType} marcado como lido e com flag 'SOLARMON_PROCESSED'.`);
                                                }
                                                resolveFlag(); // Resolve a promessa para que o await possa continuar.
                                            });
                                        });
                                    } else {
                                        logger.warn(`WARN: Não foi possível realizar operações de flag para e-mail UID #${uid} devido à falta de idForFlagOperations.`);
                                    }
                                }
                            })();
        });

        const results = await Promise.allSettled(emailProcessingPromises);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.error(`Processamento do e-mail UID ${uids[index]} falhou: ${result.reason}`);
            }
        });

    } catch (error) {
        logger.error(`Erro no processamento de e-mails para ${providerType}: ${error.message}`);
        throw error; // Relança o erro para que o Promise.race no chamador possa capturá-lo.
    } finally {
        if (imap) {
            logger.info(`Encerrando conexão IMAP para ${providerType}.`);
            imap.end();
        }
    }
}

module.exports = {
    processEmails,
};
