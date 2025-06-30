// set_telegram_webhook.js
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const logger = require('./logger')('telegram'); // Importa o logger

// Carrega as credenciais do seu arquivo credentials.json
const credentialsPath = path.join(__dirname, 'credentials.json');
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

const botToken = credentials.telegram.botToken;

// --- CONFIGURAÇÃO CHAVE ---
// !!! SUBSTITUA PELO URL PÚBLICO REAL DO SEU SERVIDOR !!!
// Exemplo: 'https://seuservidor.com.br/telegram-webhook'
// Se você está usando uma porta não padrão (ex: 8080) e não está atrás de um proxy:
// 'https://seuservidor.com.br:8080/telegram-webhook'
const WEBHOOK_URL = 'https://solarmon.powerplantsbrazil.com/telegram-webhook'; // <-- IMPORTANTE: AJUSTE ISSO!
// --- FIM DA CONFIGURAÇÃO CHAVE ---

async function setWebhook() {
    if (!botToken || !WEBHOOK_URL) {
        logger.error('Bot Token ou Webhook URL não configurados.');
        return;
    }

    const apiUrl = `https://api.telegram.org/bot${botToken}/setWebhook`;
    const params = {
        url: WEBHOOK_URL,
    };

    try {
        logger.info(`Tentando definir o webhook para: ${WEBHOOK_URL}`);
        const response = await axios.post(apiUrl, params);

        if (response.data.ok) {
            logger.info('Webhook definido com sucesso!');
            logger.info(`Informações da resposta: ${JSON.stringify(response.data)}`);
        } else {
            logger.error(`Falha ao definir o webhook: ${response.data.description}`);
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        logger.error(`Erro ao chamar a API setWebhook do Telegram: ${errorMessage}`);
        if (error.response && error.response.status === 401) {
            logger.error('Erro 401: Verifique se o Bot Token está correto e é válido.');
        } else if (error.response && error.response.status === 400) {
            logger.error('Erro 400: Verifique se o URL do Webhook está acessível e é HTTPS (se for o caso).');
        }
    }
}

// Execute a função para definir o webhook
setWebhook();
