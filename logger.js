// logger.js
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');

const { combine, timestamp, printf, colorize } = winston.format;

// Formato customizado para o console
const consoleFormat = printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

// Formato para os arquivos (sem nível, para manter a compatibilidade com o formato atual)
const fileFormat = printf(({ message, timestamp }) => {
  return `[${timestamp}] ${message}`;
});

const logger = winston.createLogger({
  level: 'info', // Nível mínimo de log a ser registrado
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    fileFormat
  ),
  transports: [
    // Salva todos os logs em arquivos diários rotacionados
    new winston.transports.DailyRotateFile({
      filename: path.join(logsDir, 'solarmon-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true, // Comprime os logs antigos
      maxSize: '20m',
      maxFiles: '90d' // Mantém os logs por 90 dias
    })
  ]
});

// Adiciona um transport para o console APENAS se não estiver em ambiente de produção.
// Isso é útil para ver os logs em tempo real durante o desenvolvimento.
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize(),
      consoleFormat
    )
  }));
}

module.exports = logger;