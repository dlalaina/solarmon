# SolarMon: Monitoramento Centralizado de Usinas Solares

## Visão Geral do Projeto

O SolarMon é um sistema de monitoramento para usinas solares que centraliza dados de múltiplas fontes em uma única interface. Ele coleta dados de APIs de inversores (Growatt e Solarman), processa e-mails de alerta, detecta falhas de forma inteligente e notifica os responsáveis via Telegram.

O sistema é composto por um script de coleta de dados (`main.js`), que deve ser executado periodicamente (via CRON), e um servidor web (`webserver.js`) que fornece um dashboard e uma API REST para gerenciamento.

## Funcionalidades Chave

*   **Integração Multi-API:** Coleta dados das APIs da Growatt e Solarman.
*   **Dashboard Web:** Interface para visualizar o status geral das usinas, alarmes ativos e histórico.
*   **Detecção Avançada de Alarmes:** Lógica para identificar inversores offline, strings com baixa produção, falhas parciais em MPPTs, etc.
*   **Processamento de E-mails:** Lê uma caixa de entrada IMAP para converter e-mails de alerta (Growatt, Solarman) em alarmes no sistema.
*   **Notificações via Telegram:** Envia alertas de novos alarmes e resoluções para administradores e proprietários das usinas.
*   **Autenticação de Usuário:** Sistema de login (JWT) para proteger ações como limpar alarmes e adicionar observações.
*   **Persistência de Dados:** Utiliza um banco de dados MySQL para armazenar todos os dados de monitoramento e alarmes.

## Stack Tecnológico

*   **Backend:** Node.js, Express.js
*   **Banco de Dados:** MySQL
*   **Frontend:** HTML, CSS, JavaScript (vanilla)
*   **Autenticação:** JSON Web Tokens (JWT)

## Configuração e Execução

### 1. Pré-requisitos
*   Node.js (v18 ou superior)
*   Um servidor de banco de dados MySQL

### 2. Instalação
```bash
# Clone o repositório
git clone <URL_DO_REPOSITORIO>
cd solarmon

# Instale as dependências
npm install
```

### 3. Configuração do Banco de Dados
Crie um banco de dados no seu servidor MySQL. Você precisará criar as tabelas necessárias para o sistema funcionar (ex: `alarms`, `plant_config`, `solar_data`, `plant_info`, `consecutive_alarm_counts`, etc.).

### 4. Arquivo de Credenciais
Crie um arquivo `credentials.json` na raiz do projeto. Este arquivo não deve ser versionado. Use o template abaixo:

```json
{
  "mysql": {
    "host": "localhost",
    "user": "seu_usuario_mysql",
    "password": "sua_senha_mysql",
    "database": "solarmon_db"
  },
  "growatt": {
    "user": "seu_usuario_growatt",
    "password": "sua_senha_growatt"
  },
  "solarman": {
    "appId": "seu_app_id",
    "appSecret": "seu_app_secret",
    "email": "seu_email_solarman",
    "password_sha256": "hash_sha256_da_sua_senha",
    "orgId": "seu_org_id"
  },
  "telegram": {
    "botToken": "token_do_seu_bot_telegram",
    "chatId": "chat_id_do_admin"
  },
  "auth": {
    "jwtSecret": "uma_chave_secreta_longa_e_aleatoria",
    "adminUsername": "admin",
    "adminPassword": "uma_senha_forte_para_o_admin"
  },
  "imap": {
    "user": "seu_email_para_ler_alertas@exemplo.com",
    "password": "sua_senha_ou_app_password",
    "host": "imap.exemplo.com",
    "port": 993,
    "tls": true
  }
}
```

### 5. Executando a Aplicação
O sistema possui dois componentes principais que devem ser executados:

**a) Servidor Web (Dashboard e API)**
Inicia o servidor que serve a interface do usuário e a API REST.
```bash
node webserver.js
```
Acesse o dashboard em `http://localhost:3000`.

**b) Coletor de Dados e Gerenciador de Alarmes**
Este script busca os dados das APIs, processa e-mails e verifica os alarmes. Ele deve ser executado periodicamente.
```bash
# Para uma execução manual:
node main.js

# Em produção, configure um CRON job para executá-lo a cada 5-15 minutos:
# Exemplo de linha no crontab:
# */5 * * * * /usr/bin/node /caminho/completo/para/solarmon/main.js >> /caminho/para/log.log 2>&1
```
