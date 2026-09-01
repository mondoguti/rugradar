// Daily options-surface journal (v2). Free feeds carry no IV history, so the
// bot builds its own proprietary dataset: every scan snapshots the vol surface
// (ATM IV near/far, 25-delta skew), realized-vol estimators, and unsigned flow
// proxies per symbol into data/iv-history.jsonl.
//
// DISCIPLINE: these fields are JOURNALED ONLY. Nothing here feeds entry logic
// until a pre-registered rule (data/pre-registrations.json) passes on FORWARD
// data and a human commit flips a named config flag citing the rule id.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { atmIV } from './scanner.js';
import { liquid, pickExpiry } from './strategies.js';
import { getDailyHistory, getDailyHistoryMeta, useFixtures } from './marketdata.js';
import { historicalVol } from './indicators.js';
import { daysToNext, tradingDaysBetween, isTradingDay } from './calendar.js';
import { etDay } from './portfolio.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, useFixtures() ? 'data-fixtures' : 'data'); // fixture runs get their own world
const JOURNAL_FILE = path.join(DATA_DIR, 'iv-history.jsonl');
const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.jsonl');

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; } // skip a crash-truncated line
    }).filter(Boolean);
  } catch { return []; }
}

export const loadJournal = () => readJsonl(JOURNAL_FILE);
export const loadOutcomes = () => readJsonl(OUTCOMES_FILE);

// Label journal rows with forward outcomes once enough future bars exist:
// fwdRet5/10/21 (close-to-close) and rv21 — the realized vol over the 21 bars
// AFTER the row's date, i.e. the number every VRP claim is judged against.
// The raw journal is NEVER rewritten; outcomes live in their own append-only
// file, deduped by date|symbol. Bounded like every best-effort pass: history
// for symbols scanned this run is a cache hit (zero network); at most 10
// extra fetches for departed discovery names, 60s deadline, 3-miss abort.
// Forward labels for the row at bar index i, or null when the 21-bar future
// is not complete yet OR the series has a hole. Contiguity is checked with
// the trading-day calendar: bars[i+k] must be exactly k trading days after
// bars[i] for k = 5, 10, 21. A missing bar (feed gap, dropped null-close)
// would otherwise silently label the wrong horizon — permanently.
export function labelFromBars(bars, i) {
  if (i == null || i + 21 > bars.length - 1) return null;
  const d0 = bars[i].date;
  if (tradingDaysBetween(d0, bars[i + 5].date) !== 5 ||
      tradingDaysBetween(d0, bars[i + 10].date) !== 10 ||
      tradingDaysBetween(d0, bars[i + 21].date) !== 21) return null;
  const closes = bars.map((b) => b.close);
  if (!(closes[i] > 0) || [5, 10, 21].some((k) => !(closes[i + k] > 0))) return null;
  const fwd = (k) => +(closes[i + k] / closes[i] - 1).toFixed(4);
  const rv21 = historicalVol(closes.slice(i, i + 22), 21);
  return {
    fwdRet5: fwd(5), fwdRet10: fwd(10), fwdRet21: fwd(21),
    rv21: rv21 != null ? +rv21.toFixed(4) : null,
    barEnd: bars[i + 21].date,
  };
}

