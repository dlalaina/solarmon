# SolarMon: Central de Monitoramento e Gestão para Usinas Solares

## Visão Geral do Projeto

O SolarMon é uma aplicação robusta de monitoramento e gestão para usinas solares fotovoltaicas. Atualmente focada na integração com a **API da Growatt**, o projeto tem como visão estratégica e objetivo principal evoluir para uma **ferramenta centralizada e agnóstica de marca**, capaz de monitorar, gerenciar alarmes, notificar e exibir o status de **múltiplas plantas equipadas com inversores de diversas marcas**.

Este sistema visa simplificar a operação de portfólios de usinas solares, consolidando dados de diferentes fontes em um único dashboard intuitivo e automatizando processos críticos como detecção de falhas e notificações.

## Funcionalidades Chave

* **Monitoramento Centralizado de Plantas:**
    * Dashboard web intuitivo para visualizar rapidamente o status e o desempenho de todas as usinas solares conectadas.
    * Exibição de informações essenciais como nome da planta, inversor associado, seu status operacional e a geração diária de energia (kWh).
    * Recarrega automática do dashboard a cada minuto para garantir que os dados exibidos estejam sempre o mais próximo possível do tempo real.
* **Gestão Abrangente de Alarmes:**
    * Interface para visualizar e filtrar **alarmes ativos** e consultar um **histórico detalhado de alarmes** passados.
    * Capacidade de **adicionar, editar e salvar observações** personalizadas para cada alarme, permitindo registrar informações contextuais e ações tomadas.
    * Funcionalidade para "limpar" alarmes, auxiliando na gestão do ciclo de vida dos alertas.
* **Sistema de Notificação Automatizado:**
    * Envio proativo de alertas e informações relevantes sobre o status das plantas e ocorrência de alarmes.
    * Suporte a **notificações por e-mail** e via **Telegram**, garantindo que as equipes responsáveis sejam informadas prontamente.
* **Automação e Processamento de Dados:**
    * Componentes dedicados para processamento de dados em segundo plano, como o tratamento de alarmes recebidos por e-mail ou via API.
    * Execução de tarefas agendadas (via CRON, por exemplo) para coleta regular de dados e manutenção do sistema.
* **Arquitetura Extensível:**
    * Projetado com modularidade em mente, permitindo a fácil integração de APIs de **outras marcas de inversores** no futuro, sem a necessidade de reescrever a base do sistema.
    * Utilização de um banco de dados para persistir informações de alarmes e observações, tornando o sistema independente da volatilidade das APIs externas.

## Por Que o SolarMon?

No cenário atual de energia solar, onde operadores frequentemente gerenciam plantas com diferentes tipos e marcas de inversores, a fragmentação dos dados é um desafio. O SolarMon surge para:

* **Centralizar a Visão:** Unificar a monitoração de todo o portfólio de usinas em um único local, eliminando a necessidade de acessar múltiplos portais ou sistemas.
* **Agilizar a Resposta a Alarmes:** Fornecer ferramentas para gerenciar alarmes de forma eficiente, documentar observações e garantir que as notificações cheguem aos canais certos no momento certo.
* **Otimizar a Operação:** Reduzir o tempo gasto em verificações manuais e permitir que as equipes se concentrem na resolução proativa de problemas.
* **Crescimento Escalável:** Sua arquitetura modular foi pensada para expandir facilmente a compatibilidade com novos fabricantes de inversores, tornando-o uma ferramenta de longo prazo para a gestão de usinas.

## Stack Tecnológico

O SolarMon é construído sobre uma base robusta e flexível:

* **Linguagem de Programação:** JavaScript (Node.js)
* **Frontend:**
    * **HTML (`frontend/index.html`):** Estrutura das páginas web.
    * **CSS (`frontend/style.css`):** Estilização moderna com tema escuro para conforto visual.
    * **JavaScript (`frontend/app.js`):** Lógica interativa do dashboard (manipulação de DOM, requisições AJAX).
* **Backend/Servidor:**
    * **Node.js:** Ambiente de execução.
    * **`server.js`:** Servidor web (provavelmente utilizando Express.js para rotas API e servir arquivos estáticos do frontend).
    * **`growattApi.js`:** Módulo de abstração para comunicação com a API da Growatt (utilizando a biblioteca `PLCHome/growatt`).
    * **`database.js`:** Camada de abstração para interação com o banco de dados (responsável pela persistência de dados como observações de alarmes, status da planta, etc.).
* **Automação e Processos Assíncronos:**
    * **`app.js` (cron):** Script principal para execução de tarefas agendadas (CRON jobs), como coleta periódica de dados da API da Growatt, processamento de alarmes e manutenção do sistema.
    * **`alarmManager.js`:** Lógica central para processamento, classificação e gestão do ciclo de vida dos alarmes.
    * **`processGrowattEmailAlarms.js`:** Módulo específico para processar e-mails de alarme formatados pela Growatt, convertendo-os em alarmes do sistema.
* **Notificação:**
    * **`emailProcessor.js`:** Lógica para formatar e enviar notificações por e-mail.
    * **`telegramNotifier.js`:** Módulo para integração e envio de notificações via Telegram.
