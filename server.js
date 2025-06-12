// server.js
const express = require('express');
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
app.use(express.json());

// --- Rota da API para obter alarmes ativos ---
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

// --- Rota da API para obter alarmes históricos (limpos) ---
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

// --- Endpoint para atualizar a observação de um alarme ---
app.put('/api/alarms/:id/observation', async (req, res) => {
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


// --- Endpoint para limpar um alarme manualmente ---
app.post('/api/clear-alarm/:alarmId', async (req, res) => {
    const { alarmId } = req.params;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [alarms] = await connection.execute(
            `SELECT alarm_id, alarm_type, cleared_at FROM alarms WHERE alarm_id = ? FOR UPDATE`,
            [alarmId]
        );

        if (alarms.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Alarme não encontrado.' });
        }

        const alarm = alarms[0];

        if (alarm.alarm_type !== 'GROWATT_EMAIL_EVENT') {
            await connection.rollback();
            return res.status(400).json({ message: 'Apenas alarmes do tipo GROWATT_EMAIL_EVENT podem ser limpos por esta rota via botão.' });
        }

        if (alarm.cleared_at !== null) {
            await connection.rollback();
            return res.status(400).json({ message: 'Alarme já está limpo.' });
        }

        const [updateResult] = await connection.execute(
            `UPDATE alarms SET cleared_at = NOW(), cleared_by = ? WHERE alarm_id = ?`,
            ['Manual Web', alarmId]
        );

        if (updateResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(500).json({ message: 'Nenhum alarme foi atualizado (pode já ter sido limpo por outro processo).' });
        }

        await connection.commit();
        console.log(`[${getFormattedTimestamp()}] Alarme ID ${alarmId} do tipo 'GROWATT_EMAIL_EVENT' limpo manualmente via web.`);
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

// --- NOVO ENDPOINT: /api/plants-summary ---
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

        // Prioridade 2: Aplicar status baseados em alarmes (Vermelho para GROWATT_EMAIL_EVENT, Amarelo, Cinza),
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

                // Regra 1b: Vermelho para GROWATT_EMAIL_EVENT
                if (alarm.alarm_type === 'GROWATT_EMAIL_EVENT') {
                    item.status = 'red';
                }
                // Regra 2: Amarelo para STRING_DOWN ou HALF_STRING_WORKING
                else if (alarm.alarm_type === 'STRING_DOWN' || alarm.alarm_type === 'HALF_STRING_WORKING') {
                    item.status = 'yellow';
                }
                // Regra 3: Cinza para INVERTER_OFFLINE
                else if (alarm.alarm_type === 'INVERTER_OFFLINE') {
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
