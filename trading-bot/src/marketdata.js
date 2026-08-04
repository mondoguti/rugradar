// Market data layer. Free, keyless sources with fallbacks:
//   - Daily history:  Stooq CSV -> Yahoo v8 chart API
//   - Options chains: CBOE delayed quotes (includes real greeks) -> Yahoo v7 (greeks via Black-Scholes)
// Set BOT_FIXTURES=1 (or pass --fixtures) to read synthetic data from
// trading-bot/fixtures/ instead of the network — used for offline testing.
//
// Everything is normalized to:
//   history: [{date, open, high, low, close, volume}]
//   chain:   { symbol, spot, updatedAt, contracts: [{type, expiry, dte, strike,
//              bid, ask, mid, volume, openInterest, iv, delta}] }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bsDelta } from './bs.js';
import config from '../config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const CACHE_TTL_MS = 15 * 60 * 1000;

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };

// Yahoo rate-limits bursts, especially from datacenter IPs. Space requests
// ~1.2s apart and back off on 429/403 — slow and steady gets served.
let lastYahooAt = 0;
async function yahooJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = Math.max(0, lastYahooAt + 1200 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastYahooAt = Date.now();
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status === 403) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`yahoo rate-limited after retries: ${url}`);
}

export const useFixtures = () =>
  process.env.BOT_FIXTURES === '1' || process.argv.includes('--fixtures');

function cacheGet(key) {
  try {
    const f = path.join(CACHE_DIR, `${key}.json`);
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

function cacheSet(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---------- daily history ----------

// CBOE's chart CDN: daily OHLCV back to ~2004, datacenter-friendly, and the
// same host as our options chains. Primary source.
async function historyFromCboe(symbol) {
  const j = await fetchJson(`https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/${symbol}.json`);
  const rows = j?.data;
  if (!rows?.length) throw new Error(`cboe history: empty for ${symbol}`);
  return rows.map((r) => ({
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0,
  }));
}

async function historyFromStooq(symbol) {
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d`);
  const lines = csv.trim().split('\n');
  if (lines.length < 30 || !lines[0].startsWith('Date')) throw new Error(`stooq: bad payload for ${symbol}`);
  return lines.slice(1).map((l) => {
    const [date, open, high, low, close, volume] = l.split(',');
    return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume || 0 };
  });
}

async function historyFromYahoo(symbol, days) {
  const range = days > 400 ? '5y' : days > 200 ? '2y' : '1y';
  const j = await yahooJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`
  );
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`yahoo chart: no result for ${symbol}`);
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    out.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
      volume: q.volume[i] || 0,
    });
  }
  return out;
}

export async function getDailyHistory(symbol, days = config.data.historyDays) {
  if (useFixtures()) {
    const f = path.join(FIXTURES_DIR, `${symbol}.history.json`);
    if (!fs.existsSync(f)) throw new Error(`no fixture history for ${symbol} — run: node trading-bot/fixtures/generate.js`);
    return JSON.parse(fs.readFileSync(f, 'utf8')).slice(-days);
  }
  const cached = cacheGet(`hist-${symbol}-${days}`);
  if (cached) return cached;
  let bars;
  try {
    bars = await historyFromCboe(symbol);
  } catch {
    try {
      bars = await historyFromStooq(symbol);
    } catch {
      bars = await historyFromYahoo(symbol, days);
    }
  }
  bars = bars.slice(-days);
  cacheSet(`hist-${symbol}-${days}`, bars);
  return bars;
}

// ---------- options chains ----------

// OCC symbol: ROOT + YYMMDD + C/P + strike*1000 padded to 8, e.g. SPY261218C00500000
function parseOcc(occ, root) {
  const tail = occ.slice(root.length);
  const m = tail.match(/^(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, ymd, cp, strikeRaw] = m;
  return {
    expiry: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

function dteFrom(expiry) {
  return Math.max(0, Math.round((new Date(`${expiry}T21:00:00Z`) - Date.now()) / 86400000));
}

async function chainFromCboe(symbol) {
  const j = await fetchJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`);
  const d = j?.data;
  if (!d?.options?.length) throw new Error(`cboe: empty chain for ${symbol}`);
  const spot = d.current_price ?? d.close;
  const contracts = [];
  for (const o of d.options) {
    const parsed = parseOcc(o.option, symbol);
    if (!parsed) continue;
    const bid = o.bid ?? 0, ask = o.ask ?? 0;
    contracts.push({
      ...parsed,
      dte: dteFrom(parsed.expiry),
      bid, ask,
      mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
      volume: o.volume ?? 0,
      openInterest: o.open_interest ?? 0,
      iv: o.iv ?? null,
      delta: o.delta ?? null,
    });
  }
  return { symbol, spot, updatedAt: new Date().toISOString(), contracts };
}

async function chainFromYahoo(symbol) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}`;
  const first = await yahooJson(base);
  const res0 = first?.optionChain?.result?.[0];
  if (!res0) throw new Error(`yahoo options: no result for ${symbol}`);
  const spot = res0.quote?.regularMarketPrice;
  const expirations = (res0.expirationDates || []).slice(0, 8);
  const contracts = [];
  for (const ts of expirations) {
    const j = ts === expirations[0] ? first : await yahooJson(`${base}?date=${ts}`);
    const opt = j?.optionChain?.result?.[0]?.options?.[0];
    if (!opt) continue;
    for (const side of ['calls', 'puts']) {
      for (const c of opt[side] || []) {
        const expiry = new Date(c.expiration * 1000).toISOString().slice(0, 10);
        const dte = dteFrom(expiry);
        const type = side === 'calls' ? 'call' : 'put';
        const iv = c.impliedVolatility ?? null;
        const bid = c.bid ?? 0, ask = c.ask ?? 0;
        contracts.push({
          type, expiry, dte, strike: c.strike,
          bid, ask,
          mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
          volume: c.volume ?? 0,
          openInterest: c.openInterest ?? 0,
          iv,
          delta: bsDelta({ type, spot, strike: c.strike, dte, iv, r: config.data.riskFreeRate }),
        });
      }
    }
  }
  return { symbol, spot, updatedAt: new Date().toISOString(), contracts };
}

export async function getOptionsChain(symbol) {
  if (useFixtures()) {
    const f = path.join(FIXTURES_DIR, `${symbol}.chain.json`);
    if (!fs.existsSync(f)) throw new Error(`no fixture chain for ${symbol} — run: node trading-bot/fixtures/generate.js`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const cached = cacheGet(`chain-${symbol}`);
  if (cached) return cached;
  let chain;
  try {
    chain = await chainFromCboe(symbol);
  } catch {
    chain = await chainFromYahoo(symbol);
  }
  // Fill missing deltas via Black-Scholes so strike selection always works.
  for (const c of chain.contracts) {
    if (c.delta == null && c.iv) {
      c.delta = bsDelta({ type: c.type, spot: chain.spot, strike: c.strike, dte: c.dte, iv: c.iv, r: config.data.riskFreeRate });
    }
  }
  cacheSet(`chain-${symbol}`, chain);
  return chain;
}
