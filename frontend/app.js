// app.js
const API_BASE_URL = '/api/alarms';

// Elementos da tabela de alarmes existentes
const alarmsTable = document.getElementById('alarmsTable');
const alarmsTableHead = alarmsTable.querySelector('thead');
const alarmsTableBody = alarmsTable.querySelector('tbody');
const loadingIndicator = document.getElementById('loading');
const noAlarmsMessage = document.getElementById('noAlarms');
const sectionTitle = document.getElementById('sectionTitle');
const showActiveBtn = document.getElementById('showActiveAlarms');
const showHistoryBtn = document.getElementById('showHistoryAlarms');

// NOVOS ELEMENTOS para a tabela de resumo de plantas
const plantsSummaryTableBody = document.querySelector('#plantsSummaryTable tbody');
const loadingSummaryIndicator = document.getElementById('loadingSummary');
const noPlantsSummaryMessage = document.getElementById('noPlantsSummary');

// NOVOS ELEMENTOS para Autenticação
const loginButton = document.getElementById('loginButton');
const logoutButton = document.getElementById('logoutButton');
const loggedInUserSpan = document.getElementById('loggedInUser');
const loginModal = document.getElementById('loginModal');
const closeButton = loginModal.querySelector('.close-button');
const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');

// Helper para formatar data/hora
const formatDateTime = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
};

// Helper para escapar HTML (para segurança ao exibir observações)
function escapeHTML(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// --- FUNÇÕES DE AUTENTICAÇÃO (NOVO) ---

// Verifica se o usuário está logado
function isLoggedIn() {
    return localStorage.getItem('accessToken') !== null;
}

// Obtém o nome de usuário logado
function getLoggedInUsername() {
    return localStorage.getItem('username');
}

// Atualiza a UI de autenticação
function updateAuthUI() {
    if (isLoggedIn()) {
        loginButton.classList.add('hidden');
        logoutButton.classList.remove('hidden');
        loggedInUserSpan.classList.remove('hidden');
        loggedInUserSpan.textContent = `Logado como: ${getLoggedInUsername()}`;
    } else {
        loginButton.classList.remove('hidden');
        logoutButton.classList.add('hidden');
        loggedInUserSpan.classList.add('hidden');
        loggedInUserSpan.textContent = '';
    }
    // Re-renderiza alarmes para mostrar/esconder coluna de Ações e edição de observação
    fetchAlarms(sectionTitle.textContent === 'Alarmes Ativos' ? 'active' : 'history');
}

// Lógica de Login
async function handleLogin(event) {
    event.preventDefault(); // Impede o envio padrão do formulário

    const username = usernameInput.value;
    const password = passwordInput.value;

    loginMessage.classList.add('hidden'); // Esconde mensagens anteriores

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            localStorage.setItem('accessToken', data.accessToken);
            localStorage.setItem('username', data.username);
            loginModal.classList.add('hidden'); // Esconde o modal
            updateAuthUI(); // Atualiza a UI
            usernameInput.value = ''; // Limpa campos
            passwordInput.value = '';
            console.log("Login bem-sucedido!");
        } else {
            loginMessage.textContent = data.message || 'Erro no login.';
            loginMessage.classList.remove('hidden');
            console.error("Erro no login:", data.message);
        }
    } catch (error) {
        loginMessage.textContent = 'Erro ao conectar ao servidor.';
        loginMessage.classList.remove('hidden');
        console.error("Erro de rede/servidor no login:", error);
    }
}

// Lógica de Logout
function handleLogout() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('username');
    updateAuthUI();
    console.log("Logout realizado.");
}

