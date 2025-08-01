// web_server.js
const express = require('express');
const jwt = require('jsonwebtoken'); // Para geração e verificação de tokens JWT
const { sendTelegramMessage, init: initTelegramNotifier } = require('./telegramNotifier');
const cookieParser = require('cookie-parser'); // Adicionado para parsear cookies
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const logger = require('./logger')('web');

// --- Load Credentials from external file ---
let credentials;
try {
    credentials = require('./credentials.json');
} catch (error) {
    logger.error("ERRO FATAL: Não foi possível carregar 'credentials.json'. Certifique-se de que o arquivo existe e está formatado corretamente.");
    logger.error(error.stack);
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
logger.info('Telegram Notifier inicializado no web_server.');

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
        logger.info('Pool de conexão MySQL criado para o servidor web.');
    } catch (error) {
        logger.error(`Erro ao criar pool de conexão MySQL: ${error.message}`);
        process.exit(1);
    }
}

initializeDatabasePool();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // Middleware para parsear JSON no corpo da requisição
app.use(cookieParser()); // Middleware para habilitar o req.cookies

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
function authenticateToken(req, res, next) {
    // Lê o token do cookie em vez do header Authorization
    const token = req.cookies.accessToken;

    if (token == null) return res.status(401).json({ message: 'Token de autenticação ausente.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            logger.error(`Erro na verificação do token: ${err.message}`);
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
        const accessToken = jwt.sign(user, JWT_SECRET, { expiresIn: '8h' }); // Token expira em 8 horas

        // Define o token em um cookie httpOnly, que é mais seguro
        res.cookie('accessToken', accessToken, {
            httpOnly: true, // O cookie não pode ser acessado por JavaScript no cliente
            secure: process.env.NODE_ENV === 'production', // Enviar apenas sobre HTTPS (essencial em produção)
            sameSite: 'strict', // Mitiga ataques CSRF
            maxAge: 8 * 60 * 60 * 1000 // 8 horas em milissegundos
        });

        res.json({ message: "Login bem-sucedido", username: user.name });
    } else {
        res.status(401).json({ message: 'Credenciais inválidas.' });
    }
});

// Rota de Logout
app.post('/api/logout', (req, res) => {
    res.cookie('accessToken', '', {
        httpOnly: true,
        expires: new Date(0) // Expira o cookie imediatamente
    });
    res.status(200).json({ message: 'Logout bem-sucedido.' });
});

