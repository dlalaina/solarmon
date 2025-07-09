// solplanetApi.js
const axios = require('axios');
const logger = require('./logger')('solplanet');

const API_BASE_URL = 'https://internation-pro-cloud.solplanet.net/api';

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
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
        'Content-Type': 'application/json',
        'Origin': 'https://internation-pro-cloud.solplanet.net',
        'Referer': 'https://internation-pro-cloud.solplanet.net/user/login',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'localE': 'en_US'
    };

    try {
        logger.info('Tentando fazer login na API da Solplanet...');
        const response = await axios.post(loginUrl, payload, { headers });

        if (response.data && response.data.code === 200 && response.data.result && response.data.result.token) {
            const token = response.data.result.token;
            
            const setCookieHeader = response.headers['set-cookie'];
            let acw_tc = null;
            if (setCookieHeader) {
                const cookie = setCookieHeader.find(c => c.startsWith('acw_tc='));
                if (cookie) {
                    acw_tc = cookie.split(';')[0];
                }
            }

            if (!acw_tc) {
                throw new Error('Cookie "acw_tc" não encontrado na resposta de login.');
            }

            logger.info('Login na Solplanet realizado com sucesso.');
            return { token, cookie: acw_tc };
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
 * Busca os detalhes de um inversor específico.
 * @param {{token: string, cookie: string}} auth - O objeto de autenticação com token e cookie.
 * @param {string} inverterId - O número de série (SN) do inversor.
 * @returns {Promise<object>} Os dados detalhados do inversor.
 */
async function getInverterDetail(auth, inverterId) {
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
        'token': auth.token,
        'Cookie': auth.cookie
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
    login,
    getInverterDetail,
};