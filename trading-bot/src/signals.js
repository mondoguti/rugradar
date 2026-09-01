// Pre-registered signal evaluator. Reads data/pre-registrations.json (append-
// only rulebook), joins the IV journal with forward outcomes, and reports each
// rule's statistic as PASS / FAIL / INSUFFICIENT_DATA.
//
// This module ONLY reads and reports. It never writes config, never gates a
// trade, and never re-tunes anything: activation of a passing rule requires a
// HUMAN commit flipping a named config flag and citing the rule id. That
// protocol — journal first, pre-registered forward test, human activation —
// is what keeps new signals from becoming new overfitting.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { loadJournal, loadOutcomes } from './journal.js';
import { MACRO_2026 } from './calendar.js';

const MACRO_FOMC = MACRO_2026.fomc;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RULES_FILE = path.join(ROOT, 'data', 'pre-registrations.json');

export function loadRules() {
  try {
    const r = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}

// Join journal rows to their forward outcomes (only rows whose future has
// been written and labeled).
export function joinedRows() {
  const outcomes = new Map(loadOutcomes().map((o) => [`${o.date}|${o.symbol}`, o]));
  return loadJournal()
    .map((r) => ({ ...r, out: outcomes.get(`${r.date}|${r.symbol}`) }))
    .filter((r) => r.out);
}

const spanDaysOf = (rows) => rows.length
  ? Math.round((new Date(rows[rows.length - 1].date) - new Date(rows[0].date)) / 86400000)
  : 0;

// Mean fwd-return difference, top tercile minus bottom tercile, in % points.
function tercileDiff(rows) {
  const sorted = [...rows].sort((a, b) => a.v - b.v);
  const k = Math.floor(sorted.length / 3);
  if (k < 1) return null;
  const mean = (arr) => arr.reduce((a, r) => a + r.y, 0) / arr.length;
  return (mean(sorted.slice(-k)) - mean(sorted.slice(0, k))) * 100;
}

function evalTercile(rule, joined) {
  let rows = joined.filter((r) => r.out[rule.horizon] != null);
  if (rule.conditionedOn?.partialDay) rows = rows.filter((r) => r.partialDay === true);
  const fieldVal = (r) => rule.field === 'osRatio'
    ? (r.optDollarVol != null && r.adv20 > 0 ? r.optDollarVol / r.adv20 : null)
    : r[rule.field];
  rows = rows
    .map((r) => ({ v: fieldVal(r), y: r.out[rule.horizon], date: r.date }))
    .filter((r) => r.v != null && Number.isFinite(r.v));
  const n = rows.length;
  const spanDays = spanDaysOf(rows);
  if (n < rule.minRows || spanDays < rule.minCalendarDays) {
    return {
      id: rule.id, n, spanDays, status: 'INSUFFICIENT_DATA',
      detail: `need >=${rule.minRows} rows over >=${rule.minCalendarDays}d (have ${n} over ${spanDays}d)`,
    };
  }
  const stat = tercileDiff(rows);
  const half = Math.floor(rows.length / 2);
  const s1 = tercileDiff(rows.slice(0, half));
  const s2 = tercileDiff(rows.slice(half));
  const wantNeg = rule.direction === 'top_below_bottom';
  const passMag = wantNeg ? stat <= -rule.thresholdPct : stat >= rule.thresholdPct;
  const stable = s1 != null && s2 != null && Math.sign(s1) === Math.sign(s2) && Math.sign(s1) === Math.sign(stat);
  return {
    id: rule.id, n, spanDays,
    statistic: +stat.toFixed(3), halves: [+s1.toFixed(3), +s2.toFixed(3)],
    status: passMag && stable ? 'PASS' : 'FAIL',
    detail: `top-bottom tercile mean ${rule.horizon}: ${stat.toFixed(3)}pp (halves ${s1.toFixed(2)} / ${s2.toFixed(2)}; need ${wantNeg ? '<= -' : '>= '}${rule.thresholdPct}pp, sign-stable)`,
  };
}

// Per-symbol median VRP (atmIV - rv21) over joined rows.
export function vrpBySymbol(joined, minRows = 1) {
  const bySym = new Map();
  for (const r of joined) {
    if (r.atmIV == null || r.out.rv21 == null) continue;
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r.atmIV - r.out.rv21);
  }
  const out = [];
  for (const [symbol, vals] of bySym) {
    if (vals.length < minRows) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    out.push({ symbol, n: vals.length, medianVrp: +median.toFixed(4) });
  }
  return out.sort((a, b) => b.medianVrp - a.medianVrp);
}