// --- FUNÇÃO PARA BUSCAR E RENDERIZAR O RESUMO DAS PLANTAS ---
async function fetchAndRenderPlantsSummary() {
    loadingSummaryIndicator.classList.remove('hidden');
    plantsSummaryTableBody.innerHTML = ''; // Limpa a tabela de resumo
    noPlantsSummaryMessage.classList.add('hidden');

    try {
        const response = await fetch('/api/plants-summary'); // Novo endpoint
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        let summaryData = await response.json();

        const statusOrder = { 'red': 1, 'yellow': 2, 'gray': 3, 'green': 4 };

        summaryData.sort((a, b) => {
            const orderA = statusOrder[a.status] || 99;
            const orderB = statusOrder[b.status] || 99;

            if (orderA === orderB) {
                return a.plant_name.localeCompare(b.plant_name);
            }
            return orderA - orderB;
        });

        if (summaryData.length === 0) {
            noPlantsSummaryMessage.classList.remove('hidden');
        } else {
            summaryData.forEach(item => {
                const row = plantsSummaryTableBody.insertRow();
                row.insertCell().textContent = item.plant_name;
                row.insertCell().textContent = item.inverter_id;
                
                const statusCell = row.insertCell();
                const statusCircle = document.createElement('span');
                statusCircle.classList.add('status-circle', `status-${item.status}`);
                statusCell.appendChild(statusCircle);

                const eTodayValue = parseFloat(item.e_today);
                row.insertCell().textContent = `${!isNaN(eTodayValue) ? eTodayValue.toFixed(2) : 'N/A'}`;
            });
        }
    } catch (error) {
        console.error("Erro ao buscar resumo das plantas:", error);
        plantsSummaryTableBody.innerHTML = `<tr><td colspan="4" style="color: red; text-align: center;">Erro ao carregar resumo: ${error.message}</td></tr>`;
        noPlantsSummaryMessage.classList.add('hidden');
    } finally {
        loadingSummaryIndicator.classList.add('hidden');
    }
}

