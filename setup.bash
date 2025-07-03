#!/bin/bash

# setup.bash
# Script de instalação e configuração para o projeto SolarMon.
# Este script deve ser executado com privilégios de root (sudo).

# Sai imediatamente se um comando falhar.
set -e

# --- Funções de Log ---
log_info() {
    echo -e "\e[32m[INFO]\e[0m $1"
}

log_warn() {
    echo -e "\e[33m[WARN]\e[0m $1"
}

log_error() {
    echo -e "\e[31m[ERROR]\e[0m $1"
    exit 1
}

# --- Verificação de Root ---
if [ "$EUID" -ne 0 ]; then
  log_error "Este script precisa ser executado como root. Por favor, use 'sudo'."
fi

# --- Variáveis Globais ---
OS_FAMILY=""
PKG_MANAGER=""
PROJECT_PATH=""
NODE_PATH=""
NPM_PATH=""
MYSQL_ROOT_PASSWORD=""
MYSQL_CMD_AUTH=""
CERTBOT_PATH=""

# --- 1. Verificação do Sistema Operacional ---
check_os() {
    log_info "Verificando o sistema operacional..."
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        if [[ "$ID" == "debian" || "$ID" == "ubuntu" || "$ID_LIKE" == "debian" ]]; then
            OS_FAMILY="debian"
            PKG_MANAGER="apt-get"
            log_info "Sistema baseado em Debian detectado. Usando '$PKG_MANAGER'."
        elif [[ "$ID" == "rhel" || "$ID" == "centos" || "$ID" == "fedora" || "$ID_LIKE" == "rhel" || "$ID_LIKE" == "fedora" ]]; then
            OS_FAMILY="redhat"
            if command -v dnf &> /dev/null; then
                PKG_MANAGER="dnf"
            else
                PKG_MANAGER="yum"
            fi
            log_info "Sistema baseado em Red Hat detectado. Usando '$PKG_MANAGER'."
        else
            log_error "Distribuição Linux não suportada: $NAME. Este script suporta sistemas baseados em Debian e Red Hat."
        fi
    else
        log_error "Não foi possível determinar a distribuição do Linux. O arquivo /etc/os-release não foi encontrado."
    fi
}

# --- 2. Verificação do Caminho do Projeto ---
get_project_path() {
    log_info "Verificando o caminho do projeto..."
    # Determina o diretório absoluto onde o script está sendo executado.
    # Este método é robusto e funciona mesmo com links simbólicos.
    local SCRIPT_DIR
    SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

    # Verifica se um arquivo chave do projeto existe para confirmar que estamos no diretório correto.
    if [ ! -f "${SCRIPT_DIR}/main.js" ] || [ ! -f "${SCRIPT_DIR}/package.json" ]; then
        log_error "O script de setup não parece estar no diretório raiz do projeto 'solarmon'."
        log_error "Por favor, execute este script a partir do diretório do projeto."
    fi

    PROJECT_PATH="$SCRIPT_DIR"
    log_info "Diretório do projeto encontrado em: $PROJECT_PATH"
}

# --- 3. Criação do Usuário e Grupo ---
create_solarmon_user() {
    log_info "Verificando e criando usuário e grupo 'solarmon'..."
    
    # Cria o grupo 'solarmon' se ele não existir
    if ! getent group solarmon > /dev/null; then
        log_info "Grupo 'solarmon' não existe. Criando grupo de sistema..."
        groupadd -r solarmon
    else
        log_info "Grupo 'solarmon' já existe."
    fi

    # Cria o usuário 'solarmon' se ele não existir
    if ! id -u solarmon > /dev/null 2>&1; then
        log_info "Usuário 'solarmon' não existe. Criando usuário de sistema..."
        useradd -r -g solarmon -d "$PROJECT_PATH" -s /bin/false solarmon
    else
        log_info "Usuário 'solarmon' já existe."
    fi

    log_info "Definindo o proprietário do diretório do projeto para 'solarmon:solarmon'..."
    chown -R solarmon:solarmon "$PROJECT_PATH"
}

