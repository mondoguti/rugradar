// Portfolio state persistence: trading-bot/data/portfolio.json
// Tracks cash, open positions, closed trades, and day-trade history (PDT).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { useFixtures } from './marketdata.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Fixture runs live in a COMPLETELY separate state world: reads AND writes go
// to data-fixtures/ (gitignored), so a test can never touch the real record —
// and never half-touch it either (guarding only the writes would create
// mixed-state chimeras like fixture fills against real tickets).
const DATA_DIR = path.join(ROOT, useFixtures() ? 'data-fixtures' : 'data');
const FILE = path.join(DATA_DIR, 'portfolio.json');
const TICKETS = path.join(DATA_DIR, 'tickets.json');

// Atomic write: tmp file + rename, so a crash mid-write can never truncate
// the record (portfolio.json IS the forward record — the go-live judge).
function atomicWrite(file, content) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function loadPortfolio() {
  if (!fs.existsSync(FILE)) {
    return {
      createdAt: new Date().toISOString(),
      startingEquity: config.account.startingEquity,
      cash: config.account.startingEquity,
      positions: [],
      closed: [],
      dayTrades: [],
    };
  }
  // Fail CLOSED on corruption: throwing halts the run loudly. Silently
  // re-initializing would wipe the record, which is far worse than a
  // skipped cycle.
  let p;
  try {
    p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    throw new Error(`portfolio.json is corrupted (${e.message}) — refusing to trade; restore it from git history`);
  }
  if (!Number.isFinite(p.cash) || !Array.isArray(p.positions) || !Array.isArray(p.closed) || !Array.isArray(p.dayTrades)) {
    throw new Error('portfolio.json failed integrity checks (non-finite cash or missing arrays) — refusing to trade; restore from git history');
  }
  for (const pos of p.positions) {
    if (!Array.isArray(pos.legs) || !Number.isFinite(pos.entryValue)) {
      throw new Error(`portfolio.json position ${pos.id ?? '?'} is malformed — refusing to trade; restore from git history`);
    }
  }
  // Backfill for files created before the drawdown governor existed.
  if (!Number.isFinite(p.equityHighWater)) p.equityHighWater = p.startingEquity;
  if (!Number.isFinite(p.governorRung)) p.governorRung = 0;
  return p;
}

// Ratchet the equity high-water mark and step the drawdown governor.
// The high-water only advances when NO open position has a stale mark — a
// bad mark must never inflate the high-water and trip the governor early.
// The governor escalates immediately and releases only after near-full
// recovery (hysteresis), so a bounce off the lows doesn't re-risk instantly.
export function updateHighWater(p) {
  const g = config.risk.drawdownGovernor;
  const eq = equity(p);
  const marksClean = p.positions.every((pos) => !pos.markStale);
  if (marksClean && eq > p.equityHighWater) p.equityHighWater = +eq.toFixed(2);
  if (!g?.enabled) { p.governorRung = 0; return p; }
  const dd = 1 - eq / p.equityHighWater;
  let target = 0;
  for (let i = 0; i < g.rungs.length; i++) if (dd >= g.rungs[i].ddPct) target = i + 1;
  if (target > (p.governorRung || 0)) p.governorRung = target;          // escalate now
  else if ((p.governorRung || 0) > 0 && dd <= g.releaseAtRecoveryPct) p.governorRung = 0; // release on recovery
  return p;
}

export function savePortfolio(p) {
  atomicWrite(FILE, JSON.stringify(p, null, 2));
}

// Atomic JSON write for any state file (heartbeat, digests): the same
// tmp+rename guarantee portfolio.json gets.
export function writeJsonAtomic(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2));
}

// Ops run-ledger: one line per scheduled run (autopilot/manage), success or
// failure. This is what lets the dead-man check COUNT missed runs instead of
// inferring health from a single timestamp.
const OPS_LOG = path.join(DATA_DIR, 'ops-log.jsonl');
export function appendOpsLog(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(OPS_LOG, JSON.stringify(entry) + '\n');
  } catch { /* telemetry only */ }
}
export function readOpsLog() {
  try {
    return fs.readFileSync(OPS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; } // skip a corrupt (crash-truncated) line
    }).filter(Boolean);
  } catch { return []; }
}

// Execution-quality ledger: one line per fill event (open/close/expire) with
// per-leg quotes vs fill prices. This is the dataset that answers "what does
// execution actually cost us" and calibrates paper slippage against real
// fills at go-live. Append-only; a logging failure must never block a fill.
const EXEC_LOG = path.join(DATA_DIR, 'execution-log.jsonl');
export function appendExecLog(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(EXEC_LOG, JSON.stringify(entry) + '\n');
  } catch { /* telemetry only */ }
}

export function loadTickets() {
  if (!fs.existsSync(TICKETS)) return [];
  try {
    const t = JSON.parse(fs.readFileSync(TICKETS, 'utf8'));
    return Array.isArray(t) ? t : [];
  } catch {
    return []; // tickets are ephemeral — a corrupt file just means no pending tickets
  }
}

export function saveTickets(tickets) {
  atomicWrite(TICKETS, JSON.stringify(tickets, null, 2));
}

// Calendar day in US market time. PDT rules and "same day" logic must use
// Eastern time, not UTC — a close logged after 8pm ET would otherwise land on
// the wrong day and undercount day trades.
export function etDay(d = new Date()) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Equity = cash + current value of open positions (marked or at entry).
export function equity(p) {
  const open = p.positions.reduce((a, pos) => a + (pos.currentValue ?? pos.entryValue), 0);
  return p.cash + open;
}

export function realizedToday(p) {
  const today = etDay();
  return p.closed
    .filter((t) => t.closedAt && etDay(t.closedAt) === today)
    .reduce((a, t) => a + t.realizedPnl, 0);
}
