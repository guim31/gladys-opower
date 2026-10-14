// -----------------------------------------------------------------------------
// Every text the container produces, in the four languages of the Gladys
// interface: English, French, German (informal "du") and Spanish (formal
// "usted"). Gladys does not tell a device integration its user's language:
// the `language` field of the configuration picks it (French by default).
// The vocabulary follows the Gladys interface (front/src/config/i18n).
// Brand names (PG&E, ConEd...) are never translated.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** Feature names, fixed when the user adds the device. */
export const FEATURE_NAMES = {
  en: {
    consumption: 'Consumption',
    daily_consumption: 'Daily consumption',
    last_day_usage: 'Last day usage',
    last_day_cost: 'Last day cost',
    month_usage: 'Month usage',
    month_cost: 'Month cost',
    forecast_usage: 'Forecast usage (bill)',
    forecast_cost: 'Bill forecast',
  },
  fr: {
    consumption: 'Consommation',
    daily_consumption: 'Consommation journalière',
    last_day_usage: 'Consommation du dernier jour',
    last_day_cost: 'Coût du dernier jour',
    month_usage: 'Consommation du mois',
    month_cost: 'Coût du mois',
    forecast_usage: 'Consommation prévue (facture)',
    forecast_cost: 'Prévision de facture',
  },
  de: {
    consumption: 'Verbrauch',
    daily_consumption: 'Tagesverbrauch',
    last_day_usage: 'Verbrauch letzter Tag',
    last_day_cost: 'Kosten letzter Tag',
    month_usage: 'Verbrauch Monat',
    month_cost: 'Kosten Monat',
    forecast_usage: 'Prognose Verbrauch (Rechnung)',
    forecast_cost: 'Rechnungsprognose',
  },
  es: {
    consumption: 'Consumo',
    daily_consumption: 'Consumo diario',
    last_day_usage: 'Consumo del último día',
    last_day_cost: 'Coste del último día',
    month_usage: 'Consumo del mes',
    month_cost: 'Coste del mes',
    forecast_usage: 'Consumo previsto (factura)',
    forecast_cost: 'Previsión de factura',
  },
};

/** The kind of meter, in the device name. */
export const METER_NAMES = {
  en: { ELEC: 'Electricity', GAS: 'Gas' },
  fr: { ELEC: 'Électricité', GAS: 'Gaz' },
  de: { ELEC: 'Strom', GAS: 'Gas' },
  es: { ELEC: 'Electricidad', GAS: 'Gas' },
};

/**
 * Status and action messages: multi-language objects, or functions that
 * build one. Shown in the Configuration screen (200 characters at most).
 */
