// telegramNotifier.js
const axios = require('axios');
const logger = require('./logger')('telegram');

let botToken = '';
let defaultChatId = ''; // Renomeado para maior clareza, é o seu chat_id de admin

function init(token, id) {
  botToken = token;
  defaultChatId = id; // Armazena o chat_id do admin
}

// A função agora aceita um targetChatId opcional. Se não for fornecido, usa defaultChatId.
async function sendTelegramMessage(message, targetChatId = defaultChatId) {
  // Use targetChatId para a verificação
  if (!botToken || !targetChatId) {
    logger.error(`ERRO: Credenciais do Telegram incompletas para envio para ${targetChatId}. Use telegramNotifier.init(token, id).`);
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
    // logger.info(`Mensagem enviada para ${targetChatId} com sucesso.`); // Opcional: descomente se quiser logar envios bem-sucedidos.
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error(`Erro ao enviar mensagem para ${targetChatId}: ${errorMessage}`);
  }
}

module.exports = {
  init,
  sendTelegramMessage
};