# --- 4. Instalação do Node.js e dependências ---
install_node_nvm() {
    log_info "Verificando e instalando Node.js e npm..."

    # Instalar dependências para compilação, nvm e outras ferramentas (jq)
    log_info "Instalando dependências necessárias (git, curl, build-essential/gcc-c++, jq)..."
    if [ "$OS_FAMILY" == "debian" ]; then
        $PKG_MANAGER update -y >/dev/null
        $PKG_MANAGER install -y curl git build-essential jq
    else # redhat
        $PKG_MANAGER install -y curl git gcc-c++ make jq
    fi

    # Tenta encontrar node e npm no PATH do sistema
    if command -v node &> /dev/null && command -v npm &> /dev/null; then
        NODE_PATH=$(command -v node)
        NPM_PATH=$(command -v npm)
        log_info "Node.js e npm já encontrados no sistema."
        log_info "Node path: $NODE_PATH"
        log_info "npm path: $NPM_PATH"
    else
        log_info "Node.js não encontrado. Instalando via nvm para o usuário 'solarmon'..."
        
        # Baixar e executar o script de instalação do nvm como o usuário 'solarmon'
        # Usamos 'su' para executar como 'solarmon' com um shell bash temporário.
        su -s /bin/bash -c "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash" solarmon
        
        log_info "Instalando a versão LTS mais recente do Node.js..."
        # O diretório home do usuário solarmon é o PROJECT_PATH
        # O comando 'source' é necessário para carregar o nvm na sessão atual do subshell
        su -s /bin/bash -c "source $PROJECT_PATH/.nvm/nvm.sh && nvm install --lts" solarmon

        # Obter os caminhos para node e npm
        NODE_PATH=$(su -s /bin/bash -c "source $PROJECT_PATH/.nvm/nvm.sh && which node" solarmon)
        NPM_PATH=$(su -s /bin/bash -c "source $PROJECT_PATH/.nvm/nvm.sh && which npm" solarmon)

        if [ -z "$NODE_PATH" ] || [ -z "$NPM_PATH" ]; then
            log_error "Falha ao instalar o Node.js ou obter os caminhos via nvm."
        fi
        log_info "Node.js e npm instalados com sucesso via nvm."
        log_info "Node path: $NODE_PATH"
        log_info "npm path: $NPM_PATH"
    fi

    log_info "Instalando dependências do projeto com npm..."
    # Executar npm install como o usuário 'solarmon' no diretório do projeto
    su -s /bin/bash -c "cd $PROJECT_PATH && $NPM_PATH install --production" solarmon
    log_info "Dependências do projeto instaladas."
}

# --- 5. Instalação e Configuração do MySQL ---
install_and_configure_mysql() {
    log_info "Verificando e instalando o MySQL Server..."

    if ! command -v mysql &> /dev/null; then
        log_info "MySQL não encontrado. Instalando..."
        if [ "$OS_FAMILY" == "debian" ]; then
            $PKG_MANAGER install -y mysql-server openssl
            # Em Debian/Ubuntu, o serviço é geralmente 'mysql'
            systemctl enable --now mysql
        else # redhat
            $PKG_MANAGER install -y mysql-server openssl
            # Em RHEL/CentOS, o serviço é geralmente 'mysqld'
            systemctl enable --now mysqld
        fi
        log_info "MySQL Server instalado e iniciado."
        log_warn "A instalação padrão do MySQL pode não ser segura. Recomenda-se executar 'mysql_secure_installation' manualmente após este script."
    else
        log_info "MySQL já está instalado."
        # Garante que openssl está instalado mesmo que mysql já exista
        if ! command -v openssl &> /dev/null; then
            log_info "Instalando openssl..."
            $PKG_MANAGER install -y openssl
        fi
    fi

    log_info "Verificando o acesso ao MySQL como usuário root..."
    # Tenta conectar sem senha primeiro
    if mysql -u root -e "SELECT 1;" &> /dev/null; then
        log_info "Acesso como root sem senha via socket bem-sucedido."
        MYSQL_CMD_AUTH=""
    else
        log_warn "Acesso como root via socket parece requerer uma senha."
        while true; do
            read -sp "Por favor, insira a senha do root do MySQL: " MYSQL_ROOT_PASSWORD
            echo
            # Testa a senha fornecida
            if mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1;" &> /dev/null; then
                log_info "Senha do root do MySQL verificada com sucesso."
                MYSQL_CMD_AUTH="-p$MYSQL_ROOT_PASSWORD"
                break
            else
                log_warn "Senha incorreta. Por favor, tente novamente ou pressione Ctrl+C para sair."
            fi
        done
    fi
}