export async function backfillOutcomes(scannedSymbols = new Set()) {
  const journal = loadJournal();
  if (!journal.length) return { appended: 0 };
  const have = new Set(loadOutcomes().map((o) => `${o.date}|${o.symbol}`));
  const pending = journal.filter((r) => !have.has(`${r.date}|${r.symbol}`));
  if (!pending.length) return { appended: 0 };

  const bySymbol = new Map();
  for (const r of pending) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }

  const lines = [];
  const deadline = Date.now() + 60_000;
  // Rows so old that no 150-bar history window can ever reach them again get
  // a permanent tombstone — otherwise they sit in `pending` forever and drive
  // refetch churn on every scan.
  const tombstoneCutoff = new Date(Date.now() - 220 * 86400000).toISOString().slice(0, 10);
  const todayEt = etDay();
  let extraFetches = 0, misses = 0;
  for (const [symbol, rows] of bySymbol) {
    const live = [];
    for (const r of rows) {
      if (r.date < tombstoneCutoff) lines.push(JSON.stringify({ date: r.date, symbol, unlabelable: true, reason: 'older-than-history-window' }));
      else if (!isTradingDay(r.date)) lines.push(JSON.stringify({ date: r.date, symbol, unlabelable: true, reason: 'non-trading-day' }));
      else live.push(r);
    }
    if (!live.length) continue;
    if (Date.now() > deadline) break; // the wall clock bounds EVERY symbol, cache hit or not
    const isExtra = !scannedSymbols.has(symbol);
    if (isExtra && (extraFetches >= 10 || misses >= 3)) continue;
    let bars;
    try {
      if (isExtra) extraFetches++; // count the attempt, success or failure
      bars = await getDailyHistory(symbol);
      misses = 0;
    } catch { misses++; continue; }
    // Only a source that never drops bars may write permanent labels. The
    // Yahoo fallback skips null-close days, shifting array positions — a
    // delay costs nothing, a wrong label is forever. Leave the rows pending.
    const meta = getDailyHistoryMeta(symbol);
    if (meta?.source !== 'cboe' && meta?.source !== 'stooq') continue;
    // Today's bar is PARTIAL at the 10:50 ET scan — a label written from it
    // would be permanent fiction. Only completed sessions may label outcomes.
    bars = bars.filter((b) => b.date < todayEt);
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    for (const r of live) {
      const i = idx.get(r.date);
      if (i == null) continue;
      const label = labelFromBars(bars, i);
      if (!label) continue; // future not written yet, or a hole in the series
      lines.push(JSON.stringify({
        date: r.date, symbol, ...label,
        journalVersion: r.metricsVersion ?? 1,
        source: meta.source,
        adjusted: false, // split-adjusted, dividend-UNadjusted close-to-close
      }));
    }
  }
  if (lines.length) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(OUTCOMES_FILE, lines.join('\n') + '\n');
    } catch { return { appended: 0 }; }
  }
  return { appended: lines.length };
}

// The expiry atmIV anchors on: the nearest-to-30-DTE expiry among 15-60 DTE
// contracts with real IV. Mirrors atmIV's own selection.
export function anchorExpiry(chain) {
  const candidates = chain.contracts.filter((c) => c.iv > 0 && c.dte >= 15 && c.dte <= 60);
  if (!candidates.length) return null;
  const targetDte = candidates.reduce(
    (best, c) => (Math.abs(c.dte - 30) < Math.abs(best - 30) ? c.dte : best),
    candidates[0].dte
  );
  return candidates.find((c) => c.dte === targetDte)?.expiry ?? null;
}

// IV at |delta| = 0.25, linearly interpolated between the two contracts
// bracketing it. Junk-quote guards on BOTH bracket contracts: real bid, sane
// delta band, sane IV — delayed quotes on coarse-strike cheap names show
// absurd IVs, and a fabricated skew is worse than a null.
export function iv25(chain, type, expiry) {
  const pool = chain.contracts.filter((c) =>
    c.type === type && c.expiry === expiry && c.bid > 0 &&
    c.delta != null && Math.abs(c.delta) >= 0.10 && Math.abs(c.delta) <= 0.45 &&
    c.iv > 0 && c.iv < 5
  );
  const below = pool.filter((c) => Math.abs(c.delta) <= 0.25).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  const above = pool.filter((c) => Math.abs(c.delta) >= 0.25).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  if (!below || !above) return null;
  const dB = Math.abs(below.delta), dA = Math.abs(above.delta);
  if (dA === dB) return +((below.iv + above.iv) / 2).toFixed(4);
  const w = (0.25 - dB) / (dA - dB);
  return +(below.iv + w * (above.iv - below.iv)).toFixed(4);
}

// Unsigned flow proxies over the liquid (<=90 DTE) part of the chain. These
// are the WEAK versions of the literature signals (real ones need signed
// opening volume, which delayed feeds cannot provide) — journaled with
// partialDay so the evaluator judges them for what they are.
export function flowMetrics(chain) {
  let putVol = 0, callVol = 0, vol = 0, oi = 0, dollar = 0;
  for (const c of chain.contracts) {
    if (c.dte > 90) continue;
    const v = c.volume || 0;
    if (c.type === 'put') putVol += v; else callVol += v;
    vol += v;
    oi += c.openInterest || 0;
    if (c.mid != null) dollar += c.mid * v * 100;
  }
  return {
    pcVolRatio: callVol > 0 ? +(putVol / callVol).toFixed(3) : null,
    volOiRatio: oi > 0 ? +(vol / oi).toFixed(3) : null,
    optDollarVol: Math.round(dollar),
  };
}

