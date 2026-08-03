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
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

export function savePortfolio(p) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(p, null, 2));
}

export function loadTickets() {
  if (!fs.existsSync(TICKETS)) return [];
  return JSON.parse(fs.readFileSync(TICKETS, 'utf8'));
}

export function saveTickets(tickets) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TICKETS, JSON.stringify(tickets, null, 2));
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