# --- 6. Setup do Banco de Dados e Credenciais ---
setup_mysql_database() {
    log_info "Configurando o banco de dados 'solarmon' e o usuário..."

    # Verificar se o schema.sql existe
    if [ ! -f "$PROJECT_PATH/templates/schema.sql" ]; then
        log_error "Arquivo de schema não encontrado em '$PROJECT_PATH/templates/schema.sql'."
    fi

    # Criar o banco de dados se não existir e carregar o schema
    log_info "Criando banco de dados 'solarmon' (se não existir)..."
    mysql -u root $MYSQL_CMD_AUTH -e "CREATE DATABASE IF NOT EXISTS solarmon;"
    log_info "Carregando schema do banco de dados..."
    mysql -u root $MYSQL_CMD_AUTH solarmon < "$PROJECT_PATH/templates/schema.sql"

    # Gerar uma senha segura para o usuário do banco de dados
    log_info "Gerando senha para o usuário 'solarmon' do MySQL..."
    local SOLARMON_DB_PASSWORD
    SOLARMON_DB_PASSWORD=$(openssl rand -base64 24)

    # Criar ou atualizar o usuário 'solarmon' no MySQL
    log_info "Criando/Atualizando usuário 'solarmon' no MySQL e concedendo privilégios..."
    # Usar um 'here document' para passar múltiplos comandos SQL de forma limpa
    mysql -u root $MYSQL_CMD_AUTH <<-EOSQL
        CREATE USER IF NOT EXISTS 'solarmon'@'localhost' IDENTIFIED BY '${SOLARMON_DB_PASSWORD}';
        ALTER USER 'solarmon'@'localhost' IDENTIFIED BY '${SOLARMON_DB_PASSWORD}';
        GRANT SELECT, INSERT, UPDATE, DELETE, LOCK TABLES, SHOW VIEW, TRIGGER ON solarmon.* TO 'solarmon'@'localhost';
        FLUSH PRIVILEGES;
EOSQL
    log_info "Usuário 'solarmon' do MySQL configurado com sucesso."

    # Copiar e atualizar o arquivo credentials.json
    log_info "Atualizando 'credentials.json' com a nova senha do MySQL..."
    if [ ! -f "$PROJECT_PATH/credentials.json" ]; then
        if [ ! -f "$PROJECT_PATH/templates/credentials.json" ]; then
            log_error "Arquivo de template 'templates/credentials.json' não encontrado."
        fi
        cp "$PROJECT_PATH/templates/credentials.json" "$PROJECT_PATH/credentials.json"
    fi

    # Usar `|` como delimitador no sed para evitar problemas com caracteres especiais na senha
    sed -i "s|\"sua_senha_mysql\"|\"$SOLARMON_DB_PASSWORD\"|" "$PROJECT_PATH/credentials.json"
    log_info "Arquivo 'credentials.json' atualizado."
}

