// app.js
const API_BASE_URL = '/api/alarms'; // Use a porta que você configurou no server.js

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


// Helper para formatar data/hora
const formatDateTime = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    // Formato para DD/MM/YYYY HH:MM:SS
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
        let summaryData = await response.json(); // Use 'let' para reatribuir

        // --- INÍCIO DA ALTERAÇÃO PARA ORDENAÇÃO ---
        const statusOrder = { 'red': 1, 'yellow': 2, 'gray': 3, 'green': 4 };

        summaryData.sort((a, b) => {
            const orderA = statusOrder[a.status] || 99; // 99 para status desconhecidos (ir para o final)
            const orderB = statusOrder[b.status] || 99;

            if (orderA === orderB) {
                // Se os status forem iguais, mantenha a ordem original ou adicione uma ordem secundária
                // Por exemplo, para ordenar por nome da planta em ordem alfabética:
                return a.plant_name.localeCompare(b.plant_name);
            }
            return orderA - orderB;
        });
        // --- FIM DA ALTERAÇÃO PARA ORDENAÇÃO ---

        if (summaryData.length === 0) {
            noPlantsSummaryMessage.classList.remove('hidden');
        } else {
            summaryData.forEach(item => {
                const row = plantsSummaryTableBody.insertRow();
                row.insertCell().textContent = item.plant_name;
                row.insertCell().textContent = item.inverter_id;
                
                const statusCell = row.insertCell();
                const statusCircle = document.createElement('span');
                statusCircle.classList.add('status-circle', `status-${item.status}`); // Adiciona classes para a bolinha
                statusCell.appendChild(statusCircle);

                // CORRIGIDO: Garante que e_today seja um número antes de usar toFixed()
                const eTodayValue = parseFloat(item.e_today); // Tenta converter para número
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


// --- FUNÇÃO PARA BUSCAR E RENDERIZAR OS ALARMES (EXISTENTE) ---
async function fetchAlarms(type = 'active') {
    loadingIndicator.classList.remove('hidden');
    alarmsTableBody.innerHTML = ''; // Limpa a tabela
    noAlarmsMessage.classList.add('hidden'); // Esconde a mensagem de "nenhum alarme"

    try {
        const response = await fetch(`${API_BASE_URL}/${type}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const alarms = await response.json();

        // Atualiza o cabeçalho da tabela dinamicamente
        updateTableHeader(type);

        if (alarms.length === 0) {
            noAlarmsMessage.classList.remove('hidden');
        } else {
            alarms.forEach(alarm => {
                const row = alarmsTableBody.insertRow();
                row.dataset.alarmId = alarm.alarm_id; // Armazena o ID do alarme na linha

                row.insertCell().textContent = alarm.alarm_id;
                row.insertCell().textContent = alarm.plant_name;
                row.insertCell().textContent = alarm.inverter_id;
                row.insertCell().textContent = alarm.alarm_type;
                row.insertCell().textContent = alarm.problem_details || 'N/A'; // Detalhes podem ser nulos
                row.insertCell().textContent = formatDateTime(alarm.triggered_at); // Usar triggered_at
                row.insertCell().textContent = alarm.cleared_at ? formatDateTime(alarm.cleared_at) : '---';

                // --- NOVA CÉLULA: Observação ---
                const observationCell = row.insertCell();
                observationCell.classList.add('observation-cell');
                observationCell.dataset.alarmId = alarm.alarm_id;
                observationCell.innerHTML = alarm.observation ? escapeHTML(alarm.observation) : '<span class="no-observation-placeholder">Adicionar Observação</span>';

		// Adiciona a coluna de ações se for a visualização de alarmes ativos
		if (type === 'active') {
		    const actionCell = row.insertCell();
		    // Adiciona a condição para SOLARMAN_EMAIL_EVENT
		    if (alarm.alarm_type === 'GROWATT_EMAIL_EVENT' || alarm.alarm_type === 'SOLARMAN_EMAIL_EVENT') {
			const clearButton = document.createElement('button');
			clearButton.textContent = 'Limpar Alarme';
			clearButton.className = 'clear-alarm-button'; // Classe para estilização
			clearButton.onclick = () => clearAlarm(alarm.alarm_id, clearButton);
			actionCell.appendChild(clearButton);
		    } else {
			actionCell.textContent = 'N/A'; // Ou vazio para outros tipos de alarme
		    }
		}
            });
        }
    } catch (error) {
        console.error("Erro ao buscar alarmes:", error);
        // Ajuste o colspan para refletir o número total de colunas (agora com Observação)
        const totalColumns = type === 'active' ? 9 : 8; // 8 para histórico, 9 para ativos (com observação + ação)
        alarmsTableBody.innerHTML = `<tr><td colspan="${totalColumns}" style="color: red; text-align: center;">Erro ao carregar alarmes: ${error.message}</td></tr>`;
        noAlarmsMessage.classList.add('hidden'); // Esconde a mensagem de "nenhum alarme" em caso de erro
    } finally {
        loadingIndicator.classList.add('hidden');
    }
}

function updateTableHeader(type) {
    alarmsTableHead.innerHTML = ''; // Limpa o cabeçalho existente
    const headerRow = document.createElement('tr'); // CORRIGIDO: Crie um <tr>
    alarmsTableHead.appendChild(headerRow); // CORRIGIDO: Adicione o <tr> ao <thead>
    
    // Define os cabeçalhos fixos
    const headers = [
        'ID', 'Planta', 'Inversor', 'Tipo', 'Detalhes', 'Ativado Em', 'Limpo Em', 'Observação'
    ];

    // Adiciona "Ações" apenas para alarmes ativos
    if (type === 'active') {
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
    if (!confirm(`Tem certeza que deseja limpar o alarme ID ${alarmId}?`)) {
        return;
    }

    buttonElement.disabled = true;
    buttonElement.textContent = 'Limpando...';
    buttonElement.classList.add('loading-button'); // Adiciona classe para feedback visual

    try {
        const response = await fetch(`/api/clear-alarm/${alarmId}`, { // Rota direta para a API
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message);
            // Re-fetch os alarmes para atualizar a lista
            fetchAlarms('active');
            fetchAndRenderPlantsSummary(); // Atualiza também o resumo da planta
        } else {
            throw new Error(result.message || 'Erro desconhecido ao limpar alarme.');
        }
    } catch (error) {
        console.error('Erro ao limpar alarme:', error);
        alert(`Falha ao limpar alarme: ${error.message}`);
        buttonElement.disabled = false;
        buttonElement.textContent = 'Limpar Alarme';
        buttonElement.classList.remove('loading-button');
    }
}

// Lógica para edição da Observação (existente)
document.addEventListener('click', async (event) => {
    const target = event.target;

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
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ observation: newObservation })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Falha ao salvar observação');
            }

            const cell = target.parentNode;
            cell.innerHTML = newObservation ? escapeHTML(newObservation) : '<span class="no-observation-placeholder">Adicionar Observação</span>';
            // Alert opcional, pode ser substituído por feedback visual no próprio dashboard
            // alert('Observação salva com sucesso!');
        } catch (error) {
            console.error('Erro ao salvar observação:', error);
            alert('Erro ao salvar observação: ' + error.message);
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

// Carrega dados iniciais ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
    setActiveButton(showActiveBtn); // Garante que o botão "Ativos" esteja ativo no carregamento
    fetchAlarms('active'); // Carrega a tabela de alarmes
    fetchAndRenderPlantsSummary(); // Chama a função do novo resumo

document.addEventListener('DOMContentLoaded', () => {
    // ... seu código existente que já está aqui (setActiveButton, fetchAlarms, fetchAndRenderPlantsSummary) ...

    // NOVO CÓDIGO PARA REFRESH AUTOMÁTICO
    setTimeout(() => {
        location.reload(); // Recarrega a página
    }, 60 * 1000); // 60 segundos * 1000 milissegundos = 1 minuto
});
});
