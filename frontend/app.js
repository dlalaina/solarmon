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

// Mapa para armazenar instâncias ativas do Chart.js para poder destruí-las
const activeCharts = new Map();

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
    // A verificação agora é baseada no nome de usuário salvo,
    // já que o token em si não é mais acessível via JS.
    // O servidor validará o cookie em cada requisição.
    return localStorage.getItem('username') !== null;
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
            localStorage.setItem('username', data.username); // Apenas o nome de usuário é salvo
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
async function handleLogout() {
    try {
        const response = await fetch('/api/logout', { method: 'POST' });
        if (!response.ok) {
            console.error("Falha no logout do servidor, mas limpando localmente.");
        }
    } catch (error) {
        console.error("Erro de rede ao fazer logout:", error);
    } finally {
        // Limpa o estado do frontend independentemente da resposta do servidor
        localStorage.removeItem('username');
        updateAuthUI();
        console.log("Logout realizado.");
    }
}

// --- FUNÇÃO PARA BUSCAR E RENDERIZAR O RESUMO DAS PLANTAS ---
async function fetchAndRenderPlantsSummary() {
    loadingSummaryIndicator.classList.remove('hidden');
    plantsSummaryTableBody.innerHTML = ''; // Limpa a tabela de resumo
    noPlantsSummaryMessage.classList.add('hidden');

    try {
        const response = await fetch('/api/plants-summary');
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
                row.classList.add('plants-summary-row'); // Classe para identificar e estilizar
                row.insertCell().textContent = item.plant_name;
                row.insertCell().textContent = item.inverter_id;
                
                const statusCell = row.insertCell();
                statusCell.classList.add('text-center');
                const statusCircle = document.createElement('span');
                statusCircle.classList.add('status-circle', `status-${item.status}`);
                statusCell.appendChild(statusCircle);

                const genTodayCell = row.insertCell();
                genTodayCell.classList.add('text-center');
                const genTodayValue = parseFloat(item.gen_today);
                genTodayCell.textContent = `${!isNaN(genTodayValue) ? genTodayValue.toFixed(2) + ' kWh' : 'N/A'}`;

                const currentMonthGenCell = row.insertCell();
                currentMonthGenCell.classList.add('text-center');
                const currentMonthGenValue = parseFloat(item.current_month_gen);
                currentMonthGenCell.textContent = `${!isNaN(currentMonthGenValue) ? currentMonthGenValue.toFixed(0) : '0'} kWh`;

                const lastMonthGenCell = row.insertCell();
                lastMonthGenCell.classList.add('text-center');
                const lastMonthGenValue = parseFloat(item.last_month_gen);
                lastMonthGenCell.textContent = `${!isNaN(lastMonthGenValue) ? lastMonthGenValue.toFixed(0) : '0'} kWh`;

                // Adiciona o evento de clique para expandir/recolher o gráfico
                row.addEventListener('click', () => toggleChartRow(row, item.plant_name, item.inverter_id));
            });
        }
    } catch (error) {
        console.error("Erro ao buscar resumo das plantas:", error);
        // Atualiza o colspan para o novo número de colunas (6)
        plantsSummaryTableBody.innerHTML = `<tr><td colspan="6" style="color: red; text-align: center;">Erro ao carregar resumo: ${error.message}</td></tr>`;
        noPlantsSummaryMessage.classList.add('hidden');
    } finally {
        loadingSummaryIndicator.classList.add('hidden');
    }
}

/**
 * Expande ou recolhe a linha de detalhes com o gráfico de geração mensal.
 * @param {HTMLTableRowElement} clickedRow - A linha da tabela que foi clicada.
 * @param {string} plantName - O nome da planta.
 * @param {string} inverterId - O ID do inversor.
 */
async function toggleChartRow(clickedRow, plantName, inverterId) {
    // Verifica se já existe uma linha de detalhe após a linha clicada
    const existingDetailRow = clickedRow.nextElementSibling;
    if (existingDetailRow && existingDetailRow.classList.contains('chart-detail-row')) {
        // Se existe, remove-a (recolhe) e destrói o gráfico associado
        const chartId = existingDetailRow.dataset.chartId;
        if (activeCharts.has(chartId)) {
            activeCharts.get(chartId).destroy();
            activeCharts.delete(chartId);
        }
        existingDetailRow.remove();
        clickedRow.classList.remove('expanded');
        return;
    }

    // Recolhe qualquer outra linha que esteja expandida
    document.querySelectorAll('.chart-detail-row').forEach(row => {
        const chartId = row.dataset.chartId;
        if (activeCharts.has(chartId)) {
            activeCharts.get(chartId).destroy();
            activeCharts.delete(chartId);
        }
        row.remove();
    });
    document.querySelectorAll('.plants-summary-row.expanded').forEach(row => row.classList.remove('expanded'));

    // Cria a nova linha de detalhe para o gráfico
    const detailRow = plantsSummaryTableBody.insertRow(clickedRow.rowIndex);
    const chartId = `chart-${plantName.replace(/\s/g, '-')}-${inverterId}`;
    detailRow.classList.add('chart-detail-row');
    detailRow.dataset.chartId = chartId;

    const detailCell = detailRow.insertCell();
    detailCell.colSpan = 6; // Abrange todas as colunas da tabela de resumo
    detailCell.innerHTML = `
        <div class="chart-container">
            <div class="chart-header">
                <button class="year-nav-btn" data-direction="-1">&lt;</button>
                <span class="chart-year"></span>
                <button class="year-nav-btn" data-direction="1">&gt;</button>
            </div>
            <div class="chart-canvas-wrapper">
                <canvas id="${chartId}"></canvas>
            </div>
            <div class="chart-loading hidden">Carregando...</div>
        </div>
    `;

    clickedRow.classList.add('expanded');

    // Renderiza o gráfico para o ano atual
    const currentYear = new Date().getFullYear();
    await renderMonthlyChart(detailCell, plantName, inverterId, currentYear);
}

