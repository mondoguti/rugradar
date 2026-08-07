// Hardcoded 2026 US macro-event calendar. Static, public, known-in-advance
// dates — the one kind of "data feed" that needs no network.
//
// VERIFIED 2026-08-06:
//   FOMC decision days = final day of each scheduled 2026 meeting
//     (Jan 27-28, Mar 17-18, Apr 28-29, Jun 16-17, Jul 28-29, Sep 15-16,
//      Oct 27-28, Dec 8-9), per federalreserve.gov/monetarypolicy/fomccalendars.htm.
//   CPI release days per BLS archive URLs (e.g. news.release/archives/cpi_07142026.htm)
//     and schedule mirrors; releases are 8:30am ET covering the prior month.
//
// CPI dates AFTER 2026-09-11 were NOT verifiable from sources reachable in
// this environment at implementation time and are deliberately ABSENT —
// daysToNext() returns null past coverage rather than guessing. A wrong date
// would tag the dataset with confident falsehoods, which is worse than none.
// coverageWarnings() nags until the calendar is verified and extended.

import { etDay } from './portfolio.js';

export const MACRO_2026 = {
  verifiedAt: '2026-08-06',
  sources: [
    'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    'https://www.bls.gov/schedule/news_release/cpi.htm (via dated archive URLs; gov pages blocked from this environment)',
  ],
  fomc: ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'],
  cpi: ['2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11'],
};

// 2026 US market holidays (NYSE full closures), for trading-day arithmetic.
// Verified against the published NYSE calendar at implementation time.
export const MARKET_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);
const HOLIDAY_COVERAGE_END = '2026-12-31';

const isTradingDay = (isoDay) => {
  const dow = new Date(`${isoDay}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5 && !MARKET_HOLIDAYS_2026.has(isoDay);
};

// Trading days in (fromEtDay, toEtDay]: same day -> 0, next business day -> 1.
// Beyond holiday coverage, non-listed weekdays count as trading days (the
// conservative direction for PDT: counting more days keeps trades in the
// window LONGER, never releasing a day trade early).
export function tradingDaysBetween(fromEtDay, toEtDay) {
  if (toEtDay <= fromEtDay) return 0;
  let count = 0;
  const d = new Date(`${fromEtDay}T12:00:00Z`);
  const end = new Date(`${toEtDay}T12:00:00Z`);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isTradingDay(d.toISOString().slice(0, 10))) count++;
  }
  return count;
}

// Next event of a type on/after `from` — {date, days} or null past coverage.
export function nextEvent(type, from = etDay()) {
  const next = (MACRO_2026[type] ?? []).find((d) => d >= from);
  if (!next) return null; // past verified coverage: never guess
  return { date: next, days: Math.round((new Date(next) - new Date(from)) / 86400000) };
}

export function daysToNext(type, from = etDay()) {
  return nextEvent(type, from)?.days ?? null;
}

export function eventsBetween(type, startDate, endDate) {
  return (MACRO_2026[type] ?? []).filter((d) => d >= startDate && d <= endDate);
}

// Nag while the verified calendar nears exhaustion so the refresh is a
// deliberate, sourced act — not a silent lapse into untagged data.
export function coverageWarnings(from = etDay()) {
  const warnings = [];
  for (const type of ['fomc', 'cpi']) {
    const dates = MACRO_2026[type];
    const last = dates[dates.length - 1];
    const daysLeft = Math.round((new Date(last) - new Date(from)) / 86400000);
    if (daysLeft <= 60) {
      warnings.push(`macro calendar: ${type.toUpperCase()} coverage ends ${last} (${daysLeft}d away) — verify the next dates against the primary source and extend MACRO_2026 in src/calendar.js`);
    }
  }
  const holidayDaysLeft = Math.round((new Date(HOLIDAY_COVERAGE_END) - new Date(from)) / 86400000);
  if (holidayDaysLeft <= 60) {
    warnings.push(`market-holiday calendar ends ${HOLIDAY_COVERAGE_END} (${holidayDaysLeft}d away) — add the next year's NYSE holidays to MARKET_HOLIDAYS in src/calendar.js`);
  }
  return warnings;
}
