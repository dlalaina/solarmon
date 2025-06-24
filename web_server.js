// web_server.js
const express = require('express');
const fs = require('fs');
const jwt = require('jsonwebtoken'); // Para geração e verificação de tokens JWT
const { sendTelegramMessage, init: initTelegramNotifier } = require('./telegramNotifier');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const { getFormattedTimestamp } = require('./utils'); // Importado de utils.js

// --- Load Credentials from external file ---
let credentials;
try {
    credentials = require('./credentials.json');
} catch (error) {
    console.error(`[${getFormattedTimestamp()}] ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.`);
    console.error(error.message);
    process.exit(1);
}

// --- CONFIGURAÇÃO JWT ---
const JWT_SECRET = credentials.auth.jwtSecret;
const ADMIN_USERNAME = credentials.auth.adminUsername;
const ADMIN_PASSWORD = credentials.auth.adminPassword;
// --- FIM DA CONFIGURAÇÃO JWT ---

// --- Inicialização do Telegram Notifier ---
const adminChatId = credentials.telegram.chatId;
initTelegramNotifier(credentials.telegram.botToken, adminChatId);
console.log(`[${getFormattedTimestamp()}] Telegram Notifier inicializado no web_server.`);

// --- MySQL Connection Configuration ---
const dbConfig = {
    host: credentials.mysql.host,
    user: credentials.mysql.user,
    password: credentials.mysql.password,
    database: credentials.mysql.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

async function initializeDatabasePool() {
    try {
        pool = mysql.createPool(dbConfig);
        console.log(`[${getFormattedTimestamp()}] Pool de conexão MySQL criado para o servidor web.`);
    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] Erro ao criar pool de conexão MySQL:`, error.message);
        process.exit(1);
    }
}

initializeDatabasePool();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // Middleware para parsear JSON no corpo da requisição

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato: Bearer TOKEN

    if (token == null) return res.status(401).json({ message: 'Token de autenticação ausente.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error(`[${getFormattedTimestamp()}] Erro na verificação do token:`, err.message);
            return res.status(403).json({ message: 'Token inválido ou expirado.' });
        }
        req.user = user; // Adiciona o payload do token à requisição
        next(); // Continua para a próxima middleware/rota
    });
}
// --- FIM DO MIDDLEWARE DE AUTENTICAÇÃO ---

// --- Rota de Login ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Autenticação usando credenciais do credentials.json
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const user = { name: username, role: 'admin' }; // Payload do token
        const accessToken = jwt.sign(user, JWT_SECRET, { expiresIn: '1h' }); // Token expira em 1 hora
        res.json({ accessToken: accessToken, username: user.name });
    } else {
        res.status(401).json({ message: 'Credenciais inválidas.' });
    }
});

// --- ENDPOINT PARA O WEBHOOK DO TELEGRAM ---
app.post('/telegram-webhook', async (req, res) => {
    res.sendStatus(200);

    const update = req.body;
    if (!update || !update.message) {
        return;
    }

    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.username;
    const firstName = msg.from.first_name;
    const lastName = msg.from.last_name;
    const messageText = msg.text;

    const logEntry = `[${getFormattedTimestamp()}] CHAT_ID: ${chatId}, USER_ID: ${userId}, USERNAME: ${userName || 'N/A'}, NAME: ${firstName || ''} ${lastName || ''}, MESSAGE: "${messageText}"\n`;

    // --- LOG PARA COLETAR CHAT_IDS ---
    const CHAT_IDS_LOG_FILE = path.join(__dirname, 'logs', 'received_chat_ids.log');
    const logDir = path.dirname(CHAT_IDS_LOG_FILE);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFile(CHAT_IDS_LOG_FILE, logEntry, (err) => {
        if (err) {
            console.error('Erro ao escrever no arquivo de log de chat_ids:', err);
        }
    });

    console.log(`[${getFormattedTimestamp()}] Mensagem recebida de ${firstName || userName || userId} (Chat ID: ${chatId}): "${messageText}"`);

    // --- Lógica para o comando "cadastrar" ---
    if (messageText && typeof messageText === 'string' && messageText.toLowerCase().includes('cadastrar')) {
        try {
            await sendTelegramMessage('Obrigado por se cadastrar. Seu ID de chat foi registrado.', chatId);
            console.log(`[${getFormattedTimestamp()}] Enviado mensagem de cadastro para ${firstName || userName || userId} (Chat ID: ${chatId}).`);

            await new Promise(resolve => setTimeout(resolve, 1000)); // Espera 1 segundo

            const adminNotificationMessage =
                `Novo cadastro de usuário:\n` +
                `CHAT_ID: <code>${chatId}</code>\n` +
                `USER_ID: <code>${userId}</code>\n` +
                `USERNAME: ${userName || 'N/A'}\n` +
                `NOME: ${firstName || ''} ${lastName || ''}`;

            await sendTelegramMessage(adminNotificationMessage, adminChatId);
            console.log(`[${getFormattedTimestamp()}] Notificação de novo cadastro enviada para o admin.`);

        } catch (error) {
            console.error(`[${getFormattedTimestamp()}] Erro ao processar comando 'cadastrar' ou enviar notificação para ${chatId}:`, error.response ? error.response.data : error.message);
        }
    }
});

// --- Rotas da API existentes (não protegidas ainda) ---
app.get('/api/alarms/active', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(
            `SELECT alarm_id, plant_name, inverter_id, alarm_type, problem_details, triggered_at, cleared_at, observation
             FROM alarms
             WHERE cleared_at IS NULL
             ORDER BY triggered_at DESC`
        );
        res.json(rows);
    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] Erro ao buscar alarmes ativos:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar alarmes ativos.' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/api/alarms/history', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(
            `SELECT alarm_id, plant_name, inverter_id, alarm_type, problem_details, triggered_at, cleared_at, observation
             FROM alarms
             WHERE cleared_at IS NOT NULL
             ORDER BY triggered_at DESC
             LIMIT 100`
        );
        res.json(rows);
    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] Erro ao buscar histórico de alarmes:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar histórico de alarmes.' });
    } finally {
        if (connection) connection.release();
    }
});

// --- ENDPOINT: /api/plants-summary ---
app.get('/api/plants-summary', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();

        // 0. Buscar todas as plantas/inversores configurados de plant_config (fonte da verdade)
        const [plantConfigRows] = await connection.execute(`
            SELECT DISTINCT plant_name, inverter_id FROM plant_config
        `);

        // 1. Buscar os dados mais recentes de solar_data para cada inversor (apenas para aqueles que têm dados)
        const [solarDataRows] = await connection.execute(`
            SELECT
                sd.plant_name,
                sd.inverter_id,
                sd.e_today,
                COALESCE(sd.pid_fault_code, 0) AS pid_fault_code,
                COALESCE(sd.fault_value, 0) AS fault_value,
                COALESCE(sd.fault_type, 0) AS fault_type
            FROM solar_data sd
            INNER JOIN (
                SELECT inverter_id, MAX(last_update_time) as max_update_time
                FROM solar_data
                GROUP BY inverter_id
            ) AS latest_sd ON sd.inverter_id = latest_sd.inverter_id AND sd.last_update_time = latest_sd.max_update_time
        `);

        // 2. Buscar todos os alarmes ativos (cleared_at IS NULL)
        const [activeAlarmsRows] = await connection.execute(`
            SELECT plant_name, inverter_id, alarm_type
            FROM alarms
            WHERE cleared_at IS NULL
        `);

        // Estrutura para consolidar dados
        const summary = {}; // Chave: inverter_id, Valor: { plant_name, e_today, status, alarm_types_active, ... }

        // Inicializar o resumo com todos os inversores conhecidos de plant_config
        plantConfigRows.forEach(pc => {
            summary[pc.inverter_id] = {
                plant_name: pc.plant_name,
                inverter_id: pc.inverter_id,
                e_today: null, // Padrão null, será preenchido por solar_data se disponível
                status: 'green', // Status padrão
                alarm_types_active: [],
                pid_fault_code: 0, // Padrão 0
                fault_value: 0,    // Padrão 0
                fault_type: 0      // Padrão 0
            };
        });

        // Sobrepor com os dados mais recentes de solar_data (para inversores que têm dados)
        solarDataRows.forEach(sd => {
            if (summary[sd.inverter_id]) { // Garante que é um inversor configurado
                summary[sd.inverter_id].e_today = sd.e_today;
                summary[sd.inverter_id].pid_fault_code = sd.pid_fault_code;
                summary[sd.inverter_id].fault_value = sd.fault_value;
                summary[sd.inverter_id].fault_type = sd.fault_type;
            }
        });

        // Aplicar lógica de status baseada em alarmes ativos e códigos de falha de solar_data
        // Iterar por todos os itens do resumo para aplicar primeiro as regras de código de falha
        Object.values(summary).forEach(item => {
            // Prioridade 1: Status vermelho de códigos de falha de solar_data
            if (item.pid_fault_code !== 0 || item.fault_value !== 0 || item.fault_type !== 0) {
                item.status = 'red';
            }
        });

        // Prioridade 2: Aplicar status baseados em alarmes (Vermelho para GROWATT-EMAIL-EVENT, Amarelo, Cinza),
        // respeitando prioridades mais altas (Vermelho de códigos de falha)
        activeAlarmsRows.forEach(alarm => {
            if (summary[alarm.inverter_id]) {
                const item = summary[alarm.inverter_id];
                item.alarm_types_active.push(alarm.alarm_type);

                // Se o status atual já for 'red' (de códigos de falha ou tipo de alarme anterior),
                // não rebaixá-lo.
                if (item.status === 'red') {
                    return;
                }

                // Regra 1b: Vermelho para GROWATT-EMAIL-EVENT
                if (alarm.alarm_type === 'GROWATT-EMAIL-EVENT') {
                    item.status = 'red';
                }
                // Regra 2: Amarelo para STRING-DOWN ou HALF-STRING-WORKING
                else if (alarm.alarm_type === 'STRING-DOWN' || alarm.alarm_type === 'HALF-STRING-WORKING') {
                    item.status = 'yellow';
                }
                // Regra 3: Cinza para INVERTER-OFFLINE
                else if (alarm.alarm_type === 'INVERTER-OFFLINE') {
                    // Aplicar cinza apenas se não for já vermelho ou amarelo
                    if (item.status !== 'yellow') { // 'red' já é tratado pelo retorno anterior
                        item.status = 'gray';
                    }
                }
            }
        });

        const result = Object.values(summary);
        res.json(result);

    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] Erro ao buscar resumo das plantas:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar resumo das plantas.' });
    } finally {
        if (connection) connection.release();
    }
});

// --- ENDPOINTS PROTEGIDOS ---
// Aplica o middleware authenticateToken a estas rotas
app.put('/api/alarms/:id/observation', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { observation } = req.body;

    if (observation === undefined) {
        return res.status(400).json({ error: 'Campo "observation" é obrigatório no corpo da requisição.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        const [result] = await connection.execute(
            `UPDATE alarms SET observation = ? WHERE alarm_id = ?`,
            [observation, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Alarme não encontrado.' });
        }

        res.json({ message: 'Observação do alarme atualizada com sucesso.' });
    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] Erro ao atualizar observação para o alarme ${id}:`, error.message);
        res.status(500).json({ error: 'Erro ao atualizar observação.' });
    } finally {
        if (connection) connection.release();
    }
});

