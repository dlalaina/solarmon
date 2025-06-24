// telegramNotifier.js
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { getFormattedTimestamp } = require('./utils'); // Presumindo que utils.js existe

let botToken = '';
let defaultChatId = ''; // Renomeado para maior clareza, é o seu chat_id de admin
const logs_dir = path.join(__dirname, 'logs');

function init(token, id) {
  botToken = token;
  defaultChatId = id; // Armazena o chat_id do admin
}

// A função agora aceita um targetChatId opcional. Se não for fornecido, usa defaultChatId.
async function sendTelegramMessage(message, targetChatId = defaultChatId) {
  // Use targetChatId para a verificação
  if (!botToken || !targetChatId) {
    console.error(`[${getFormattedTimestamp()}] ERRO: Credenciais do Telegram incompletas para envio para ${targetChatId}. Use telegramNotifier.init(token, id).`);
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const params = {
    chat_id: targetChatId, // Use o chat_id de destino
    text: message,
    parse_mode: 'HTML' // Para permitir negrito, itálico, etc.
  };

  try {
    const response = await axios.post(url, params);
    // console.log(`[${getFormattedTimestamp()}] Mensagem enviada para ${targetChatId} com sucesso:`, response.data);
  } catch (error) {
    console.error(`[${getFormattedTimestamp()}] Erro ao enviar mensagem para ${targetChatId}:`, error.response ? error.response.data : error.message);
    // Log detalhado do erro para investigação
    const errorLog = `[${getFormattedTimestamp()}] Erro Telegram para Chat ID: ${targetChatId}, Mensagem: "${message}"\nErro: ${error.response ? JSON.stringify(error.response.data) : error.message}\n`;
    fs.appendFileSync(path.join(logs_dir, 'telegram_errors.log'), errorLog);
  }
}

module.exports = {
  init,
  sendTelegramMessage
};
