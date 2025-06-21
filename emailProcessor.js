// emailProcessor.js
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const emailAlarmParsers = require('./emailAlarmParsers'); // Importa o módulo de parsers
const { getFormattedTimestamp } = require('./utils');

// A tag customizada não é mais uma constante global aqui, mas passada como parâmetro
// para permitir diferentes tags (growatt_alert, solarman_alert).

/**
 * Processes event emails from an IMAP mailbox based on provider type and custom tag.
 * @param {object} imapConfig - IMAP connection configuration.
 * @param {object} pool - MySQL connection pool.
 * @param {object} telegramNotifier - Module for sending Telegram messages.
 * @param {object} diagnosticLogger - Module for logging diagnostic codes.
 * @param {string} providerType - 'growatt' or 'solarman' (or others).
 * @param {string} customTag - The custom IMAP tag to search for (e.g., 'growatt_alert', 'solarman_alert').
 */
async function processEmails(imapConfig, pool, telegramNotifier, diagnosticLogger, providerType, customTag) {
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
            console.warn(`[${getFormattedTimestamp()}] Tipo de provedor desconhecido: ${providerType}. Pulando processamento.`);
            return;
    }

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        imap = new Imap(imapConfig);

        await new Promise((resolve, reject) => {
            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        imap.end();
                        return reject(err);
                    }
                    console.log(`[${getFormattedTimestamp()}] Conectado à caixa de entrada IMAP.`);
                    console.log(`[${getFormattedTimestamp()}] Procurando e-mails para '${providerType}' com a tag customizada: '${customTag}'.`);

                    imap.search([['KEYWORD', customTag]], (err, uids) => {
                        if (err) {
                            console.error(`[${getFormattedTimestamp()}] Erro na busca IMAP para ${providerType}:`, err);
                            imap.end();
                            return reject(err);
                        }

                        if (!uids || uids.length === 0) {
                            console.log(`[${getFormattedTimestamp()}] Nenhuma nova notificação de evento ${providerType} marcada com '${customTag}' encontrada.`);
                            imap.end();
                            return resolve();
                        }

                        console.log(`[${getFormattedTimestamp()}] Encontrados ${uids.length} e-mails de evento ${providerType} para processar.`);

                        const fetch = imap.fetch(uids, { bodies: '', struct: true });
                        const emailPromises = [];

                        fetch.on('message', (msg, seqno) => {
                            console.log(`[${getFormattedTimestamp()}] Iniciando processamento do e-mail #${seqno} (UID: ${msg.attributes.uid}) para ${providerType}`);
                            let emailBody = '';
                            const emailUid = msg.attributes.uid;
                            const emailReceivedAt = msg.attributes.date; // Captura a data/hora de recebimento do e-mail

                            const emailProcessingPromise = new Promise((resolveMessage, rejectMessage) => {
                                msg.on('body', (stream, info) => {
                                    stream.on('data', (chunk) => {
                                        emailBody += chunk.toString();
                                    });
                                });

                                msg.once('end', async () => {
                                    try {
                                        const parsed = await simpleParser(emailBody);
                                        const emailText = parsed.text;

                                        let alarmDetails;
                                        if (providerType === 'solarman') {
                                            // Passa emailReceivedAt para a função de parsing da Solarman
                                            alarmDetails = parserFunction(emailText, emailReceivedAt);
                                        } else {
                                            alarmDetails = parserFunction(emailText);
                                        }

                                        if (alarmDetails) {
                                            const { inverterId, plantName, eventTimeStr, eventDescription, alarmType, severity } = alarmDetails;

                                            console.log(`[${getFormattedTimestamp()}] Email Parsed (${providerType}, UID: ${emailUid}): Planta: ${plantName}, Inversor: ${inverterId}, Evento: "${eventDescription}"`);

                                            const message = `Evento da ${providerType}: "${eventDescription}" (Planta: ${plantName}, Inversor: ${inverterId})`;
                                            // Cria Date diretamente do string formatado vindo do parser
                                            const eventTime = new Date(eventTimeStr);

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
                                                console.log(`[${getFormattedTimestamp()}] NOVO ALARME REGISTRADO (${providerType}): ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} - "${eventDescription}" (E-mail UID: ${emailUid}, Alarm ID: ${currentAlarmId})`);
                                                await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME (E-MAIL ${providerType.toUpperCase()})</b> 🚨\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nEvento: <b>${eventDescription}</b>`);

                                            } else {
                                                const currentAlarmId = existingActiveAlarms[0].alarm_id;
                                                await connection.execute(
                                                    `UPDATE alarms SET triggered_at = ?, email_uid = ? WHERE alarm_id = ?`,
                                                    [eventTime, emailUid, currentAlarmId]
                                                );
                                                console.log(`[${getFormattedTimestamp()}] ALARME ATIVO ATUALIZADO (${providerType}): ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} - "${eventDescription}" (Atualizado com E-mail UID: ${emailUid}, Alarm ID: ${currentAlarmId})`);
                                            }

                                            if (providerType === 'growatt') {
                                                await diagnosticLogger.captureAndSaveDiagnosticCodes(connection, plantName, inverterId, eventDescription);
                                            }

                                            // Remove a customTag específica
                                            imap.delFlags(emailUid, [customTag], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao remover flag '${customTag}' do e-mail ${emailUid} para ${providerType}:`, err.message);
                                                else console.log(`[${getFormattedTimestamp()}] Flag '${customTag}' removida do e-mail ${emailUid} para ${providerType}.`);
                                            });
                                            imap.addFlags(emailUid, ['\\Seen'], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao marcar e-mail ${emailUid} como lido para ${providerType}:`, err.message);
                                                else console.log(`[${getFormattedTimestamp()}] E-mail ${emailUid} para ${providerType} marcado como lido.`);
                                            });
                                            resolveMessage();
                                        } else {
                                            console.warn(`[${getFormattedTimestamp()}] Não foi possível extrair dados do e-mail (${providerType}, UID: ${emailUid}) com a tag "${customTag}". Verifique o formato do corpo do e-mail.`);
                                            // Se o parsing falhou, ainda remove a tag e marca como lido para não re-processar
                                            imap.delFlags(emailUid, [customTag], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao remover flag '${customTag}' do e-mail ${emailUid} (${providerType}, parsing falho):`, err.message);
                                            });
                                            imap.addFlags(emailUid, ['\\Seen'], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao marcar e-mail ${emailUid} como lido (${providerType}, parsing falho):`, err.message);
                                            });
                                            resolveMessage();
                                        }
                                    } catch (parseOrDbError) {
                                        console.error(`[${getFormattedTimestamp()}] Erro ao analisar e-mail ou registrar alarme (${providerType}, UID: ${emailUid}):`, parseOrDbError.message);
                                        // Em caso de erro, remove a tag e marca como lido para evitar loop infinito de erro
                                        imap.delFlags(emailUid, [customTag], (err) => {
                                            if (err) console.error(`[${getFormattedTimestamp()}] Erro ao remover flag '${customTag}' do e-mail ${emailUid} (${providerType}, erro interno):`, err.message);
                                        });
                                        imap.addFlags(emailUid, ['\\Seen'], (err) => {
                                            if (err) console.error(`[${getFormattedTimestamp()}] Erro ao marcar e-mail ${emailUid} como lido (${providerType}, erro interno):`, err.message);
                                        });
                                        rejectMessage(parseOrDbError);
                                    }
                                });
                            });
                            emailPromises.push(emailProcessingPromise);
                        });

                        fetch.once('error', (fetchErr) => {
                            console.error(`[${getFormattedTimestamp()}] Erro no fetch de e-mails para ${providerType}:`, fetchErr);
                            imap.end();
                            reject(fetchErr);
                        });

                        fetch.once('end', () => {
                            console.log(`[${getFormattedTimestamp()}] Todos os e-mails para ${providerType} foram enviados para processamento individual. Aguardando conclusão...`);
                            Promise.all(emailPromises)
                                .then(() => {
                                    imap.end();
                                    resolve();
                                })
                                .catch(allPromisesError => {
                                    console.error(`[${getFormattedTimestamp()}] Um ou mais e-mails de ${providerType} falharam no processamento:`, allPromisesError);
                                    imap.end();
                                    reject(allPromisesError);
                                });
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                console.error(`[${getFormattedTimestamp()}] Erro de conexão IMAP para ${providerType}:`, err);
                imap.end();
                reject(err);
            });

            imap.once('end', async () => {
                console.log(`[${getFormattedTimestamp()}] Conexão IMAP encerrada para ${providerType}.`);
            });

            imap.connect();
        });

        await connection.commit();
        console.log(`[${getFormattedTimestamp()}] Transação MySQL comitada com sucesso para ${providerType}.`);

    } catch (scriptError) {
        if (connection) {
            await connection.rollback();
            console.log(`[${getFormattedTimestamp()}] Transação MySQL revertida devido a erro para ${providerType}.`);
        }
        throw scriptError;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

module.exports = {
    processEmails,
};
