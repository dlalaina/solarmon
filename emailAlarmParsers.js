// emailAlarmParsers.js
const { getFormattedTimestamp } = require('./utils');

/**
 * Parses an email HTML body for Growatt alarm details.
 * @param {string} emailHtml The HTML content of the email.
 * @returns {object|null} An object with extracted alarm details or null if no match.
 */
function parseGrowattEmail(emailHtml) {
    // Regexes para extrair os dados da estrutura de tabela HTML
    // Eles buscam a tag <td> com o rótulo e em seguida a próxima <td> com o valor.
    const inverterIdRegex = /Device serial number:<\/td><td>(\w+)<\/td>/;
    const plantNameRegex = /Plant name:<\/td><td>([^<]+)<\/td>/;
    const eventTimeRegex = /Time:<\/td><td>(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/td>/;
    const eventDescriptionRegex = /Event description:<\/td><td>([^<]+)<\/td>/;

    const inverterIdMatch = emailHtml.match(inverterIdRegex);
    const plantNameMatch = emailHtml.match(plantNameRegex);
    const eventTimeMatch = emailHtml.match(eventTimeRegex);
    const eventDescriptionMatch = emailHtml.match(eventDescriptionRegex);

    if (inverterIdMatch && plantNameMatch && eventTimeMatch && eventDescriptionMatch) {
        // Extrai os valores do segundo grupo de captura de cada regex
        const inverterId = inverterIdMatch[1].trim();
        const plantName = plantNameMatch[1].trim();
        const eventTimeStr = eventTimeMatch[1].trim();
        const eventDescription = eventDescriptionMatch[1].trim();

        let alarmType = "GROWATT-EMAIL-EVENT";
        let severity = "critical"; // Default para "critical" ou outra lógica se desejar

        // Exemplo de lógica para determinar a severidade ou tipo com base na descrição
        // Você pode expandir isso conforme necessário para mapear eventos específicos para severidades.
        if (eventDescription.includes("Outrange") || eventDescription.includes("Fault")) {
            severity = "high";
        } else if (eventDescription.includes("Warning")) {
            severity = "medium";
        }
        // ... adicione mais regras se necessário

        return {
            inverterId: inverterId,
            plantName: plantName,
            eventTimeStr: eventTimeStr,
            eventDescription: eventDescription,
            alarmType: alarmType,
            severity: severity
        };
    }
    console.warn(`[${getFormattedTimestamp()}] WARN: Não foi possível extrair todos os detalhes do alarme Growatt do HTML. Verifique o formato do e-mail.`);
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