// --- FUNÇÃO PARA BUSCAR E RENDERIZAR OS ALARMES ---
async function fetchAlarms(type = 'active') {
    loadingIndicator.classList.remove('hidden');
    alarmsTableBody.innerHTML = ''; // Limpa a tabela
    noAlarmsMessage.classList.add('hidden');

    try {
        const response = await fetch(`${API_BASE_URL}/${type}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const alarms = await response.json();

        // Atualiza o cabeçalho da tabela dinamicamente, passando o estado de login
        updateTableHeader(type, isLoggedIn());

        if (alarms.length === 0) {
            noAlarmsMessage.classList.remove('hidden');
        } else {
            alarms.forEach(alarm => {
                const row = alarmsTableBody.insertRow();
                row.dataset.alarmId = alarm.alarm_id;

                row.insertCell().textContent = alarm.alarm_id;
                row.insertCell().textContent = alarm.plant_name;
                row.insertCell().textContent = alarm.inverter_id;
                row.insertCell().textContent = alarm.alarm_type;
                row.insertCell().textContent = alarm.problem_details || 'N/A';
                row.insertCell().textContent = formatDateTime(alarm.triggered_at);
                row.insertCell().textContent = alarm.cleared_at ? formatDateTime(alarm.cleared_at) : '---';

                // --- NOVA CÉLULA: Observação ---
                const observationCell = row.insertCell();
                observationCell.classList.add('observation-cell');
                observationCell.dataset.alarmId = alarm.alarm_id;
                observationCell.innerHTML = alarm.observation ? escapeHTML(alarm.observation) : '<span class="no-observation-placeholder">Adicionar Observação</span>';
                
                // Adiciona a coluna de ações e o botão 'Limpar Alarme' APENAS se logado
                if (type === 'active' && isLoggedIn()) {
                    const actionCell = row.insertCell();
                    const clearButton = document.createElement('button');
                    clearButton.textContent = 'Limpar Alarme';
                    clearButton.className = 'clear-alarm-button';
                    clearButton.onclick = () => clearAlarm(alarm.alarm_id, clearButton);
                    actionCell.appendChild(clearButton);
                }
            });
        }
    } catch (error) {
        console.error("Erro ao buscar alarmes:", error);
        // Ajusta o colspan dinamicamente
        const totalColumns = type === 'active' && isLoggedIn() ? 9 : 8; // 8 para histórico, 9 para ativos (com observação + ação)
        alarmsTableBody.innerHTML = `<tr><td colspan="${totalColumns}" style="color: red; text-align: center;">Erro ao carregar alarmes: ${error.message}</td></tr>`;
        noAlarmsMessage.classList.add('hidden');
    } finally {
        loadingIndicator.classList.add('hidden');
    }
}

// ATUALIZADA: updateTableHeader agora recebe um parâmetro isLoggedIn
function updateTableHeader(type, authenticated) {
    alarmsTableHead.innerHTML = '';
    const headerRow = document.createElement('tr');
    alarmsTableHead.appendChild(headerRow);
    
    const headers = [
        'ID', 'Planta', 'Inversor', 'Tipo', 'Detalhes', 'Ativado Em', 'Limpo Em', 'Observação'
    ];

    if (type === 'active' && authenticated) { // Mostra 'Ações' apenas se ativo E autenticado
        headers.push('Ações');
    }

    headers.forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        headerRow.appendChild(th);
    });
}

// Nova função para limpar o alarme
async function clearAlarm(alarmId, buttonElement) {
    // Substitui alert/confirm por um modal futuro se necessário
    if (!confirm(`Tem certeza que deseja limpar o alarme ID ${alarmId}?`)) {
        return;
    }

    buttonElement.disabled = true;
    buttonElement.textContent = 'Limpando...';
    buttonElement.classList.add('loading-button');

    try {
        const accessToken = localStorage.getItem('accessToken');
        const response = await fetch(`/api/clear-alarm/${alarmId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}` // Inclui o token JWT
            }
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message); // Usando alert provisoriamente
            fetchAlarms('active');
            fetchAndRenderPlantsSummary();
        } else {
            // Lidar com erros de autenticação ou autorização
            if (response.status === 401 || response.status === 403) {
                alert(`Sessão expirada ou não autorizado. Por favor, faça login novamente.`);
                handleLogout(); // Força o logout no frontend
            } else {
                throw new Error(result.message || 'Erro desconhecido ao limpar alarme.');
            }
        }
    } catch (error) {
        console.error('Erro ao limpar alarme:', error);
        alert(`Falha ao limpar alarme: ${error.message}`); // Usando alert provisoriamente
        buttonElement.disabled = false;
        buttonElement.textContent = 'Limpar Alarme';
        buttonElement.classList.remove('loading-button');
    }
}

// Lógica para edição da Observação (existente, AGORA CONDICIONAL)
document.addEventListener('click', async (event) => {
    const target = event.target;

    // Se o usuário NÃO ESTIVER LOGADO, sai imediatamente
    if (!isLoggedIn()) {
        // Se tentar clicar em uma célula de observação quando não logado,
        // pode adicionar um feedback visual (opcional)
        if (target.classList.contains('observation-cell')) {
             console.log("É necessário estar logado para editar observações.");
             // alert("É necessário estar logado para editar observações."); // Opcional
        }
        return;
    }

    // Se clicou em uma célula de observação e não está editando ainda
    if (target.classList.contains('observation-cell') && !target.querySelector('textarea')) {
        const alarmId = target.dataset.alarmId;
        const currentObservation = target.querySelector('.no-observation-placeholder') ? '' : target.innerText.trim();

        target.innerHTML = '';

        const textarea = document.createElement('textarea');
        textarea.value = currentObservation;
        textarea.classList.add('observation-textarea');
        textarea.rows = 3;
        textarea.style.width = '100%';
        textarea.placeholder = 'Digite sua observação aqui...';
        target.appendChild(textarea);
        textarea.focus();

        const saveBtn = document.createElement('button');
        saveBtn.innerText = 'Salvar';
        saveBtn.classList.add('save-observation-btn');
        saveBtn.dataset.alarmId = alarmId;

        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = 'Cancelar';
        cancelBtn.classList.add('cancel-observation-btn');
        cancelBtn.dataset.originalObservation = currentObservation;

        target.appendChild(saveBtn);
        target.appendChild(cancelBtn);

    } else if (target.classList.contains('save-observation-btn')) {
        const alarmId = target.dataset.alarmId;
        const textarea = target.parentNode.querySelector('.observation-textarea');
        const newObservation = textarea.value;

        target.disabled = true;
        target.nextSibling.disabled = true;

        try {
            const accessToken = localStorage.getItem('accessToken'); // Obtém o token
            const response = await fetch(`/api/alarms/${alarmId}/observation`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}` // Envia o token
                },
                body: JSON.stringify({ observation: newObservation })
            });

            if (!response.ok) {
                const errorData = await response.json();
                // Lidar com erros de autenticação ou autorização
                if (response.status === 401 || response.status === 403) {
                    alert(`Sessão expirada ou não autorizado. Por favor, faça login novamente.`);
                    handleLogout(); // Força o logout no frontend
                } else {
                    throw new Error(errorData.error || 'Falha ao salvar observação');
                }
            }

            const cell = target.parentNode;
            cell.innerHTML = newObservation ? escapeHTML(newObservation) : '<span class="no-observation-placeholder">Adicionar Observação</span>';
        } catch (error) {
            console.error('Erro ao salvar observação:', error);
            alert('Erro ao salvar observação: ' + error.message); // Usando alert provisoriamente
            const cell = target.parentNode;
            cell.innerHTML = target.parentNode.querySelector('.cancel-observation-btn').dataset.originalObservation || '<span class="no-observation-placeholder">Adicionar Observação</span>';
        } finally {
            if (target.disabled) target.disabled = false;
            if (target.nextSibling && target.nextSibling.disabled) target.nextSibling.disabled = false;
        }

    } else if (target.classList.contains('cancel-observation-btn')) {
        const cell = target.parentNode;
        const originalObservation = target.dataset.originalObservation;
        cell.innerHTML = originalObservation ? escapeHTML(originalObservation) : '<span class="no-observation-placeholder">Adicionar Observação</span>';
    }
});