* **Utilitários:**
    * **`utils.js`:** Funções auxiliares e utilitários gerais utilizados em todo o projeto.
    * **`diagnosticLogger.js`:** Sistema de log centralizado para monitoramento e depuração da aplicação.

## Estrutura do Projeto
```bash
solarmon/
├── frontend/                     # Contém os arquivos do frontend acessíveis pelo navegador
│   ├── index.html                # Dashboard principal da interface do usuário
│   ├── app.js                    # Lógica JavaScript do frontend (interações do dashboard, requisições AJAX)
│   └── style.css                 # Estilos CSS da aplicação (inclui o tema escuro)
├── alarmManager.js               # Módulo para gerenciamento da lógica de alarmes (ativação, desativação, estado)
├── app.js                        # Script principal para tarefas agendadas (CRON jobs), processamento em background
├── database.js                   # Módulo de interface com o banco de dados (abstração para operações de persistência)
├── diagnosticLogger.js           # Ferramenta para logs e diagnósticos internos do sistema
├── emailProcessor.js             # Módulo para lidar com o envio de e-mails de notificação
├── growattApi.js                 # Módulo de abstração para interagir especificamente com a API da Growatt
├── processGrowattEmailAlarms.js  # Lógica para processar alarmes recebidos via e-mail da Growatt
├── server.js                     # Configuração e inicialização do servidor web (responsável por servir o frontend e expor APIs)
├── telegramNotifier.js           # Módulo para enviar notificações via Telegram
├── utils.js                      # Funções utilitárias diversas usadas em todo o projeto (ex: formatação de datas, escape HTML)
├── credentials.json              # Arquivo de credenciais sensíveis e configurações (IGNORADO pelo .gitignore)
├── logs/                         # Diretório para arquivos de log gerados pela aplicação (IGNORADO pelo .gitignore)
├── .gitignore                    # Regras para ignorar arquivos e diretórios no controle de versão Git
└── LICENSE                       # Informações sobre a licença do projeto
```

## Primeiros Passos

Para configurar e rodar o SolarMon em seu ambiente local:

1.  **Pré-requisitos:**
    * Node.js (versão LTS recomendada) e npm (gerenciador de pacotes do Node.js) instalados.
    * Git para clonar o repositório.

2.  **Clonar o Repositório:**
    ```bash
    git clone [https://github.com/seu-usuario/solarmon.git](https://github.com/seu-usuario/solarmon.git) # (ou o URL real do seu repositório)
    cd solarmon
    ```

3.  **Instalar Dependências:**
    ```bash
    npm install
    ```

4.  **Configurar Credenciais:**
    Crie um arquivo `credentials.json` na raiz do projeto (no mesmo nível de `server.js`) com suas credenciais da Growatt e outras configurações sensíveis (como tokens de Telegram, SMTP para e-mail, e conexão com o banco de dados). Exemplo:
    ```json
    {
      "growatt": {
        "user": "SEU_USUARIO_GROWATT",
        "password": "SUA_SENHA_GROWATT"
      },
      "telegram": {
        "botToken": "SEU_BOT_TOKEN",
        "chatId": "SEU_CHAT_ID"
      },
      "email": {
        "host": "smtp.exemplo.com",
        "port": 587,
        "secure": false,
        "user": "seu_email@exemplo.com",
        "pass": "sua_senha_email",
        "to": "destinatario@exemplo.com"
      },
      "mysql": {
        "host": "localhost",
        "user": "python",
        "password": "pSdk24Kd!",
        "database": "growatt"
      }
    }
    ```
    **Lembre-se: `credentials.json` está listado no `.gitignore` e não deve ser commitado no repositório público.**

5.  **Inicializar o Banco de Dados (se aplicável):**
    Dependendo da sua configuração em `database.js` e do SGBD escolhido, você pode precisar de um passo de inicialização do schema ou migrações.

6.  **Rodar a Aplicação:**
    * **Servidor Web:** Inicia o servidor que atende as requisições do frontend e expõe a API para o dashboard.
        ```bash
        node server.js
        ```
        O dashboard estará acessível via navegador (geralmente em `http://localhost:3000`, ou a porta configurada).
    * **Processos Agendados (CRON):** Este script é responsável pela coleta de dados, processamento de alarmes, etc. Deve ser executado em segundo plano e/ou agendado.
        ```bash
        node app.js # (Este é o app.js do cron)
        ```
        Para produção, considere usar ferramentas como PM2 para gerenciar os processos Node.js e garantir sua execução contínua.

## Próximos Passos e Visão Futura

O SolarMon está em constante evolução. Os planos futuros incluem:

* **Integração com Múltiplas Marcas:** Desenvolver módulos de integração para APIs de fabricantes de inversores além da Growatt, permitindo que o sistema consolide dados de fontes diversas.
* **Normalização de Dados:** Criar uma camada de abstração e transformação para normalizar os dados provenientes de diferentes APIs, garantindo que o dashboard e a lógica de gestão de alarmes funcionem de forma consistente, independentemente da fonte original dos dados.
* **Relatórios e Análises Avançadas:** Implementar funcionalidades de relatórios personalizados e análises de desempenho para fornecer insights mais profundos sobre a performance das usinas.
* **Interface de Administração:** Desenvolver uma interface de administração para gerenciar plantas, inversores, usuários, configurações de notificação e regras de alarme diretamente pelo dashboard.