// --- Rota de Verificação de Status da Sessão (NOVA) ---
// Esta rota é protegida pelo middleware. Se o token for válido, ela retorna sucesso.
// Se o token for inválido/expirado, o middleware retornará 401/403.
// O frontend usará isso para verificar proativamente se a sessão ainda está ativa.
app.get('/api/auth/status', authenticateToken, (req, res) => {
    // Se o middleware authenticateToken passou, o usuário está autenticado.
    // Retornamos o nome de usuário do payload do token.
    res.json({ authenticated: true, username: req.user.name });
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
        logger.error(`Erro ao buscar alarmes ativos: ${error.message}`);
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
        logger.error(`Erro ao buscar histórico de alarmes: ${error.message}`);
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

        // 1. Buscar os dados mais recentes (para códigos de falha) e a geração máxima de HOJE.
        const [solarDataRows] = await connection.execute(`
            SELECT
                sd.plant_name,
                sd.inverter_id,
                COALESCE(today_gen.max_gen_today, 0) AS gen_today,
                COALESCE(sd.pid_fault_code, 0) AS pid_fault_code,
                COALESCE(sd.fault_value, 0) AS fault_value,
                COALESCE(sd.fault_type, 0) AS fault_type
            FROM solar_data sd
            INNER JOIN (
                -- Subquery para obter a geração máxima de hoje para cada inversor
                SELECT inverter_id, MAX(gen_today) AS max_gen_today
                FROM solar_data
                WHERE DATE(last_update_time) = CURDATE()
                GROUP BY inverter_id
            ) AS today_gen ON sd.inverter_id = today_gen.inverter_id
            INNER JOIN (
                -- Subquery para encontrar o registro mais recente de cada inversor
                -- (usado para obter os códigos de falha mais atuais)
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

        // 3. (NOVO) Buscar dados de geração mensal para o mês atual e o anterior
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;

        let lastMonthYear = currentYear;
        let lastMonth = currentMonth - 1;
        if (lastMonth === 0) {
            lastMonth = 12;
            lastMonthYear = currentYear - 1;
        }

        const [monthlyGenRows] = await connection.execute(`
            SELECT
                inverter_id,
                SUM(CASE WHEN year = ? AND month = ? THEN gen_kwh ELSE 0 END) as current_month_gen,
                SUM(CASE WHEN year = ? AND month = ? THEN gen_kwh ELSE 0 END) as last_month_gen
            FROM monthly_generation
            WHERE (year = ? AND month = ?) OR (year = ? AND month = ?)
            GROUP BY inverter_id
        `, [currentYear, currentMonth, lastMonthYear, lastMonth, currentYear, currentMonth, lastMonthYear, lastMonth]);

        // Estrutura para consolidar dados
        const summary = {}; // Chave: inverter_id, Valor: { plant_name, gen_today, status, alarm_types_active, ... }

        // Inicializar o resumo com todos os inversores conhecidos de plant_config
        plantConfigRows.forEach(pc => {
            summary[pc.inverter_id] = {
                plant_name: pc.plant_name,
                inverter_id: pc.inverter_id,
                gen_today: null,
                current_month_gen: 0, // Padrão 0
                last_month_gen: 0,    // Padrão 0
                status: 'green', // Status padrão
                alarm_types_active: [],
                pid_fault_code: 0, // Padrão 0
                fault_value: 0,    // Padrão 0
                fault_type: 0      // Padrão 0
            };
        });

        // Mapear geração mensal para consulta rápida
        const monthlyGenMap = new Map();
        monthlyGenRows.forEach(row => {
            monthlyGenMap.set(row.inverter_id, {
                current_month_gen: parseFloat(row.current_month_gen),
                last_month_gen: parseFloat(row.last_month_gen)
            });
        });

        // Sobrepor com os dados mais recentes de solar_data (para inversores que têm dados)
        solarDataRows.forEach(sd => {
            if (summary[sd.inverter_id]) { // Garante que é um inversor configurado
                summary[sd.inverter_id].gen_today = sd.gen_today;
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

            // Adicionar dados de geração mensal ao item do resumo
            const genData = monthlyGenMap.get(item.inverter_id);
            if (genData) {
                item.current_month_gen = genData.current_month_gen;
                item.last_month_gen = genData.last_month_gen;
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
                if (alarm.alarm_type === 'GROWATT-EMAIL-EVENT' || alarm.alarm_type === 'SOLARMAN-EMAIL-EVENT' || alarm.alarm_type === 'INVERTER-OFFLINE' ) {
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
        logger.error(`Erro ao buscar resumo das plantas: ${error.message}`);
        res.status(500).json({ error: 'Erro ao buscar resumo das plantas.' });
    } finally {
        if (connection) connection.release();
    }
});

// --- ENDPOINT: /api/monthly-generation ---
app.get('/api/monthly-generation', async (req, res) => {
    const { plantName, inverterId, year } = req.query;

    if (!plantName || !inverterId || !year) {
        return res.status(400).json({ error: 'Parâmetros plantName, inverterId e year são obrigatórios.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(
            `SELECT month, gen_kwh
             FROM monthly_generation
             WHERE plant_name = ? AND inverter_id = ? AND year = ?
             ORDER BY month ASC`,
            [plantName, inverterId, year]
        );

        // Cria um mapa para facilitar a consulta
        const generationMap = new Map();
        rows.forEach(row => {
            generationMap.set(row.month, parseFloat(row.gen_kwh));
        });

        // Cria um array de 12 meses, preenchendo os dados onde existem
        const monthlyData = [];
        for (let i = 1; i <= 12; i++) {
            monthlyData.push({
                month: i,
                gen_kwh: generationMap.get(i) || 0
            });
        }

        res.json(monthlyData);
    } catch (error) {
        logger.error(`Erro ao buscar geração mensal para ${plantName}/${inverterId} no ano ${year}: ${error.message}`);
        res.status(500).json({ error: 'Erro ao buscar dados de geração mensal.' });
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
        logger.error(`Erro ao atualizar observação para o alarme ${id}: ${error.message}`);
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
        logger.info(`Notificação de alarme resolvido enviada para o admin (Alarme ID: ${alarmId}).`);

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
                logger.info(`Notificação de alarme resolvido enviada para o proprietário da Planta: ${alarmToClear.plant_name} (Alarme ID: ${alarmId}).`);
            } else if (String(ownerChatId) === String(adminChatId)) {
                logger.info(`Proprietário da planta ${alarmToClear.plant_name} é o mesmo que o ADMIN, notificação de alarme resolvido enviada apenas uma vez.`);
            }
        }

        await connection.commit();
        logger.info(`Alarme ID ${alarmId} do tipo '${alarmToClear.alarm_type}' limpo manualmente via web.`);
        res.json({ message: 'Alarme limpo com sucesso!', alarmId: alarmId });

    } catch (error) {
        logger.error(`ERRO ao limpar alarme ID ${alarmId} (Manual Web): ${error.message}`);
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
    logger.info(`Servidor web rodando na porta ${PORT}`);
    logger.info(`Acesse: http://localhost:${PORT}`);
});

// Incluir o pool.end no evento de encerramento do processo
const shutdown = async (signal) => {
    logger.info(`\nRecebido sinal ${signal}. Encerrando servidor e pool de conexões...`);
    server.close(async () => {
        if (pool) {
            await pool.end();
            logger.info('Pool de conexão MySQL encerrado.');
        }
        process.exit(0);
    });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