/**
 * Busca os dados e renderiza o gráfico de geração mensal.
 * @param {HTMLTableCellElement} containerCell - A célula da tabela onde o gráfico será renderizado.
 * @param {string} plantName - O nome da planta.
 * @param {string} inverterId - O ID do inversor.
 * @param {number} year - O ano para buscar os dados.
 */
async function renderMonthlyChart(containerCell, plantName, inverterId, year) {
    const chartContainer = containerCell.querySelector('.chart-container');
    const loading = chartContainer.querySelector('.chart-loading');
    const yearSpan = chartContainer.querySelector('.chart-year');
    const canvas = chartContainer.querySelector('canvas');
    const chartId = canvas.id;

    loading.classList.remove('hidden');
    yearSpan.textContent = year;

    // Destrói a instância anterior do gráfico, se houver
    if (activeCharts.has(chartId)) {
        activeCharts.get(chartId).destroy();
    }

    try {
        const response = await fetch(`/api/monthly-generation?plantName=${encodeURIComponent(plantName)}&inverterId=${encodeURIComponent(inverterId)}&year=${year}`);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
        const monthlyData = await response.json();

        const labels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        const data = monthlyData.map(d => d.gen_kwh);

        const chart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: `Geração (kWh)`,
                    data,
                    backgroundColor: 'rgba(75, 192, 192, 0.6)',
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: 'Geração (kWh)', color: '#e0e0e0' },
                        ticks: { color: '#e0e0e0' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    x: {
                        ticks: { color: '#e0e0e0' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                },
                plugins: {
                    legend: { display: false },
                    title: { display: true, text: `Geração Mensal - ${plantName} / ${inverterId} - ${year}`, color: '#61dafb', font: { size: 16 } }
                }
            }
        });
        activeCharts.set(chartId, chart);

    } catch (error) {
        console.error(`Erro ao renderizar gráfico para ${plantName}/${inverterId} ano ${year}:`, error);
        canvas.style.display = 'none';
        loading.textContent = `Erro ao carregar dados: ${error.message}`;
    } finally {
        loading.classList.add('hidden');
    }

    // Configura os botões de navegação de ano
    containerCell.querySelectorAll('.year-nav-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Impede que o clique no botão feche a linha
            const newYear = year + parseInt(newBtn.dataset.direction, 10);
            renderMonthlyChart(containerCell, plantName, inverterId, newYear);
        });
    });
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
        const response = await fetch(`/api/clear-alarm/${alarmId}`, {
            method: 'POST',
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
            const response = await fetch(`/api/alarms/${alarmId}/observation`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
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


/**
 * Verifica proativamente o status da sessão do usuário.
 * Se a sessão expirou, desloga o usuário, avisando-o caso
 * esteja no meio da edição de uma observação para evitar perda de dados.
 */
async function checkSessionStatus() {
    // Se o usuário já não está logado no frontend, não há o que fazer.
    if (!isLoggedIn()) return;

    try {
        const response = await fetch('/api/auth/status');

        // Se a resposta for 401 ou 403, a sessão no servidor expirou.
        if (response.status === 401 || response.status === 403) {
            console.warn('Sessão expirada detectada pelo refresh automático.');

            // VERIFICAÇÃO CRÍTICA: O usuário está editando uma observação?
            const isEditing = document.querySelector('.observation-textarea');
            if (isEditing) {
                alert('Sua sessão expirou! Por favor, copie o texto da sua observação antes de clicar em OK. Você precisará fazer login novamente.');
            }

            handleLogout(); // Desloga o usuário da interface
        }
    } catch (error) {
        // Erro de rede não significa necessariamente que a sessão expirou,
        // então apenas logamos o erro sem deslogar o usuário.
        console.error('Erro de rede ao verificar o status da sessão:', error);
    }
}

// Carrega dados iniciais ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
    setActiveButton(showActiveBtn);
    fetchAndRenderPlantsSummary(); // Carrega o resumo primeiro
    updateAuthUI(); // Isso irá chamar fetchAlarms('active') UMA VEZ para a tabela principal
    setInterval(() => {
        console.log('Atualizando dados do dashboard automaticamente...');
        checkSessionStatus(); // Primeiro, verifica se a sessão ainda é válida
        fetchAndRenderPlantsSummary();
        const currentView = showActiveBtn.classList.contains('active') ? 'active' : 'history';
        fetchAlarms(currentView);
    }, 180 * 1000); // 180 segundos = 3 minutos
});