// Frozen-gate evidence, measured daily from the chain we already hold (zero
// extra network). The throughput audit (2026-08-07) showed two frozen gates
// bind hardest: the $50 premium cap and the 25%-of-width credit floor. These
// fields are the FORWARD dataset any future pre-registered proposal about
// those gates will be judged against — telemetry only, never an input.
// v2 (2026-08-11): expiry selection and liquidity now REUSE the frozen
// builders' own pickExpiry/liquid (review found the v1 anchor-expiry variant
// flipped ~21% of floor verdicts vs what the route actually sees). A null
// means "the route could not even reach an expiry" — itself a signal, so the
// row is still recorded. metricsVersion on each row marks the change.
export function gateMetrics(chain) {
  const perType = (type) => {
    const pool = chain.contracts.filter((c) => c.type === type && liquid(c));
    // Cheapest liquid contract in buildLong's delta band at the long route's
    // own expiry — what the long route would have to afford.
    let cheapest = null;
    const longExpiry = pickExpiry(pool, config.entries.dte.long);
    if (longExpiry) {
      for (const c of pool) {
        if (c.expiry !== longExpiry || c.delta == null) continue;
        const d = Math.abs(c.delta);
        if (d < config.entries.delta.longMin || d > config.entries.delta.longEntry + 0.10) continue;
        const px = c.mid * 100;
        if (cheapest == null || px < cheapest) cheapest = px;
      }
    }
    // Best achievable credit fraction of width at the ~0.25-delta short with
    // a real liquid wing, at the credit route's own expiry — measures the
    // CHAIN, deliberately ignoring any budget.
    let frac = null;
    const credExpiry = pickExpiry(pool, config.entries.dte.creditSpread);
    if (credExpiry) {
      const atExpiry = pool.filter((c) => c.expiry === credExpiry && c.delta != null);
      const target = config.entries.delta.creditSell;
      const short = atExpiry.length
        ? atExpiry.reduce((b, c) => Math.abs(Math.abs(c.delta) - target) < Math.abs(Math.abs(b.delta) - target) ? c : b)
        : null;
      if (short && Math.abs(Math.abs(short.delta) - target) <= config.entries.delta.nearTolerance) {
        const otm = type === 'call' ? 1 : -1;
        for (const w of atExpiry) {
          const width = (w.strike - short.strike) * otm;
          if (width <= 0 || width > config.entries.maxSpreadWidth) continue;
          const f = (short.mid - w.mid) / width;
          if (Number.isFinite(f) && (frac == null || f > frac)) frac = f;
        }
      }
    }
    return { cheapest, frac };
  };
  const put = perType('put');
  const call = perType('call');
  return {
    cheapestDeltaBandPremiumCall: call.cheapest != null ? +call.cheapest.toFixed(2) : null,
    cheapestDeltaBandPremiumPut: put.cheapest != null ? +put.cheapest.toFixed(2) : null,
    bestCreditFracPut: put.frac != null ? +put.frac.toFixed(3) : null,
    bestCreditFracCall: call.frac != null ? +call.frac.toFixed(3) : null,
    metricsVersion: 2,
  };
}

// One journal row per symbol per market day. Key order matters: date-then-
// symbol first keeps the existing substring dedup key working on old and new
// rows alike. Nulls are recorded honestly — never interpolated fabrications.
export function buildJournalRow(s, chain, date) {
  const expiry = anchorExpiry(chain);
  const ivPut25 = expiry ? iv25(chain, 'put', expiry) : null;
  const ivCall25 = expiry ? iv25(chain, 'call', expiry) : null;
  const rr25 = ivPut25 != null && ivCall25 != null ? +(ivPut25 - ivCall25).toFixed(4) : null;
  const atmIvFar = atmIV(chain, [45, 90], 67.5);
  return {
    date,
    symbol: s.symbol,
    close: s.close,
    hv20: +s.hv20.toFixed(4),
    atmIV: +s.atmIV.toFixed(4),
    ivOverHv: +s.ivOverHv.toFixed(3),
    ivPut25,
    ivCall25,
    rr25,
    rr25Norm: rr25 != null && s.atmIV > 0 ? +(rr25 / s.atmIV).toFixed(3) : null,
    atmIvFar: atmIvFar != null ? +atmIvFar.toFixed(4) : null,
    termSlope: atmIvFar != null ? +(atmIvFar - s.atmIV).toFixed(4) : null,
    hvP20: s.hvP20 != null ? +s.hvP20.toFixed(4) : null,
    hv20Pctile: s.hv20Pctile ?? null,
    hvWindowBars: s.hvWindowBars ?? null,
    adv20: s.avgDollarVolume != null ? Math.round(s.avgDollarVolume) : null,
    ...flowMetrics(chain),
    ...gateMetrics(chain),
    dFomc: daysToNext('fomc', date),  // calendar days to next FOMC decision (null past verified coverage)
    dCpi: daysToNext('cpi', date),
    snapshot: 'open',
    partialDay: true, // ~10:50 ET snapshot holds ~80 min of session volume
  };
}
