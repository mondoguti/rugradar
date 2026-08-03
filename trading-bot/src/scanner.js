// Signal engine. For each symbol in the universe, computes a directional
// signal with a 0-100 conviction score plus a volatility regime that decides
// WHICH structure to trade (buy premium when it's cheap, sell it when rich).

import { ema, rsi, atr, historicalVol, avgDollarVolume } from './indicators.js';
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

export function analyzeBars(bars) {
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(bars, 14);
  const hv = historicalVol(closes, 20);
  const adv = avgDollarVolume(bars, 20);
  if ([e20, e50, r, a, hv].some((v) => v == null)) return null;

  const close = last.close;
  const trendUp = e20 > e50 && close > e20 * 0.995;
  const trendDown = e20 < e50 && close < e20 * 1.005;

  let direction = 'neutral';
  let score = 0;
  const reasons = [];

  if (trendUp) {
    direction = 'bullish';
    score += 40;
    reasons.push('uptrend (EMA20>EMA50, price above EMA20)');
    if (r >= 45 && r <= 68) { score += 25; reasons.push(`RSI ${r.toFixed(0)} healthy`); }
    else if (r < 45) { score += 10; reasons.push(`RSI ${r.toFixed(0)} soft`); }
    else { score += 5; reasons.push(`RSI ${r.toFixed(0)} stretched`); }
    // pullback entry: price within 1 ATR of EMA20 beats chasing extension
    if (Math.abs(close - e20) <= a) { score += 20; reasons.push('pullback to EMA20 (good entry)'); }
    else if ((close - e20) / a <= 2.5) { score += 10; }
    else reasons.push('extended >2.5 ATR above EMA20');
  } else if (trendDown) {
    direction = 'bearish';
    score += 40;
    reasons.push('downtrend (EMA20<EMA50, price below EMA20)');
    if (r <= 55 && r >= 32) { score += 25; reasons.push(`RSI ${r.toFixed(0)} confirming`); }
    else if (r > 55) { score += 10; reasons.push(`RSI ${r.toFixed(0)} rallying into resistance`); }
    else { score += 5; reasons.push(`RSI ${r.toFixed(0)} oversold — late`); }
    if (Math.abs(close - e20) <= a) { score += 20; reasons.push('rally to EMA20 (good entry)'); }
    else if ((e20 - close) / a <= 2.5) { score += 10; }
    else reasons.push('extended >2.5 ATR below EMA20');
  } else {
    reasons.push('no clear trend — skip');
  }

  // liquidity bonus: $50M+ average daily dollar volume
  if (adv >= 50e6) score += 15;
  else if (adv >= 10e6) score += 8;
  else reasons.push('thin dollar volume');

  return { close, ema20: e20, ema50: e50, rsi: r, atr: a, hv20: hv, avgDollarVolume: adv, direction, score: Math.min(score, 100), reasons };
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
