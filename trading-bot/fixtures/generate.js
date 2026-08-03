// Generates deterministic synthetic market data (daily bars + options chains)
// so the entire pipeline can be tested offline: node trading-bot/fixtures/generate.js
// The data is realistic in shape (trends, vol clustering, BS-priced chains with
// skew) but is NOT real market data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bsPrice, bsDelta } from '../src/bs.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Mulberry32 seeded PRNG — deterministic runs.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// symbol: [startPrice, dailyDrift, dailyVol, ivPremiumOverHv]
const PROFILES = {
  SPY:  [620, +0.0007, 0.009, 1.00],   // steady uptrend, normal IV
  QQQ:  [560, +0.0010, 0.012, 0.85],   // strong uptrend, cheap IV
  IWM:  [230, +0.0002, 0.012, 1.10],
  AAPL: [240, +0.0008, 0.014, 0.88],   // uptrend, cheap IV
  AMD:  [165, -0.0012, 0.022, 1.05],   // downtrend
  INTC: [24,  -0.0008, 0.020, 1.30],   // downtrend, rich IV
  PLTR: [95,  +0.0015, 0.025, 0.87],   // strong uptrend, cheap IV
  HOOD: [55,  +0.0011, 0.026, 1.35],   // uptrend but rich IV
  SOFI: [16,  +0.0009, 0.024, 0.92],
  F:    [11,  -0.0001, 0.014, 1.00],   // flat
  BAC:  [46,  +0.0004, 0.012, 1.02],
  T:    [22,  +0.0001, 0.010, 0.98],   // flat
  AAL:  [13,  -0.0010, 0.022, 1.28],   // downtrend, rich IV
  RIVN: [14,  -0.0015, 0.032, 1.20],
  MARA: [19,  +0.0013, 0.045, 0.89],   // uptrend, high real vol, cheap-ish IV
};

function genHistory(symbol, [start, drift, vol], rand) {
  const bars = [];
  let price = start;
  const today = new Date();
  for (let i = 150; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - Math.round(i * 1.45)); // approx skip weekends
    const shock = (rand() * 2 - 1) * vol * Math.sqrt(3);
    const ret = drift + shock;
    const open = price;
    price = Math.max(price * (1 + ret), 0.5);
    const hi = Math.max(open, price) * (1 + rand() * vol);
    const lo = Math.min(open, price) * (1 - rand() * vol);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: +open.toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2), close: +price.toFixed(2),
      volume: Math.round(2e7 * (0.6 + rand())),
    });
  }
  return bars;
}

function strikeStep(spot) {
  if (spot < 25) return 0.5;
  if (spot < 100) return 1;
  if (spot < 300) return 2.5;
  return 5;
}

function genChain(symbol, spot, hv, ivMult, rand) {
  const contracts = [];
  const step = strikeStep(spot);
  const baseIv = Math.max(hv * ivMult, 0.10);
  for (const dte of [7, 14, 28, 35, 49, 63]) {
    const expiry = new Date(Date.now() + dte * 86400000).toISOString().slice(0, 10);
    const atm = Math.round(spot / step) * step;
    for (let k = -12; k <= 12; k++) {
      const strike = +(atm + k * step).toFixed(2);
      if (strike <= 0) continue;
      const moneyness = Math.abs(Math.log(strike / spot));
      const iv = +(baseIv * (1 + moneyness * 1.6) * (0.97 + rand() * 0.06)).toFixed(4); // smile
      for (const type of ['call', 'put']) {
        const theo = bsPrice({ type, spot, strike, dte, iv });
        if (theo == null || theo < 0.02) continue;
        const halfSpread = Math.max(theo * 0.03, 0.01) * (1 + rand());
        const bid = Math.max(+(theo - halfSpread).toFixed(2), 0);
        const ask = +(theo + halfSpread).toFixed(2);
        const nearAtm = Math.max(0, 1 - Math.abs(k) / 12);
        contracts.push({
          type, expiry, dte, strike,
          bid, ask, mid: bid > 0 ? +((bid + ask) / 2).toFixed(3) : null,
          volume: Math.round(3000 * nearAtm * rand()),
          openInterest: Math.round(8000 * nearAtm * (0.3 + rand())),
          iv,
          delta: +bsDelta({ type, spot, strike, dte, iv }).toFixed(3),
        });
      }
    }
  }
  return { symbol, spot, updatedAt: new Date().toISOString(), contracts, synthetic: true };
}

// hv estimate from generated closes (mirrors indicators.historicalVol)
function hvOf(closes) {
  const rets = [];
  const s = closes.slice(-21);
  for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i] / s[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

let seed = 42;
for (const [symbol, profile] of Object.entries(PROFILES)) {
  const rand = rng(seed++);
  const history = genHistory(symbol, profile, rand);
  const spot = history[history.length - 1].close;
  const hv = hvOf(history.map((b) => b.close));
  const chain = genChain(symbol, spot, hv, profile[3], rand);
  fs.writeFileSync(path.join(DIR, `${symbol}.history.json`), JSON.stringify(history));
  fs.writeFileSync(path.join(DIR, `${symbol}.chain.json`), JSON.stringify(chain));
  console.log(`${symbol}: spot ${spot.toFixed(2)}, HV ${(hv * 100).toFixed(0)}%, IV mult ${profile[3]}, ${chain.contracts.length} contracts`);
}
console.log('\nFixtures written. Test with: node trading-bot/src/index.js scan --fixtures');