export const MESSAGES = {
  notConfigured: {
    en: 'Choose your utility and enter the username and password of your online account.',
    fr: 'Choisissez votre fournisseur et saisissez l’identifiant et le mot de passe de votre espace client.',
    de: 'Wähle deinen Versorger und gib Benutzername und Passwort deines Kundenkontos ein.',
    es: 'Elija su compañía e introduzca el usuario y la contraseña de su cuenta en línea.',
  },
  unsupportedUtility: {
    en: 'This utility is not supported yet. The documentation lists the supported ones.',
    fr: 'Ce fournisseur n’est pas encore pris en charge. La documentation liste ceux qui le sont.',
    de: 'Dieser Versorger wird noch nicht unterstützt. Die Dokumentation listet die unterstützten auf.',
    es: 'Esta compañía aún no es compatible. La documentación enumera las compatibles.',
  },
  invalidAuth: {
    en: 'The utility refused the sign-in: check the username, the password (and the authenticator key).',
    fr: 'Le fournisseur refuse la connexion : vérifiez l’identifiant, le mot de passe (et la clé d’authentification).',
    de: 'Der Versorger lehnt die Anmeldung ab: prüfe Benutzername, Passwort (und Authenticator-Schlüssel).',
    es: 'La compañía rechaza el inicio de sesión: compruebe el usuario, la contraseña (y la clave de autenticación).',
  },
  codeRequired: {
    en: 'Verification code required: use “Send the verification code”, then “Enter the code” below.',
    fr: 'Code de vérification requis : utilisez « Envoyer le code de vérification », puis « Saisir le code » ci-dessous.',
    de: 'Bestätigungscode nötig: nutze unten „Bestätigungscode senden“ und dann „Code eingeben“.',
    es: 'Se requiere un código: use «Enviar el código de verificación» y luego «Introducir el código» abajo.',
  },
  cannotConnect: (reason) => ({
    en: `Cannot reach the utility (${reason}). Retried automatically.`,
    fr: `Fournisseur injoignable (${reason}). Nouvel essai automatique.`,
    de: `Versorger nicht erreichbar (${reason}). Neuer Versuch automatisch.`,
    es: `No se puede contactar con la compañía (${reason}). Se reintentará automáticamente.`,
  }),
  noMeter: {
    en: 'Signed in, but the account has no electricity or gas meter that Opower serves.',
    fr: 'Connecté, mais le compte n’a aucun compteur d’électricité ou de gaz servi par Opower.',
    de: 'Angemeldet, aber das Konto hat keinen Strom- oder Gaszähler, den Opower liefert.',
    es: 'Sesión iniciada, pero la cuenta no tiene ningún contador de electricidad o gas servido por Opower.',
  },
  signedIn: (utility, meters) => ({
    en: `Signed in to ${utility}: ${meters} meter(s) found. Add them from the Discover tab.`,
    fr: `Connecté à ${utility} : ${meters} compteur(s) trouvé(s). Ajoutez-les depuis l’onglet Découverte.`,
    de: `Bei ${utility} angemeldet: ${meters} Zähler gefunden. Füge sie im Tab „Entdecken“ hinzu.`,
    es: `Sesión iniciada en ${utility}: ${meters} contador(es) encontrado(s). Añádalos desde la pestaña Descubrir.`,
  }),
  codeChoice: (options) => ({
    en: `Choose where to send the code: ${options}.`,
    fr: `Choisissez où envoyer le code : ${options}.`,
    de: `Wähle, wohin der Code geschickt wird: ${options}.`,
    es: `Elija dónde enviar el código: ${options}.`,
  }),
  codeSent: (target) => ({
    en: `Code sent to ${target}. Enter it with “Enter the code” within 10 minutes.`,
    fr: `Code envoyé à ${target}. Saisissez-le avec « Saisir le code » dans les 10 minutes.`,
    de: `Code an ${target} gesendet. Gib ihn innerhalb von 10 Minuten mit „Code eingeben“ ein.`,
    es: `Código enviado a ${target}. Introdúzcalo con «Introducir el código» en 10 minutos.`,
  }),
  codeAlreadySent: {
    en: 'The utility sends the code by itself: enter it with “Enter the code”.',
    fr: 'Le fournisseur envoie le code de lui-même : saisissez-le avec « Saisir le code ».',
    de: 'Der Versorger schickt den Code selbst: gib ihn mit „Code eingeben“ ein.',
    es: 'La compañía envía el código por sí misma: introdúzcalo con «Introducir el código».',
  },
  noCodeMethod: {
    en: 'This way of receiving the code is not offered for your account: choose the other one.',
    fr: 'Ce moyen de recevoir le code n’est pas proposé pour votre compte : choisissez l’autre.',
    de: 'Dieser Weg für den Code wird für dein Konto nicht angeboten: wähle den anderen.',
    es: 'Esta forma de recibir el código no está disponible para su cuenta: elija la otra.',
  },
  noPendingCode: {
    en: 'No verification code is expected right now: the sign-in does not ask for one.',
    fr: 'Aucun code de vérification n’est attendu : la connexion n’en demande pas.',
    de: 'Gerade wird kein Bestätigungscode erwartet: die Anmeldung verlangt keinen.',
    es: 'No se espera ningún código de verificación: el inicio de sesión no lo pide.',
  },
  codeExpired: {
    en: 'The code request expired: use “Send the verification code” again.',
    fr: 'La demande de code a expiré : utilisez de nouveau « Envoyer le code de vérification ».',
    de: 'Die Code-Anfrage ist abgelaufen: nutze erneut „Bestätigungscode senden“.',
    es: 'La solicitud de código caducó: use de nuevo «Enviar el código de verificación».',
  },
  codeRefused: {
    en: 'The utility refused this code. Check it, or send a new one.',
    fr: 'Le fournisseur refuse ce code. Vérifiez-le, ou demandez-en un nouveau.',
    de: 'Der Versorger lehnt diesen Code ab. Prüfe ihn oder fordere einen neuen an.',
    es: 'La compañía rechaza este código. Compruébelo o solicite uno nuevo.',
  },
  codeAccepted: {
    en: 'Code accepted: the integration is signed in and reads your data now.',
    fr: 'Code accepté : l’intégration est connectée et lit vos données.',
    de: 'Code akzeptiert: die Integration ist angemeldet und liest jetzt deine Daten.',
    es: 'Código aceptado: la integración ha iniciado sesión y lee sus datos ahora.',
  },
  codeNotNeeded: {
    en: 'This utility does not use a verification code sent by email or text.',
    fr: 'Ce fournisseur n’utilise pas de code envoyé par e-mail ou SMS.',
    de: 'Dieser Versorger nutzt keinen per E-Mail oder SMS gesendeten Code.',
    es: 'Esta compañía no usa un código enviado por correo electrónico o SMS.',
  },
  refreshed: (meters) => ({
    en: `Data refreshed: ${meters} meter(s) read.`,
    fr: `Données rafraîchies : ${meters} compteur(s) lu(s).`,
    de: `Daten aktualisiert: ${meters} Zähler gelesen.`,
    es: `Datos actualizados: ${meters} contador(es) leído(s).`,
  }),
  refreshTooSoon: (minutes) => ({
    en: `Already refreshed recently: try again in ${minutes} min (the utility publishes new data once a day).`,
    fr: `Déjà rafraîchi récemment : réessayez dans ${minutes} min (le fournisseur publie ses données une fois par jour).`,
    de: `Gerade erst aktualisiert: versuch es in ${minutes} Min. erneut (der Versorger liefert einmal täglich neue Daten).`,
    es: `Ya se actualizó hace poco: vuelva a intentarlo en ${minutes} min (la compañía publica datos una vez al día).`,
  }),
  failed: (reason) => ({
    en: `Failed: ${reason}`,
    fr: `Échec : ${reason}`,
    de: `Fehlgeschlagen: ${reason}`,
    es: `Error: ${reason}`,
  }),
  initFailed: {
    en: 'The integration could not start: see its logs.',
    fr: 'L’intégration n’a pas pu démarrer : consultez ses journaux.',
    de: 'Die Integration konnte nicht starten: sieh in ihre Logs.',
    es: 'La integración no pudo iniciarse: consulte sus registros.',
  },
};

/** The way a code travels, in the action messages. */
export const CODE_METHODS = {
  en: { email: 'email', sms: 'text message' },
  fr: { email: 'e-mail', sms: 'SMS' },
  de: { email: 'E-Mail', sms: 'SMS' },
  es: { email: 'correo electrónico', sms: 'SMS' },
};

/** The text of one language, English when missing. */
export function pick(texts, language) {
  return texts[language] ?? texts.en;
}