app.post('/api/clear-alarm/:alarmId', authenticateToken, async (req, res) => {
    const { alarmId } = req.params;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Obter detalhes do alarme ANTES de limpá-lo, incluindo 'cleared_at'
        const [alarms] = await connection.execute(
            `SELECT alarm_id, plant_name, inverter_id, alarm_type, problem_details, message, cleared_at FROM alarms WHERE alarm_id = ? FOR UPDATE`,
            [alarmId]
        );

        if (alarms.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Alarme não encontrado.' });
        }

        const alarmToClear = alarms[0];

        // Verificação de alarme já limpo agora é precisa
        if (alarmToClear.cleared_at !== null) {
            await connection.rollback();
            return res.status(400).json({ message: 'Alarme já está limpo.' });
        }

        // 2. Limpar o alarme no banco de dados
        const [updateResult] = await connection.execute(
            `UPDATE alarms SET cleared_at = NOW(), cleared_by = ? WHERE alarm_id = ?`,
            ['Manual Web', alarmId]
        );

        if (updateResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(500).json({ message: 'Nenhum alarme foi atualizado (pode já ter sido limpo por outro processo).' });
        }

        // 3. Enviar notificação de alarme resolvido para o ADMIN
        const adminResolveMessage = `✅ <b>ALARME RESOLVIDO</b> ✅\n` +
                                     `ID: <b>${alarmToClear.alarm_id}</b>\n` +
                                     `Tipo: <b>${alarmToClear.alarm_type.replace(/-/g, ' ')}</b>\n` +
                                     `Planta: <b>${alarmToClear.plant_name}</b>\n` +
                                     `Inversor: <b>${alarmToClear.inverter_id}</b>\n` +
                                     `Detalhes: ${alarmToClear.problem_details || 'N/A'}`;
        await sendTelegramMessage(adminResolveMessage, adminChatId);
        console.log(`[${getFormattedTimestamp()}] Notificação de alarme resolvido enviada para o admin (Alarme ID: ${alarmId}).`);

        // 4. Enviar notificação para o PROPRIETÁRIO (se existir e for diferente do ADMIN)
        const [plantInfoRows] = await connection.execute(
            `SELECT owner_chat_id FROM plant_info WHERE plant_name = ?`,
            [alarmToClear.plant_name]
        );

        if (plantInfoRows.length > 0 && plantInfoRows[0].owner_chat_id) {
            const ownerChatId = plantInfoRows[0].owner_chat_id;
            if (ownerChatId && String(ownerChatId) !== String(adminChatId)) {
                const ownerResolveMessage = `✅ O alarme para sua usina <b>${alarmToClear.plant_name}</b> (Inversor: <b>${alarmToClear.inverter_id}</b>) foi RESOLVIDO.`;
                await sendTelegramMessage(ownerResolveMessage, ownerChatId);
                console.log(`[${getFormattedTimestamp()}] Notificação de alarme resolvido enviada para o proprietário da Planta: ${alarmToClear.plant_name} (Alarme ID: ${alarmId}).`);
            } else if (String(ownerChatId) === String(adminChatId)) {
                console.log(`[${getFormattedTimestamp()}] Proprietário da planta ${alarmToClear.plant_name} é o mesmo que o ADMIN, notificação de alarme resolvido enviada apenas uma vez.`);
            }
        }

        await connection.commit();
        console.log(`[${getFormattedTimestamp()}] Alarme ID ${alarmId} do tipo '${alarmToClear.alarm_type}' limpo manualmente via web.`);
        res.json({ message: 'Alarme limpo com sucesso!', alarmId: alarmId });

    } catch (error) {
        console.error(`[${getFormattedTimestamp()}] ERRO ao limpar alarme ID ${alarmId} (Manual Web):`, error.message);
        if (connection) {
            await connection.rollback();
        }
        res.status(500).json({ error: 'Erro interno do servidor ao limpar alarme.' });
    } finally {
        if (connection) connection.release();
    }
});

// Inicia o servidor
const server = app.listen(PORT, () => {
    console.log(`[${getFormattedTimestamp()}] Servidor web rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
});

// Incluir o pool.end no evento de encerramento do processo
const shutdown = async (signal) => {
    console.log(`\n[${getFormattedTimestamp()}] Recebido sinal ${signal}. Encerrando servidor e pool de conexões...`);
    server.close(async () => {
        if (pool) {
            await pool.end();
            console.log(`[${getFormattedTimestamp()}] Pool de conexão MySQL encerrado.`);
        }
        process.exit(0);
    });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

