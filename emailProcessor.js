// emailProcessor.js
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { getFormattedTimestamp } = require('./utils');

const MONITOR_FLAG = 'monitor_unseen';

/**
 * Processes Growatt event emails from an IMAP mailbox.
 * @param {object} imapConfig - IMAP connection configuration.
 * @param {object} pool - MySQL connection pool.
 * @param {object} telegramNotifier - Module for sending Telegram messages.
 * @param {object} diagnosticLogger - Module for logging diagnostic codes.
 */
async function processEmails(imapConfig, pool, telegramNotifier, diagnosticLogger) { // imapConfig agora é um parâmetro
    let connection;
    let imap;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        imap = new Imap(imapConfig); // Usando o imapConfig passado como parâmetro

        await new Promise((resolve, reject) => {
            // ... (restante do código permanece o mesmo) ...
            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        imap.end();
                        return reject(err);
                    }
                    console.log(`[${getFormattedTimestamp()}] Conectado à caixa de entrada IMAP.`);
                    console.log(`[${getFormattedTimestamp()}] Procurando e-mails com a flag customizada: '${MONITOR_FLAG}' e assunto 'Event Report for'.`);

                    imap.search([['SUBJECT', 'Event Report for'], ['KEYWORD', MONITOR_FLAG]], (err, uids) => {
                        if (err) {
                            console.error(`[${getFormattedTimestamp()}] Erro na busca IMAP:`, err);
                            imap.end();
                            return reject(err);
                        }

                        if (!uids || uids.length === 0) {
                            console.log(`[${getFormattedTimestamp()}] Nenhuma nova notificação de evento Growatt marcada com '${MONITOR_FLAG}' e assunto 'Event Report for' encontrada.`);
                            imap.end();
                            return resolve();
                        }

                        console.log(`[${getFormattedTimestamp()}] Encontrados ${uids.length} e-mails de evento Growatt para processar.`);

                        const fetch = imap.fetch(uids, { bodies: '', struct: true });
                        const emailPromises = [];

                        fetch.on('message', (msg, seqno) => {
                            console.log(`[${getFormattedTimestamp()}] Iniciando processamento do e-mail #${seqno}`);
                            let emailBody = '';
                            const emailUid = msg.attributes.uid;

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

                                        const regex = /Device serial number:([^\n]+)\nDevice alias:[^\n]+\nDataLog serial number:[^\n]+\nDataLog alias:[^\n]+\nPlant name:([^\n]+)\nTime:([^\n]+)\nEvent id:([^\(]+)\([^\)]+\)\nEvent description:([^\n]+)\nSuggestion:[^\n]+/;
                                        const match = emailText.match(regex);

                                        if (match) {
                                            const inverterId = match[1].trim();
                                            const plantName = match[2].trim();
                                            const eventTimeStr = match[3].trim();
                                            const eventDescription = match[5].trim();

                                            console.log(`[${getFormattedTimestamp()}] Email Parsed (UID: ${emailUid}): Planta: ${plantName}, Inversor: ${inverterId}, Evento: "${eventDescription}"`);

                                            const alarmType = "GROWATT-EMAIL-EVENT";
                                            const problemDetails = eventDescription;
                                            const severity = "CRITICAL";
                                            const message = `Evento da Growatt: "${eventDescription}" (Planta: ${plantName}, Inversor: ${inverterId})`;

                                            const eventTime = new Date(eventTimeStr.replace(/(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})/, '$1T$2'));

                                            const [existingActiveAlarms] = await connection.execute(
                                                `SELECT alarm_id FROM alarms
                                                 WHERE plant_name = ? AND inverter_id = ? AND alarm_type = ? AND problem_details = ? AND cleared_at IS NULL`,
                                                [plantName, inverterId, alarmType, problemDetails]
                                            );

                                            if (existingActiveAlarms.length === 0) {
                                                const [insertResult] = await connection.execute(
                                                    `INSERT INTO alarms (plant_name, inverter_id, alarm_type, problem_details, alarm_severity, message, triggered_at, email_uid)
                                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                                    [plantName, inverterId, alarmType, problemDetails, severity, message, eventTime, emailUid]
                                                );
                                                const currentAlarmId = insertResult.insertId;
                                                console.log(`[${getFormattedTimestamp()}] NOVO ALARME REGISTRADO: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} - "${problemDetails}" (E-mail UID: ${emailUid}, Alarm ID: ${currentAlarmId})`);
                                                await telegramNotifier.sendTelegramMessage(`🚨 <b>NOVO ALARME (E-MAIL GROWATT)</b> 🚨\nPlanta: <b>${plantName}</b>\nInversor: <b>${inverterId}</b>\nEvento: <b>${eventDescription}</b>`);

                                            } else {
                                                const currentAlarmId = existingActiveAlarms[0].alarm_id;
                                                await connection.execute(
                                                    `UPDATE alarms SET triggered_at = ?, email_uid = ? WHERE alarm_id = ?`,
                                                    [eventTime, emailUid, currentAlarmId]
                                                );
                                                console.log(`[${getFormattedTimestamp()}] ALARME ATIVO ATUALIZADO: ${alarmType} para Planta: ${plantName}, Inversor: ${inverterId} - "${problemDetails}" (Atualizado com E-mail UID: ${emailUid}, Alarm ID: ${currentAlarmId})`);
                                            }

                                            await diagnosticLogger.captureAndSaveDiagnosticCodes(connection, plantName, inverterId, problemDetails);

                                            imap.delFlags(emailUid, [MONITOR_FLAG], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao remover flag '${MONITOR_FLAG}' do e-mail ${emailUid}:`, err.message);
                                                else console.log(`[${getFormattedTimestamp()}] Flag '${MONITOR_FLAG}' removida do e-mail ${emailUid}.`);
                                            });
                                            imap.addFlags(emailUid, ['\\Seen'], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao marcar e-mail ${emailUid} como lido:`, err.message);
                                                else console.log(`[${getFormattedTimestamp()}] E-mail ${emailUid} marcado como lido.`);
                                            });
                                            resolveMessage();
                                        } else {
                                            console.warn(`[${getFormattedTimestamp()}] Não foi possível extrair dados do e-mail (UID: ${emailUid}) com Subject "Event Report for". Verifique o formato do corpo do e-mail.`);
                                            imap.delFlags(emailUid, [MONITOR_FLAG], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao remover flag '${MONITOR_FLAG}' do e-mail ${emailUid} (parsing falho):`, err.message);
                                            });
                                            imap.addFlags(emailUid, ['\\Seen'], (err) => {
                                                if (err) console.error(`[${getFormattedTimestamp()}] Erro ao marcar e-mail ${emailUid} como lido (parsing falho):`, err.message);
                                            });
                                            resolveMessage();
                                        }
                                    } catch (parseOrDbError) {
                                        console.error(`[${getFormattedTimestamp()}] Erro ao analisar e-mail ou registrar alarme (UID: ${emailUid}):`, parseOrDbError.message);
                                        imap.delFlags(emailUid, [MONITOR_FLAG], (err) => {
                                            if (err) console.error(`[${getFormattedTimestamp()}] Erro ao remover flag '${MONITOR_FLAG}' do e-mail ${emailUid} (erro interno):`, err.message);
                                        });
                                        imap.addFlags(emailUid, ['\\Seen'], (err) => {
                                            if (err) console.error(`[${getFormattedTimestamp()}] Erro ao marcar e-mail ${emailUid} como lido (erro interno):`, err.message);
                                        });
                                        rejectMessage(parseOrDbError);
                                    }
                                });
                            });
                            emailPromises.push(emailProcessingPromise);
                        });

                        fetch.once('error', (fetchErr) => {
                            console.error(`[${getFormattedTimestamp()}] Erro no fetch de e-mails:`, fetchErr);
                            imap.end();
                            reject(fetchErr);
                        });

                        fetch.once('end', () => {
                            console.log(`[${getFormattedTimestamp()}] Todos os e-mails foram enviados para processamento individual. Aguardando conclusão...`);
                            Promise.all(emailPromises)
                                .then(() => {
                                    imap.end();
                                    resolve();
                                })
                                .catch(allPromisesError => {
                                    console.error(`[${getFormattedTimestamp()}] Um ou mais e-mails falharam no processamento:`, allPromisesError);
                                    imap.end();
                                    reject(allPromisesError);
                                });
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                console.error(`[${getFormattedTimestamp()}] Erro de conexão IMAP:`, err);
                imap.end();
                reject(err);
            });

            imap.once('end', async () => {
                console.log(`[${getFormattedTimestamp()}] Conexão IMAP encerrada.`);
            });

            imap.connect();
        });

        await connection.commit();
        console.log(`[${getFormattedTimestamp()}] Transação MySQL comitada com sucesso.`);

    } catch (scriptError) {
        if (connection) {
            await connection.rollback();
            console.log(`[${getFormattedTimestamp()}] Transação MySQL revertida devido a erro.`);
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
