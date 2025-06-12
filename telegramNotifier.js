// telegramNotifier.js
const axios = require('axios');
const { getFormattedTimestamp } = require('./utils');
const fs = require('fs').promises; // Necessário para logar erros no TelegramNotifier
const path = require('path');

let botToken = '';
let chatId = '';
const logs_dir = path.join(__dirname, 'logs'); // Definido aqui também para acesso no catch

function init(token, id) {
  botToken = token;
  chatId = id;
}

async function sendTelegramMessage(message) {
  if (!botToken || !chatId) {
    console.error(`[${getFormattedTimestamp()}] ERRO: Credenciais do Telegram incompletas para envio. Use telegramNotifier.init(token, id).`);
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
    console.log(`[${getFormattedTimestamp()}] Mensagem enviada para o Telegram.`);
  } catch (telegramError) {
    console.error(`[${getFormattedTimestamp()}] ERRO ao enviar mensagem para o Telegram: ${telegramError.message}`);
    // O diretório de logs já é garantido na app.js
    await fs.writeFile(path.join(logs_dir, 'error.log'), `[${getFormattedTimestamp()}] ERRO Telegram: ${telegramError.stack}\n`, { flag: 'a' });
  }
}

module.exports = {
  init,
  sendTelegramMessage,
};
