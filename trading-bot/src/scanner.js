// Signal engine. For each symbol in the universe, computes a directional
// signal with a 0-100 conviction score plus a volatility regime that decides
// WHICH structure to trade (buy premium when it's cheap, sell it when rich).

import { ema, emaSeries, rsi, atr, historicalVol, avgDollarVolume } from './indicators.js';
import { getDailyHistory, getOptionsChain } from './marketdata.js';
import config from '../config.js';

// ATM implied volatility: average IV of the call+put nearest the spot price
// in the nearest monthly-ish expiry (21-45 DTE preferred).
function atmIV(chain) {
  const candidates = chain.contracts.filter((c) => c.iv > 0 && c.dte >= 15 && c.dte <= 60);
  if (!candidates.length) return null;
  const targetDte = candidates.reduce(
    (best, c) => (Math.abs(c.dte - 30) < Math.abs(best - 30) ? c.dte : best),
    candidates[0].dte
  );
  const atExpiry = candidates.filter((c) => c.dte === targetDte);
  atExpiry.sort((a, b) => Math.abs(a.strike - chain.spot) - Math.abs(b.strike - chain.spot));
  const near = atExpiry.slice(0, 4);
  return near.reduce((a, c) => a + c.iv, 0) / near.length;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function analyzeBars(bars) {
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e50s = emaSeries(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(bars, 14);
  const hv = historicalVol(closes, 20);
  const adv = avgDollarVolume(bars, 20);
  if ([e20, e50, r, a, hv].some((v) => v == null) || e50s.length < 11) return null;

  const close = last.close;
  const e50Prev = e50s[e50s.length - 11]; // EMA50 ten bars ago — slope confirmation
  // Structure AND slope must agree — a fresh crossover against a falling
  // EMA50 is not yet a trend.
  const trendUp = e20 > e50 && e50 > e50Prev && close > e20 * 0.99;
  const trendDown = e20 < e50 && e50 < e50Prev && close < e20 * 1.01;

  const base = { close, ema20: e20, ema50: e50, rsi: r, atr: a, hv20: hv, avgDollarVolume: adv };
  if (!trendUp && !trendDown) {
    return { ...base, direction: 'neutral', score: 0, reasons: ['no confirmed trend (structure + slope) — skip'] };
  }

  const bullish = trendUp;
  const distATR = (close - e20) / a; // signed distance from EMA20 in ATRs
  const chase = bullish ? distATR : -distATR;

  // Chasing an extended move is not an entry — disqualify, don't just penalize.
  if (chase > 1.25) {
    return { ...base, direction: 'neutral', score: 0, reasons: [`${bullish ? 'up' : 'down'}trend but extended ${chase.toFixed(1)} ATR past EMA20 — chasing is not an entry`] };
  }

  const reasons = [];
  // Trend strength (0-40): EMA separation in ATRs, saturating at 1.5.
  const sep = Math.abs(e20 - e50) / a;
  const trendPts = clamp01(sep / 1.5) * 40;
  reasons.push(`${bullish ? 'up' : 'down'}trend, EMA separation ${sep.toFixed(2)} ATR, slope confirmed`);

  // Momentum (0-30): RSI in the healthy band for the direction.
  const rsiIdeal = bullish ? 55 : 45;                 // trending-but-not-exhausted
  const rsiPts = clamp01(1 - Math.abs(r - rsiIdeal) / 20) * 30;
  reasons.push(`RSI ${r.toFixed(0)}`);

  // Entry quality (0-15): the closer to EMA20 (without breaking it), the better.
  const pullPts = clamp01(1 - Math.abs(distATR) / 1.25) * 15;
  if (pullPts > 10) reasons.push(`good entry: ${Math.abs(distATR).toFixed(1)} ATR from EMA20`);

  // Liquidity (0-15).
  const volPts = adv >= 50e6 ? 15 : adv >= 10e6 ? 8 : 0;
  if (!volPts) reasons.push('thin dollar volume');

  const score = Math.round(trendPts + rsiPts + pullPts + volPts);
  return { ...base, direction: bullish ? 'bullish' : 'bearish', score: Math.min(score, 100), reasons };
}

export async function scanSymbol(symbol) {
  const bars = await getDailyHistory(symbol);
  const a = analyzeBars(bars);
  if (!a) return null;

  let chain = null, iv = null, ivHv = null, regime = 'unknown';
  // Only pay for a chain fetch when the signal is worth structuring.
  if (a.direction !== 'neutral' && a.score >= config.entries.minScore - 15) {
    chain = await getOptionsChain(symbol);
    iv = atmIV(chain);
    if (iv && a.hv20 > 0) {
      ivHv = iv / a.hv20;
      regime = ivHv >= config.entries.ivRegime.rich ? 'rich'
        : ivHv <= config.entries.ivRegime.cheap ? 'cheap' : 'normal';
    }
  }

  return { symbol, ...a, atmIV: iv, ivOverHv: ivHv, ivRegime: regime, chain };
}

// Broad-market regime from SPY: 'up' | 'down' | 'neutral'. Same structure+slope
// test as individual signals. Neutral (including any fetch failure) blocks nothing.
export async function marketRegime() {
  try {
    const bars = await getDailyHistory('SPY');
    const closes = bars.map((b) => b.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const s = emaSeries(closes, 50);
    if (e20 == null || e50 == null || s.length < 11) return 'neutral';
    const e50Prev = s[s.length - 11];
    if (e20 > e50 && e50 > e50Prev) return 'up';
    if (e20 < e50 && e50 < e50Prev) return 'down';
    return 'neutral';
  } catch { return 'neutral'; }
}

export async function scanUniverse(universe = config.universe) {
  const results = [];
  const errors = [];
  for (const symbol of universe) {
    try {
      const s = await scanSymbol(symbol);
      if (s) results.push(s);
    } catch (e) {
      errors.push({ symbol, error: e.message });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { results, errors };
}
