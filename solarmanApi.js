// solarmanApi.js
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const BASE_URL = 'https://globalapi.solarmanpv.com';
const TOKEN_CACHE_FILE = path.join(__dirname, 'solarman_token_cache.json'); // Arquivo para cache do token

let cachedToken = null;
let tokenExpiry = 0; // Unix timestamp em milissegundos

/**
 * Carrega o token em cache do arquivo.
 */
async function loadTokenCache() {
    try {
        const data = await fs.readFile(TOKEN_CACHE_FILE, 'utf8');
        const cache = JSON.parse(data);
        if (cache && cache.token && cache.expiry) {
            cachedToken = cache.token;
            tokenExpiry = cache.expiry;
            logger.info('Token Solarman carregado do cache.');
        }
    } catch (error) {
        // Arquivo não encontrado ou erro de parse, ignorar e prosseguir para obter um novo token
        logger.warn('Não foi possível carregar o cache do token Solarman ou arquivo não encontrado. Um novo token será solicitado.');
    }
}

/**
 * Salva o token no arquivo de cache.
 */
async function saveTokenCache(token, expiry) {
    try {
        await fs.writeFile(TOKEN_CACHE_FILE, JSON.stringify({ token, expiry }), 'utf8');
        logger.info('Token Solarman salvo em cache.');
    } catch (error) {
        logger.error(`Erro ao salvar o token Solarman no cache: ${error.message}`);
    }
}

/**
 * Obtém o token de acesso da API Solarman (Merchant Version).
 * Este token é para a versão MERCHANT (B-end) e requer o orgId.
 * O token é armazenado em cache para evitar requisições desnecessárias.
 * @param {string} appId - Seu APP ID da Solarman.
 * @param {string} appSecret - Sua chave APP Secret da Solarman.
 * @param {string} email - O email da sua conta Solarman.
 * @param {string} passwordSha256 - Sua senha SHA256 encriptada.
 * @param {number} orgId - Seu Merchant ID (orgId).
 * @returns {Promise<string>} O token de acesso.
 */
async function getSolarmanToken(appId, appSecret, email, passwordSha256, orgId) {
    const now = Date.now(); // Tempo atual em milissegundos
    const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias em milissegundos

    if (cachedToken && (tokenExpiry > now + REFRESH_THRESHOLD_MS)) {
        logger.info(`Usando token Solarman em cache. Expira em ${new Date(tokenExpiry).toLocaleString()}.`);
        return cachedToken;
    }

    logger.info('Obtendo novo token Solarman...');
    try {
        const response = await axios.post(
            `${BASE_URL}/account/v1.0/token?appId=${appId}&language=en`,
            {
                appSecret: appSecret,
                email: email,
                password: passwordSha256,
                orgId: orgId
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        // --- INÍCIO DA MODIFICAÇÃO CHAVE AQUI ---
        // Acessa diretamente response.data.access_token e response.data.expires_in
        if (response.data && response.data.success && response.data.access_token) {
            cachedToken = response.data.access_token;
            // expires_in é uma string no retorno, precisamos parsear para int
            tokenExpiry = now + (parseInt(response.data.expires_in) * 1000);
            await saveTokenCache(cachedToken, tokenExpiry);
            logger.info(`Token Solarman obtido e salvo. Expira em ${new Date(tokenExpiry).toLocaleString()}.`);
            return cachedToken;
        } else {
            // Se success for false ou access_token não estiver presente, ainda é um erro
            logger.error(`Erro ao obter token Solarman: ${JSON.stringify(response.data)}`);
            throw new Error(`Falha ao obter token Solarman: ${response.data.msg || 'Resposta inesperada'}`);
        }
        // --- FIM DA MODIFICAÇÃO CHAVE AQUI ---

    } catch (error) {
        logger.error(`Erro na requisição para obter token Solarman: ${error.message}`);
        throw new Error(`Erro na requisição para obter token Solarman: ${error.message}`);
    }
}

/**
 * Obtém os dados atuais de um dispositivo Solarman.
 * @param {string} token - O token de acesso da API Solarman.
 * @param {string} deviceSn - O número de série (SN) do inversor.
 * @returns {Promise<object>} Os dados atuais do inversor.
 */
async function getSolarmanCurrentData(token, deviceSn) {
    logger.info(`Buscando dados Solarman para o dispositivo SN: ${deviceSn}...`);
    try {
        const response = await axios.post(
            `${BASE_URL}/device/v1.0/currentData?language=en`,
            {
                deviceSn: deviceSn
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (response.data && response.data.success) {
            logger.info(`Dados Solarman para ${deviceSn} obtidos com sucesso.`);
            return response.data;
        } else {
            logger.error(`Erro ao buscar dados Solarman para ${deviceSn}: ${JSON.stringify(response.data)}`);
            throw new Error(`Falha ao buscar dados Solarman para ${deviceSn}: ${response.data.msg || 'Resposta inesperada'}`);
        }
    } catch (error) {
        logger.error(`Erro na requisição para buscar dados Solarman para ${deviceSn}: ${error.message}`);
        throw new Error(`Erro na requisição para buscar dados Solarman para ${deviceSn}: ${error.message}`);
    }
}

// Carregar o cache do token quando o módulo é importado
loadTokenCache();

module.exports = {
    getSolarmanToken,
    getSolarmanCurrentData
};
