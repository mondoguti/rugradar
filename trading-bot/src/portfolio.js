// Portfolio state persistence: trading-bot/data/portfolio.json
// Tracks cash, open positions, closed trades, and day-trade history (PDT).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
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
  return p;
}

export function savePortfolio(p) {
  atomicWrite(FILE, JSON.stringify(p, null, 2));
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
