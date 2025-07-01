#!/bin/bash
# rodar no cron 0 * * * * <project_dir>/update_schema.sh >> <project_dir>/logs/schema_update.log 2>&1
# --- Configuração ---
# Garante que o script seja executado a partir do diretório do projeto
PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$PROJECT_DIR" || exit 1

# Carregue as credenciais do seu arquivo. Requer a ferramenta 'jq'.
# Instale com: sudo apt-get install jq (Debian/Ubuntu) ou sudo yum install jq (CentOS/RHEL)
DB_USER=$(jq -r '.mysql.user' credentials.json)
DB_PASS=$(jq -r '.mysql.password' credentials.json)
DB_NAME=$(jq -r '.mysql.database' credentials.json)
DB_HOST=$(jq -r '.mysql.host' credentials.json)

SCHEMA_FILE="templates/schema.sql"
TEMP_SCHEMA_FILE="templates/schema.sql.tmp"
COMMIT_MSG="Auto-commit: Atualização do schema do banco de dados"
GIT_AUTHOR_NAME="Cronjob Schema bkp"
GIT_AUTHOR_EMAIL="cron@solarmon.local"

LOG_FILE="logs/schema_update.log"
MAX_LOG_LINES=1000 # Define o número máximo de linhas a manter

# --- Rotação de Log Simples ---
# Verifica se o arquivo de log existe e se excedeu o número máximo de linhas.
if [ -f "$LOG_FILE" ]; then
    CURRENT_LINES=$(wc -l < "$LOG_FILE")
    if [ "$CURRENT_LINES" -gt "$MAX_LOG_LINES" ]; then
        echo "----------------------------------------" >> "$LOG_FILE"
        echo "Log atingiu ${CURRENT_LINES} linhas. Aparando para manter as últimas ${MAX_LOG_LINES}..." >> "$LOG_FILE"
        tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
fi

echo "----------------------------------------"
echo "Iniciando verificação de schema em $(date)"

# Garante que o diretório de templates exista
mkdir -p "$(dirname "$SCHEMA_FILE")"

# --- Lógica ---
# Exporta a senha como uma variável de ambiente para evitar expô-la na lista de processos.
# Esta é a forma mais segura de passar a senha para o mysqldump em scripts.
export MYSQL_PWD="$DB_PASS"

# 1. Gera um novo dump do schema em um arquivo temporário
# O uso de --column-statistics=0 é recomendado para versões mais novas do MySQL 8 para evitar diffs desnecessários.
mysqldump --no-data --no-tablespaces --column-statistics=0 -h"$DB_HOST" -u"$DB_USER" "$DB_NAME" > "$TEMP_SCHEMA_FILE"

# Verifica se o mysqldump foi bem-sucedido
if [ $? -ne 0 ]; then
    echo "ERRO: Falha ao executar mysqldump. Abortando."
    rm -f "$TEMP_SCHEMA_FILE" # Limpa o arquivo temporário
    exit 1
fi

# 2. Compara o arquivo temporário com o schema.sql existente
if ! diff -q "$SCHEMA_FILE" "$TEMP_SCHEMA_FILE" >/dev/null 2>&1; then
    echo "Diferença detectada no schema. Atualizando o arquivo e fazendo commit."

    # 3. Substitui o arquivo antigo pelo novo
    mv "$TEMP_SCHEMA_FILE" "$SCHEMA_FILE"

    # 4. Executa os comandos Git
    git add "$SCHEMA_FILE"
    # Apenas commita localmente. O push será feito manualmente pelo desenvolvedor.
    git -c user.name="$GIT_AUTHOR_NAME" -c user.email="$GIT_AUTHOR_EMAIL" commit -m "$COMMIT_MSG"
    echo "Commit local do schema realizado com sucesso."
else
    echo "Nenhuma alteração no schema detectada. Nada a fazer."
    # Limpa o arquivo temporário se não houver diferenças
    rm "$TEMP_SCHEMA_FILE"
fi

echo "Verificação de schema concluída."
echo "----------------------------------------"

# Limpa a variável de ambiente da senha por segurança
unset MYSQL_PWD
