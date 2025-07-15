// solplanetApi.js
const axios = require('axios');
const logger = require('./logger')('solplanet');
const telegramNotifier = require('./telegramNotifier');
const fs = require('fs').promises;
const path = require('path');

const API_BASE_URL = 'https://internation-pro-cloud.solplanet.net/api';
const AUTH_CACHE_FILE = path.join(__dirname, 'solplanet_auth_cache.json');

const COMMON_HEADERS = {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
    'Content-Type': 'application/json',
    'Origin': 'https://internation-pro-cloud.solplanet.net',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'localE': 'en_US'
};


/**
 * Realiza o login na API da Solplanet e retorna o token de autenticação e o cookie acw_tc.
 * @param {string} account - O nome de usuário (e-mail).
 * @param {string} pwd - A senha.
 * @returns {Promise<{token: string, cookie: string}>} Um objeto contendo o token e o cookie.
 */
async function login(account, pwd) {
    const loginUrl = `${API_BASE_URL}/user/login`;
    const payload = {
        account,
        pwd,
        type: 'account'
    };

    const headers = {
        ...COMMON_HEADERS,
        'Referer': 'https://internation-pro-cloud.solplanet.net/user/login',
    };

    try {
        logger.info('Tentando fazer login na API da Solplanet...');
        const response = await axios.post(loginUrl, payload, { headers });

        if (response.data && response.data.code === 200 && response.data.result && response.data.result.token) {
            const token = response.data.result.token;            
            logger.info('Login na Solplanet realizado com sucesso.');
            // Retorna apenas o token, o cookie não é mais necessário.
            return token;
        } else {
            throw new Error(`Falha no login da Solplanet: ${response.data.msg || 'Resposta inválida'}`);
        }
    } catch (error) {
        logger.error(`Erro na requisição de login da Solplanet: ${error.message}`);
        if (error.response) logger.error(`Detalhes: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        throw error;
    }
}

/**
 * Obtém o token de autenticação, usando o cache se disponível.
 * Se o cache não existir, faz um novo login.
 * @param {string} account - O nome de usuário (e-mail).
 * @param {string} pwd - A senha.
 * @returns {Promise<string>} O token de autenticação.
 */
async function getAuthCredentials(account, pwd) {
    // 1. Tentar ler do cache
    try {
        const cacheData = await fs.readFile(AUTH_CACHE_FILE, 'utf8');
        const cache = JSON.parse(cacheData);
        if (cache.token) {
            logger.info(`Usando token Solplanet em cache (criado em: ${new Date(cache.createdAt).toLocaleString()}).`);
            return cache.token;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`Não foi possível ler o cache de autenticação da Solplanet: ${error.message}`);
        }
    }
    
    // 2. Se o cache não existir, fazer login e salvar
    logger.info('Cache da Solplanet não encontrado. Obtendo novo token...');
    const token = await login(account, pwd);
    const newCache = {
        token: token,
        createdAt: Date.now()
    };
    await fs.writeFile(AUTH_CACHE_FILE, JSON.stringify(newCache, null, 2), 'utf8');
    logger.info(`Novo token Solplanet salvo em cache.`);
    return token;
}

/**
 * Força a renovação do token (silenciosamente) e salva o novo no cache.
 * @param {string} account - O nome de usuário (e-mail).
 * @param {string} pwd - A senha.
 * @param {Error} originalError - O erro que acionou a renovação.
 * @returns {Promise<string>} O novo token de autenticação.
 */
async function forceTokenRefresh(account, pwd, originalError) {
    // A notificação por Telegram foi removida a pedido.
    // A renovação do token agora acontece silenciosamente, apenas registrando o aviso no log.
    logger.warn(`Token Solplanet expirado ou inválido. Forçando renovação silenciosa devido ao erro: ${originalError.message}`);

    // Deleta o cache antigo e obtém um novo token
    try { await fs.unlink(AUTH_CACHE_FILE); } catch (e) { /* Ignora se o arquivo não existir */ }
    return getAuthCredentials(account, pwd);
}

/**
 * Busca os detalhes de um inversor específico.
 * @param {{token: string, cookie: string}} auth - O objeto de autenticação com token e cookie.
 * @param {string} inverterId - O número de série (SN) do inversor.
 * @returns {Promise<object>} Os dados detalhados do inversor.
 */
async function getInverterDetail(token, inverterId) {
    const detailUrl = `${API_BASE_URL}/inverter/detail`;
    const params = {
        isno: inverterId,
        version: '1'
    };

    const headers = {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
        'Content-Type': 'application/json',
        'Origin': 'https://internation-pro-cloud.solplanet.net',
        'Referer': 'https://internation-pro-cloud.solplanet.net/plant-center/plant-overview-all/plant-detail?',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'localE': 'en_US',
        'token': token
    };

    try {
        logger.info(`Buscando detalhes do inversor Solplanet: ${inverterId}...`);
        const response = await axios.get(detailUrl, { headers, params });

        if (response.data && response.data.code === 200) {
            logger.info(`Detalhes para o inversor ${inverterId} obtidos com sucesso.`);
            return response.data;
        } else {
            throw new Error(`Falha ao buscar detalhes do inversor ${inverterId}: ${response.data.msg || 'Resposta inválida'}`);
        }
    } catch (error) {
        logger.error(`Erro na requisição de detalhes do inversor ${inverterId}: ${error.message}`);
        if (error.response) logger.error(`Detalhes: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        throw error;
    }
}

module.exports = {
    getAuthCredentials,
    forceTokenRefresh,
    getInverterDetail,
};