function setActiveButton(button) {
    showActiveBtn.classList.remove('active');
    showHistoryBtn.classList.remove('active');
    button.classList.add('active');
}

// Event Listeners para os botões de filtro
showActiveBtn.addEventListener('click', () => {
    sectionTitle.textContent = 'Alarmes Ativos';
    setActiveButton(showActiveBtn);
    fetchAlarms('active');
});

showHistoryBtn.addEventListener('click', () => {
    sectionTitle.textContent = 'Histórico de Alarmes';
    setActiveButton(showHistoryBtn);
    fetchAlarms('history');
});

// Event Listeners para os novos botões de autenticação
loginButton.addEventListener('click', () => {
    loginModal.classList.remove('hidden'); // Mostra o modal
    loginMessage.classList.add('hidden'); // Esconde mensagens anteriores
    usernameInput.focus();
});

closeButton.addEventListener('click', () => {
    loginModal.classList.add('hidden'); // Esconde o modal
});

// Fecha o modal se clicar fora dele
window.addEventListener('click', (event) => {
    if (event.target === loginModal) {
        loginModal.classList.add('hidden');
    }
});

loginForm.addEventListener('submit', handleLogin);
logoutButton.addEventListener('click', handleLogout);


// Carrega dados iniciais ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
    setActiveButton(showActiveBtn);
    fetchAndRenderPlantsSummary(); // Carrega o resumo primeiro
    updateAuthUI(); // Isso irá chamar fetchAlarms('active') UMA VEZ para a tabela principal
    // NOVO CÓDIGO PARA REFRESH AUTOMÁTICO
    setTimeout(() => {
        location.reload();
    }, 180 * 1000);
});