function evalVrpCreditJoin(rule, joined, portfolio) {
  const creditTrades = (portfolio?.closed ?? []).filter((t) => (t.structure || '').includes('credit'));
  const vrp = vrpBySymbol(joined, rule.minJoinedRowsPerSymbol);
  if (creditTrades.length < rule.minClosedCreditTrades || vrp.length === 0) {
    return {
      id: rule.id, n: joined.length, status: 'INSUFFICIENT_DATA',
      detail: `${creditTrades.length}/${rule.minClosedCreditTrades} closed credit trades; ${vrp.length} symbol(s) with >=${rule.minJoinedRowsPerSymbol} VRP observations`,
    };
  }
  const sign = new Map(vrp.map((v) => [v.symbol, v.medianVrp >= 0 ? 'pos' : 'neg']));
  const pf = (trades) => {
    const gw = trades.filter((t) => t.realizedPnl > 0).reduce((a, t) => a + t.realizedPnl, 0);
    const gl = Math.abs(trades.filter((t) => t.realizedPnl <= 0).reduce((a, t) => a + t.realizedPnl, 0));
    return gl > 0 ? gw / gl : null;
  };
  const pos = creditTrades.filter((t) => sign.get(t.symbol) === 'pos');
  const neg = creditTrades.filter((t) => sign.get(t.symbol) === 'neg');
  const pfPos = pf(pos), pfNeg = pf(neg);
  if (pfPos == null || pfNeg == null || !pos.length || !neg.length) {
    return {
      id: rule.id, n: creditTrades.length, status: 'INSUFFICIENT_DATA',
      detail: `need closed credit trades in BOTH VRP groups (pos: ${pos.length}, neg: ${neg.length})`,
    };
  }
  const gap = pfPos - pfNeg;
  return {
    id: rule.id, n: creditTrades.length, statistic: +gap.toFixed(2),
    status: gap >= rule.pfGap ? 'PASS' : 'FAIL',
    detail: `PF positive-VRP ${pfPos.toFixed(2)} vs negative-VRP ${pfNeg.toFixed(2)} (need gap >= ${rule.pfGap})`,
  };
}

// Split closed trades by a boolean field and compare profit factors.
function evalClosedTradeSplit(rule, portfolio) {
  let trades = (portfolio?.closed ?? []);
  if (rule.structureFilter) trades = trades.filter((t) => (t.structure || '').includes(rule.structureFilter));
  const flagOf = (t) => {
    if (rule.splitField === 'openedOnFomcDay') {
      const opened = (t.openedAt || '').slice(0, 10);
      return MACRO_FOMC.includes(opened);
    }
    // dotted path lookup, e.g. 'macro.fomcBeforeExpiry'
    return rule.splitField.split('.').reduce((o, k) => o?.[k], t) === true;
  };
  const inGroup = trades.filter(flagOf);
  const outGroup = trades.filter((t) => !flagOf(t));
  if (trades.length < rule.minClosedTrades || inGroup.length < rule.minTradesInSplitGroup || !outGroup.length) {
    return {
      id: rule.id, n: trades.length, status: 'INSUFFICIENT_DATA',
      detail: `${trades.length}/${rule.minClosedTrades} qualifying closed trades; ${inGroup.length}/${rule.minTradesInSplitGroup} in the split group`,
    };
  }
  const pf = (arr) => {
    const gw = arr.filter((t) => t.realizedPnl > 0).reduce((a, t) => a + t.realizedPnl, 0);
    const gl = Math.abs(arr.filter((t) => t.realizedPnl <= 0).reduce((a, t) => a + t.realizedPnl, 0));
    return gl > 0 ? gw / gl : null;
  };
  const pfIn = pf(inGroup), pfOut = pf(outGroup);
  if (pfIn == null || pfOut == null) {
    return { id: rule.id, n: trades.length, status: 'INSUFFICIENT_DATA', detail: 'a split group has no losses yet — PF undefined' };
  }
  const gap = pfOut - pfIn;
  return {
    id: rule.id, n: trades.length, statistic: +gap.toFixed(2),
    status: gap >= rule.pfGap ? 'PASS' : 'FAIL',
    detail: `PF outside-event ${pfOut.toFixed(2)} vs spanning-event ${pfIn.toFixed(2)} (need gap >= ${rule.pfGap})`,
  };
}

