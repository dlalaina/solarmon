// emailAlarmParsers.js
const { getFormattedTimestamp } = require('./utils');

/**
 * Parses an email text body for Growatt alarm details.
 * @param {string} emailText The plain text content of the email.
 * @returns {object|null} An object with extracted alarm details or null if no match.
 */
function parseGrowattEmail(emailText) {
    const regex = /Device serial number:([^\n]+)\nDevice alias:[^\n]+\nDataLog serial number:[^\n]+\nDataLog alias:[^\n]+\nPlant name:([^\n]+)\nTime:([^\n]+)\nEvent id:([^\(]+)\([^\)]+\)\nEvent description:([^\n]+)\nSuggestion:[^\n]+/;
    const match = emailText.match(regex);

    if (match) {
        return {
            inverterId: match[1].trim(),
            plantName: match[2].trim(),
            eventTimeStr: match[3].trim(),
            eventDescription: match[5].trim(),
            alarmType: "GROWATT-EMAIL-EVENT",
            severity: "CRITICAL"
        };
    }
    return null;
}

/**
 * Parses an email text body for Solarman alarm details.
 * @param {string} emailText The plain text content of the email.
 * @param {Date} emailReceivedAt The timestamp when the email was received (to calculate eventTimeStr).
 * @returns {object|null} An object with extracted alarm details or null if no match.
 */
function parseSolarmanEmail(emailText, emailReceivedAt) { // Adicionando emailReceivedAt
    // Regex para extrair eventDescription e plantName da primeira linha
    const firstLineRegex = /There is an alert named ([^\s]+ [^\s]+) in ([^\.]+)\./;
    const firstLineMatch = emailText.match(firstLineRegex);

    // Regex para extrair inverterId
    const inverterIdRegex = /Device:Inverter (\d+)/;
    const inverterIdMatch = emailText.match(inverterIdRegex);

    if (firstLineMatch && inverterIdMatch) {
        const eventDescription = firstLineMatch[1].trim();
        const plantName = firstLineMatch[2].trim();
        const inverterId = inverterIdMatch[1].trim();

        // Calcular eventTimeStr como 15 minutos antes do emailReceivedAt
        const eventTime = new Date(emailReceivedAt.getTime() - 15 * 60 * 1000);
        const eventTimeStr = eventTime.toISOString().replace(/T/, ' ').replace(/\.\d{3}Z$/, ''); // Formato YYYY-MM-DD HH:mm:ss

        return {
            inverterId: inverterId,
            plantName: plantName,
            eventTimeStr: eventTimeStr, // Já ajustado para 15 minutos antes
            eventDescription: eventDescription,
            alarmType: "SOLARMAN-EMAIL-EVENT",
            severity: "CRITICAL" // Conforme sua definição
        };
    }
    return null;
}

module.exports = {
    parseGrowattEmail,
    parseSolarmanEmail,
};
