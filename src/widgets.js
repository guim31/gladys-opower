// -----------------------------------------------------------------------------
// The dashboard widget "Energy summary": the last complete day, the current
// month and the bill forecast of one meter, with the last 14 days as bars.
//
// Built from what the last cycle read (no sign-in per display), localized
// from the widget's language. Core budget: 8 components, 6 tiles, 2 texts,
// 1 status list, 1 focal (the chart). The values are plain tiles (not bound
// to a feature): the widget works before the meter is added to Gladys, and
// the integration asks for a refresh after every cycle.
// -----------------------------------------------------------------------------

import {
  WIDGET_CHART_TYPES,
  WIDGET_COLORS,
  WIDGET_TEXT_VARIANTS,
} from '@gladysassistant/integration-sdk';
import { startOfLocalDay } from './time.js';

// The data moves twice a day: an hour of cache is plenty.
const TTL_SECONDS = 3600;

export const WIDGET_TEXT = {
  en: {
    lastDay: 'Last day',
    month: 'This month',
    monthCost: 'Month cost',
    forecast: 'Bill forecast',
    dayCost: 'Last day cost',
    forecastUsage: 'Forecast usage',
    typical: 'Same period last year',
    period: 'Billing period',
    chart: 'Last days',
    dataUntil: (date) => `Data up to ${date} (utilities publish a day or two late)`,
    notConfigured: 'Configure the Opower integration: utility, username and password.',
    code: 'The utility asks for a verification code: enter it in Integrations → Opower.',
    password: 'The utility refused the sign-in: check the integration configuration.',
    noData: 'No reading yet: the first one comes after the sign-in.',
  },
  fr: {
    lastDay: 'Dernier jour',
    month: 'Ce mois-ci',
    monthCost: 'Coût du mois',
    forecast: 'Facture prévue',
    dayCost: 'Coût du dernier jour',
    forecastUsage: 'Consommation prévue',
    typical: 'Même période l’an dernier',
    period: 'Période de facturation',
    chart: 'Derniers jours',
    dataUntil: (date) => `Données jusqu’au ${date} (publiées avec un ou deux jours de retard)`,
    notConfigured: 'Configurez l’intégration Opower : fournisseur, identifiant et mot de passe.',
    code: 'Le fournisseur demande un code de vérification : saisissez-le dans Intégrations → Opower.',
    password: 'Le fournisseur refuse la connexion : vérifiez la configuration de l’intégration.',
    noData: 'Aucune donnée pour l’instant : la première arrive après la connexion.',
  },
  de: {
    lastDay: 'Letzter Tag',
    month: 'Dieser Monat',
    monthCost: 'Kosten Monat',
    forecast: 'Rechnungsprognose',
    dayCost: 'Kosten letzter Tag',
    forecastUsage: 'Prognose Verbrauch',
    typical: 'Gleicher Zeitraum Vorjahr',
    period: 'Abrechnungszeitraum',
    chart: 'Letzte Tage',
    dataUntil: (date) => `Daten bis ${date} (Versorger liefern ein bis zwei Tage später)`,
    notConfigured: 'Richte die Opower-Integration ein: Versorger, Benutzername und Passwort.',
    code: 'Der Versorger verlangt einen Bestätigungscode: gib ihn unter Integrationen → Opower ein.',
    password: 'Der Versorger lehnt die Anmeldung ab: prüfe die Konfiguration der Integration.',
    noData: 'Noch keine Daten: die ersten kommen nach der Anmeldung.',
  },
  es: {
    lastDay: 'Último día',
    month: 'Este mes',
    monthCost: 'Coste del mes',
    forecast: 'Factura prevista',
    dayCost: 'Coste del último día',
    forecastUsage: 'Consumo previsto',
    typical: 'Mismo periodo del año pasado',
    period: 'Periodo de facturación',
    chart: 'Últimos días',
    dataUntil: (date) => `Datos hasta el ${date} (se publican con uno o dos días de retraso)`,
    notConfigured: 'Configure la integración Opower: compañía, usuario y contraseña.',
    code: 'La compañía pide un código de verificación: introdúzcalo en Integraciones → Opower.',
    password:
      'La compañía rechaza el inicio de sesión: compruebe la configuración de la integración.',
    noData: 'Aún no hay datos: los primeros llegan tras iniciar sesión.',
  },
};

const LOCALES = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

/** "Oct 12" / "12 oct." for a YYYY-MM-DD date. */
export function formatDay(date, language) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(LOCALES[language] ?? 'en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function message(text) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.BODY, text }],
  };
}

/**
 * @param {object} input
 * @param {object|null} input.meter a meter of the last cycle (src/app.js)
 * @param {string} input.language
 * @param {boolean} input.configured
 * @param {'code'|'password'|null} input.signInProblem
 * @param {string} input.timezone the utility's zone (the chart's days)
 */
export function buildWidgetContent({ meter, language, configured, signInProblem, timezone }) {
  const t = WIDGET_TEXT[language] ?? WIDGET_TEXT.en;
  if (!configured) {
    return message(t.notConfigured);
  }
  if (signInProblem === 'code' || signInProblem === 'password') {
    return message(t[signInProblem]);
  }
  if (!meter || !meter.summary?.lastDay) {
    return message(t.noData);
  }
  const { lastDay, month, forecast, recent } = meter.summary;
  const unit = meter.account.meterType === 'GAS' ? 'm³' : 'kWh';
  const components = [
    {
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      text: t.dataUntil(formatDay(lastDay.date, language)),
    },
    {
      type: 'value',
      label: `${t.lastDay} (${formatDay(lastDay.date, language)})`,
      value: lastDay.usage,
      unit,
      icon: 'zap',
    },
    { type: 'value', label: t.month, value: month.usage, unit, icon: 'calendar' },
  ];
  if (month.cost !== null) {
    components.push({
      type: 'value',
      label: t.monthCost,
      value: month.cost,
      unit: '$',
      icon: 'dollar-sign',
    });
  }
  if (forecast?.cost !== null && forecast?.cost !== undefined) {
    const above = forecast.typicalCost !== null && forecast.cost > forecast.typicalCost;
    components.push({
      type: 'value',
      label: t.forecast,
      value: forecast.cost,
      unit: '$',
      icon: 'file-text',
      color: above ? WIDGET_COLORS.WARNING : WIDGET_COLORS.PRIMARY,
    });
  }
  if (recent.length >= 2) {
    components.push({
      type: 'chart',
      chart_type: WIDGET_CHART_TYPES.BAR,
      title: t.chart,
      unit,
      series: [
        {
          name: unit,
          points: recent.map((day) => ({
            t: new Date(startOfLocalDay(day.date, timezone)).toISOString(),
            v: day.usage,
          })),
        },
      ],
    });
  }
  const items = [];
  if (lastDay.cost !== null) {
    items.push({ label: t.dayCost, value: `$${lastDay.cost.toFixed(2)}` });
  }
  if (forecast?.usage !== null && forecast?.usage !== undefined) {
    items.push({ label: t.forecastUsage, value: `${forecast.usage} ${unit}` });
  }
  if (forecast?.typicalCost !== null && forecast?.typicalCost !== undefined) {
    items.push({ label: t.typical, value: `$${forecast.typicalCost.toFixed(2)}` });
  }
  if (forecast?.startDate && forecast?.endDate) {
    items.push({
      label: t.period,
      value: `${formatDay(forecast.startDate, language)} – ${formatDay(forecast.endDate, language)}`,
    });
  }
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  return { ttl_seconds: TTL_SECONDS, components };
}
