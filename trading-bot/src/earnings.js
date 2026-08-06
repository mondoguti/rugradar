// Best-effort earnings-date lookup. Holding long premium through an earnings
// announcement is an IV-crush trap — you pay peak implied volatility for a
// move everyone already expects, and the vol collapse after the print eats
// the P&L even when the direction is right. Tickets whose expiry spans a
// known earnings date get skipped; unknown dates get a loud warning so the
// human (or Claude via /bot-scan) verifies manually.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFixtures } from './marketdata.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, 'data', 'cache');
const TTL_MS = 24 * 3600 * 1000; // earnings dates don't move intraday

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

async function tryJson(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Returns 'YYYY-MM-DD' of the next earnings date, or null when unknown.
export async function getEarningsDate(symbol) {
  if (useFixtures()) return null;

  const cacheFile = path.join(CACHE, `earnings-${symbol}.json`);
  try {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < TTL_MS) return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).date;
  } catch { /* cache miss */ }

  let date = null;
  for (const host of ['query1', 'query2']) {
    const j = await tryJson(
      `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`
    );
    // Take the earliest UPCOMING date — the feed sometimes leads with a past
    // quarter, and a stale date must never masquerade as the next one.
    const arr = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate ?? [];
    const cutoff = Date.now() / 1000 - 86400; // tolerate same-day
    const raw = arr
      .map((e) => e?.raw)
      .filter((r) => typeof r === 'number')
      .sort((a, b) => a - b)
      .find((r) => r >= cutoff);
    if (raw) { date = new Date(raw * 1000).toISOString().slice(0, 10); break; }
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ date, fetchedAt: new Date().toISOString() }));
  return date;
}

// Policy check for a ticket: earnings strictly before expiry is a hard skip;
// unknown earnings is a warning, not a block (free feeds are flaky — the
// /bot-scan flow has Claude double-check dates before execution).
export async function earningsCheck(ticket) {
  const date = await getEarningsDate(ticket.symbol);
  const today = new Date().toISOString().slice(0, 10);
  const expiry = ticket.legs?.[0]?.expiry;
  // A past or missing date is the same thing: we do NOT know the next
  // earnings date — warn, never wave through.
  if (!date || date < today) {
    return { block: false, date: null, warning: 'earnings date unknown — VERIFY manually before executing (no long premium through earnings)' };
  }
  if (expiry && date <= expiry) {
    return { block: true, date, reason: `earnings ${date} lands before expiry ${expiry} — long premium through earnings gets IV-crushed` };
  }
  return { block: false, date };
}
