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
  return warnings;
}
