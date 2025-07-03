// logger.js
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');
const { combine, timestamp, printf, colorize, label } = winston.format;

// Cache para armazenar as instâncias de logger
const loggers = {};

// Formato customizado para o console
const consoleFormat = printf(({ level, message, label, timestamp }) => {
  return `[${timestamp}] [${label}] ${level}: ${message}`;
});

// Formato para os arquivos
const fileFormat = printf(({ level, message, label, timestamp }) => {
  return `[${timestamp}] [${label}] ${level}: ${message}`;
});

/**
 * Cria e retorna uma instância de logger para uma categoria específica.
 * As instâncias são armazenadas em cache para reutilização.
 * @param {string} category - A categoria do log (ex: 'main', 'web', 'email', 'telegram').
 * @returns {winston.Logger} A instância do logger.
 */
function getLogger(category = 'main') {
  if (loggers[category]) {
    return loggers[category];
  }

  const logger = winston.createLogger({
    level: 'info',
    format: combine(
      label({ label: category.toUpperCase() }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      fileFormat
    ),
    transports: [
      new winston.transports.DailyRotateFile({
        filename: path.join(logsDir, `${category}-%DATE%.log`),
        datePattern: 'YYYY-MM-DD',
        createSymlink: true,
        symlinkName: `${category}.log`,
        // A compactação (zippedArchive) e a exclusão (maxFiles) agora são gerenciadas
        // manualmente pela função manageLogFiles em main.js para evitar race conditions
        // e garantir um comportamento consistente para todos os tipos de log.
        maxSize: '20m' // Mantemos o maxSize para evitar arquivos de log diários excessivamente grandes.
      })
    ]
  });

  // Adiciona console transport para ambientes de não-produção
  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      level: 'error', // <--- Alteração: Log apenas erros no console
      format: combine(
        colorize(),
        consoleFormat
      )
    }));
  }

  loggers[category] = logger;
  return logger;
}

module.exports = getLogger;