# --- 7. Instalação e Configuração do Nginx e Certbot ---
install_and_configure_webserver() {
    log_info "Configurando o servidor web Nginx e o Certbot..."

    # Instalar Nginx e dependências do Certbot (snapd)
    log_info "Instalando Nginx e Snapd..."
    if [ "$OS_FAMILY" == "debian" ]; then
        $PKG_MANAGER install -y nginx snapd
    else # redhat
        $PKG_MANAGER install -y nginx snapd
        # Em RHEL/CentOS, o SELinux pode bloquear o Nginx de fazer conexões de rede
        if command -v sestatus &> /dev/null && sestatus | grep "SELinux status" | grep -q "enabled"; then
            log_warn "SELinux está ativado. Permitindo que o Nginx faça conexões de rede..."
            setsebool -P httpd_can_network_connect 1
        fi
    fi
    systemctl enable --now nginx

    # Instalar Certbot via Snap
    if command -v certbot &> /dev/null; then
        CERTBOT_PATH=$(command -v certbot)
        log_info "Certbot já está instalado em: $CERTBOT_PATH"
    else
        log_info "Instalando Certbot via Snap..."
        # Habilitar o socket do snapd se não estiver ativo
        if ! systemctl is-active --quiet snapd.socket; then
            systemctl enable --now snapd.socket
        fi
        # Criar link simbólico se não existir (necessário em algumas distros)
        if [ ! -L /snap ]; then
            ln -s /var/lib/snapd/snap /snap
        fi
        snap install --classic certbot
        # Garantir que o comando certbot esteja no PATH
        if [ ! -L /usr/bin/certbot ]; then
            ln -s /snap/bin/certbot /usr/bin/certbot
        fi
        CERTBOT_PATH="/usr/bin/certbot"
        log_info "Certbot instalado com sucesso via Snap."
    fi

    # Obter informações do usuário
    local SUBDOMAIN
    local EMAIL
    while [ -z "$SUBDOMAIN" ]; do
        read -p "Por favor, insira o subdomínio completo para o SolarMon (ex: solarmon.meudominio.com): " SUBDOMAIN
    done
    while [ -z "$EMAIL" ]; do
        read -p "Por favor, insira seu e-mail (para notificações do Let's Encrypt): " EMAIL
    done

    # Criar a configuração do Nginx para o SolarMon
    local NGINX_CONF_PATH
    if [ "$OS_FAMILY" == "debian" ]; then
        NGINX_CONF_PATH="/etc/nginx/sites-available/solarmon"
    else # redhat
        NGINX_CONF_PATH="/etc/nginx/conf.d/solarmon.conf"
    fi

    log_info "Criando arquivo de configuração do Nginx em: $NGINX_CONF_PATH"
    # Usar um 'here document' para criar o arquivo de configuração
    cat > "$NGINX_CONF_PATH" <<-EOF
server {
    listen 80;
    server_name ${SUBDOMAIN};

    location / {
        root ${PROJECT_PATH};
        index index.html;
        try_files \$uri \$uri/ =404;
    }

    location ~ ^/(api|telegram-webhook) {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

    # Habilitar o site no Nginx (apenas para Debian)
    if [ "$OS_FAMILY" == "debian" ]; then
        if [ ! -L "/etc/nginx/sites-enabled/solarmon" ]; then
            ln -s "$NGINX_CONF_PATH" /etc/nginx/sites-enabled/
        fi
        # Remover o site padrão se existir, para evitar conflitos
        if [ -L "/etc/nginx/sites-enabled/default" ]; then
            rm /etc/nginx/sites-enabled/default
        fi
    fi

    # Testar a configuração do Nginx e recarregar
    log_info "Testando a configuração do Nginx..."
    nginx -t
    log_info "Recarregando o Nginx para aplicar a nova configuração..."
    systemctl reload nginx

    # Executar o Certbot para obter o certificado SSL
    log_info "Executando o Certbot para obter o certificado SSL para ${SUBDOMAIN}..."
    log_warn "Certifique-se de que seu DNS para ${SUBDOMAIN} está apontando para o IP deste servidor."
    log_warn "O Certbot iniciará em 10 segundos..."
    sleep 10
    
    "$CERTBOT_PATH" --nginx -d "$SUBDOMAIN" --non-interactive --agree-tos --email "$EMAIL"

    log_info "Configuração do Nginx e Certbot concluída com sucesso!"
    log_info "Seu site deve estar acessível em https://${SUBDOMAIN}"
}

# --- 8. Configuração dos Serviços Systemd ---
setup_systemd_services() {
    log_info "Configurando os serviços do systemd..."

    local service_files=("solarmon-main.service" "solarmon-main.timer" "solarmon-webserver.service")

    for service_file in "${service_files[@]}"; do
        local template_path="$PROJECT_PATH/templates/$service_file"
        local target_path="/etc/systemd/system/$service_file"

        if [ ! -f "$template_path" ]; then
            log_error "Arquivo de template de serviço não encontrado: $template_path"
        fi

        log_info "Copiando e configurando $service_file..."
        cp "$template_path" "$target_path"

        # Substituir placeholders. Usar `|` como delimitador para evitar conflitos com `/` nos caminhos.
        sed -i "s|%PROJECT_PATH%|$PROJECT_PATH|g" "$target_path"
        sed -i "s|%NODE_PATH%|$NODE_PATH|g" "$target_path"
    done

    log_info "Recarregando o daemon do systemd para aplicar as mudanças..."
    systemctl daemon-reload

    log_info "Serviços do systemd configurados com sucesso."
}

# --- 9. Configuração do Cron Job ---
setup_cron_job() {
    log_info "Configurando o cron job para o backup do schema do banco de dados..."

    # O comando a ser executado
    local CRON_CMD="${PROJECT_PATH}/update_schema.bash >> ${PROJECT_PATH}/logs/schema_update.log 2>&1"
    # A linha completa do cron
    local CRON_JOB="1 * * * * ${CRON_CMD}"

    # Verifica se o cron job já existe para o usuário 'solarmon'
    # Usamos grep -F para tratar a string como literal e evitar problemas com '*'
    if crontab -u solarmon -l 2>/dev/null | grep -Fq -- "$CRON_CMD"; then
        log_info "O cron job para o backup do schema já está configurado."
    else
        log_info "Adicionando o cron job para o usuário 'solarmon'..."
        # Adiciona o novo cron job sem remover os existentes
        (crontab -u solarmon -l 2>/dev/null; echo "$CRON_JOB") | crontab -u solarmon -
        log_info "Cron job adicionado com sucesso."
    fi
}

# --- 10. Verificação Final e Ativação dos Serviços ---
finalize_and_start_services() {
    log_info "Verificando o preenchimento do arquivo 'credentials.json'..."

    # Verifica se algum valor placeholder ainda existe no credentials.json
    if grep -q -E '"seu_|sua_|<|>"' "$PROJECT_PATH/credentials.json"; then
        log_warn "O arquivo 'credentials.json' parece conter valores não preenchidos."
        log_error "Por favor, edite o arquivo '$PROJECT_PATH/credentials.json' e preencha todos os campos necessários antes de continuar."
    fi

    log_info "Arquivo 'credentials.json' verificado com sucesso."

    log_info "Habilitando e iniciando os serviços do SolarMon..."
    systemctl enable --now solarmon-main.timer
    systemctl enable --now solarmon-webserver.service

    log_info "Instalação concluída!"
    log_info "Para verificar o status dos serviços, use: 'systemctl status solarmon-main.timer' e 'systemctl status solarmon-webserver.service'"
}

# --- Função Principal ---
main() {
    check_os
    get_project_path
    create_solarmon_user
    install_node_nvm
    install_and_configure_mysql
    setup_mysql_database
    install_and_configure_webserver
    setup_systemd_services
    setup_cron_job
    finalize_and_start_services
}

# --- Execução ---
main