function evalParkinsonDisagreement(rule, joined) {
  const { rich, cheap } = config.entries.ivRegime;
  const cls = (iv, hv) => { const x = iv / hv; return x >= rich ? 'rich' : x <= cheap ? 'cheap' : 'normal'; };
  const rows = joined.filter((r) => r.hvP20 > 0 && r.hv20 > 0 && r.atmIV > 0 && r.out.rv21 != null);
  const spanDays = spanDaysOf(rows);
  if (rows.length < rule.minRows || spanDays < rule.minCalendarDays) {
    return {
      id: rule.id, n: rows.length, spanDays, status: 'INSUFFICIENT_DATA',
      detail: `need >=${rule.minRows} rows over >=${rule.minCalendarDays}d (have ${rows.length} over ${spanDays}d)`,
    };
  }
  const dis = rows.filter((r) => cls(r.atmIV, r.hv20) !== cls(r.atmIV, r.hvP20));
  const disPct = dis.length / rows.length;
  // Among disagreements where Parkinson takes a side, does the realized VRP
  // sign back the Parkinson classification? (rich => positive VRP expected)
  const judged = dis.filter((r) => cls(r.atmIV, r.hvP20) !== 'normal');
  const agree = judged.filter((r) => {
    const vrp = r.atmIV - r.out.rv21;
    return cls(r.atmIV, r.hvP20) === 'rich' ? vrp > 0 : vrp < 0;
  });
  const agreePct = judged.length ? agree.length / judged.length : 0;
  return {
    id: rule.id, n: rows.length,
    statistic: +(agreePct * 100).toFixed(1),
    status: disPct >= rule.minDisagreementPct && agreePct >= rule.minAgreementPct ? 'PASS' : 'FAIL',
    detail: `disagreement ${(disPct * 100).toFixed(1)}% (need >=${rule.minDisagreementPct * 100}%); VRP backs Parkinson in ${(agreePct * 100).toFixed(1)}% of ${judged.length} judged rows (need >=${rule.minAgreementPct * 100}%)`,
  };
}

export function evaluateRules(portfolio) {
  const rules = loadRules();
  const joined = joinedRows();
  const results = rules.map((rule) => {
    if (rule.status === 'withdrawn') return { id: rule.id, status: 'WITHDRAWN', detail: 'rule withdrawn — kept for the record' };
    if (rule.kind === 'risk-overlay') return { id: rule.id, status: 'ACTIVE_OVERLAY', detail: `${rule.justification} (numbers: ${JSON.stringify(rule.numbers)})` };
    try {
      if (rule.test === 'tercile_mean_diff') return evalTercile(rule, joined);
      if (rule.test === 'vrp_credit_join') return evalVrpCreditJoin(rule, joined, portfolio);
      if (rule.test === 'parkinson_disagreement') return evalParkinsonDisagreement(rule, joined);
      if (rule.test === 'closed_trade_split') return evalClosedTradeSplit(rule, portfolio);
      if (rule.test === 'manual_review') {
        return { id: rule.id, status: 'INSUFFICIENT_DATA', detail: `owner-review rule — evidence required: ${rule.evidenceRequired}` };
      }
      return { id: rule.id, status: 'UNKNOWN_TEST', detail: `unrecognized test '${rule.test}'` };
    } catch (e) {
      return { id: rule.id, status: 'ERROR', detail: e.message };
    }
  });
  return { results, joinedCount: joined.length, journalCount: loadJournal().length };
}
