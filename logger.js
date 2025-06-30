// logger.js
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');
const { combine, timestamp, printf, colorize } = winston.format;

// Cache para armazenar as instâncias de logger
const loggers = {};

// Formato customizado para o console
const consoleFormat = printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

// Formato para os arquivos
const fileFormat = printf(({ message, timestamp }) => {
  return `[${timestamp}] ${message}`;
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
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      fileFormat
    ),
    transports: [
      new winston.transports.DailyRotateFile({
        filename: path.join(logsDir, `${category}-%DATE%.log`), // Nome do arquivo baseado na categoria
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '90d'
      })
    ]
  });

  // Adiciona console transport para ambientes de não-produção
  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      format: combine(
        colorize(),
        printf(({ level, message, timestamp }) => {
          // Adiciona a categoria ao log do console para clareza
          return `[${timestamp}] [${category.toUpperCase()}] ${level}: ${message}`;
        })
      )
    }));
  }

  loggers[category] = logger;
  return logger;
}

module.exports = getLogger;