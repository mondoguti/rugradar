// Historical backtest of the bot's exact entry signals and exit rules.
//
// HONEST CAVEATS (printed with every run): there is no free historical
// options data, so option prices are approximated with Black-Scholes using
// realized volatility as the IV proxy. Real fills face IV swings, spreads,
// and gaps this model can't see. Treat results as a test of the SIGNAL AND
// EXIT LOGIC — directionally meaningful, not a promise of returns. A strategy
// that loses in this optimistic approximation is definitely broken; one that
// wins still has to prove itself in paper.

import config from '../config.js';
import { getDailyHistory } from './marketdata.js';
import { analyzeBars } from './scanner.js';
import { historicalVol, ema, emaSeries, atr } from './indicators.js';
import { bsPrice } from './bs.js';
import { tierFor } from './risk.js';

// Honest cost model — deliberately pessimistic. Every test should be HARDER
// to pass than reality, not easier.
const SLIP = 0.03;              // 3% haircut each way on premium
const HALF_SPREAD_FLOOR = 0.02; // cheap options: at least 2c given up per side
const FEE = 0.04;               // per-contract regulatory fees, each way
const ENTRY_DTE = 45;           // model entries as ~45 DTE ATM options
const TRADING_TO_CAL = 1.4;     // trading days -> calendar days

function priceOption(type, spot, strike, tradingDteLeft, iv) {
  const dte = Math.max(tradingDteLeft * TRADING_TO_CAL, 1);
  return bsPrice({ type, spot, strike, dte, iv, r: config.data.riskFreeRate }) ?? 0;
}

// `offset` shifts the test window into the past by that many bars — the
// out-of-sample lever. Tuning happened against the recent window (offset 0);
// a strategy that only wins there is curve-fit. Run with offset >= days to
// validate on data the tuning never saw.
export async function backtest({ symbols = config.universe, days = 750, offset = 0, startingEquity = config.account.startingEquity, regimeFilter = config.entries.marketRegimeFilter } = {}) {
  // preload history
  const histories = {};
  for (const s of symbols) {
    try {
      const raw = await getDailyHistory(s, days + offset);
      const bars = offset ? raw.slice(0, -offset) : raw;
      if (bars.length >= 80) histories[s] = bars;
    } catch { /* symbol unavailable — skip */ }
  }
  const symsOk = Object.keys(histories);
  const maxLen = Math.max(...symsOk.map((s) => histories[s].length));

  // SPY regime per distance-from-tail, mirroring the live scanner's filter.
  const spyBars = histories['SPY'];
  const regimeCache = new Map();
  const regimeAt = (offsetFromTail) => {
    if (!regimeFilter || !spyBars) return 'neutral';
    if (regimeCache.has(offsetFromTail)) return regimeCache.get(offsetFromTail);
    let r = 'neutral';
    const idx = spyBars.length - offsetFromTail;
    if (idx >= 61) {
      const closes = spyBars.slice(0, idx).map((b) => b.close);
      const e20 = ema(closes, 20);
      const e50 = ema(closes, 50);
      const s = emaSeries(closes, 50);
      if (e20 != null && e50 != null && s.length >= 11) {
        const e50Prev = s[s.length - 11];
        if (e20 > e50 && e50 > e50Prev) r = 'up';
        else if (e20 < e50 && e50 < e50Prev) r = 'down';
      }
    }
    regimeCache.set(offsetFromTail, r);
    return r;
  };

  let equity = startingEquity;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const open = new Map();       // symbol -> position
  const closed = [];
  const curve = [];

  const closePos = (pos, exitPremium, date, reason) => {
    const exitPx = Math.max(exitPremium * (1 - SLIP) - HALF_SPREAD_FLOOR, 0);
    const proceeds = Math.max(exitPx * pos.contracts * 100 - FEE * pos.contracts, 0);
    const pnl = +(proceeds - pos.cost).toFixed(2);
    equity += proceeds;
    closed.push({ symbol: pos.symbol, type: pos.type, entryDate: pos.entryDate, exitDate: date, pnl, reason, heldDays: pos.heldDays });
    open.delete(pos.symbol);
  };

  // walk forward day-aligned from the end: index offset from each series' tail
  for (let offset = maxLen - 71; offset >= 1; offset--) {
    for (const symbol of symsOk) {
      const bars = histories[symbol];
      const i = bars.length - offset;
      if (i < 70) continue;
      const today = bars[i];
      const window = bars.slice(0, i + 1);

      // ---- manage open position ----
      const pos = open.get(symbol);
      if (pos) {
        pos.dteLeft -= 1;
        pos.heldDays += 1;
        const hv = historicalVol(window.map((b) => b.close), 20) ?? pos.iv;
        const iv = Math.max(hv, 0.10);
        const prem = priceOption(pos.type, today.close, pos.strike, pos.dteLeft, iv);
        const value = prem * pos.contracts * 100;
        const pnl = Math.max(prem * (1 - SLIP) - HALF_SPREAD_FLOOR, 0) * pos.contracts * 100 - FEE * pos.contracts - pos.cost;
        const pnlPct = pnl / pos.cost;
        pos.peakPnl = Math.max(pos.peakPnl, pnl);

        const trail = config.exits.trailing;
        let exit = null;
        // chart-based exits mirroring the live bot: hard stop, thesis break, trail, time
        if (pnlPct <= -config.exits.long.hardStopPct) exit = 'hard stop';
        if (!exit) {
          const e20 = ema(window.map((b) => b.close), 20);
          const a14 = atr(window, 14);
          if (e20 != null && a14 != null) {
            const m = config.exits.long.thesisStopAtrMult;
            const broken = pos.type === 'call' ? today.close < e20 - m * a14 : today.close > e20 + m * a14;
            if (broken) exit = 'thesis broken';
          }
        }
        if (!exit && trail.enabled) {
          const peakPct = pos.peakPnl / pos.cost;
          if (peakPct >= trail.armAtPct && pnl <= pos.peakPnl * (1 - trail.giveBackPct)) exit = 'trailing stop';
        }
        if (!exit && !trail.enabled && pnlPct >= config.exits.profitTargetPct.long) exit = 'profit target';
        if (!exit && pos.dteLeft * TRADING_TO_CAL <= config.exits.timeExitDTE) exit = 'time exit';
        if (!exit && pos.heldDays >= config.exits.maxHoldDays) exit = 'max hold';
        if (exit) closePos(pos, prem, today.date, exit);
      }

      // ---- look for entry ----
      if (!open.has(symbol) && open.size < tierFor(equity).maxPositions) {
        const sig = analyzeBars(window);
        if (!sig || sig.direction === 'neutral' || sig.score < config.entries.minScore) continue;
        const regime = regimeAt(offset);
        if ((regime === 'down' && sig.direction === 'bullish') || (regime === 'up' && sig.direction === 'bearish')) continue;
        const type = sig.direction === 'bullish' ? 'call' : 'put';
        const iv = Math.max(sig.hv20, 0.10);
        const strike = today.close; // ATM ~0.5 delta
        const prem = priceOption(type, today.close, strike, ENTRY_DTE / TRADING_TO_CAL, iv);
        if (prem < 0.05) continue;
        const entryPremium = prem * (1 + SLIP) + HALF_SPREAD_FLOOR;
        const costPer = entryPremium * 100 + FEE;
        const budget = equity * tierFor(equity).riskPct;
        // full premium = planned risk (mirrors live sizing)
        const contracts = Math.floor(budget / costPer);
        if (contracts < 1 || costPer * contracts > equity * config.risk.maxDeployedPct) continue;
        const cost = costPer * contracts;
        equity -= cost;
        open.set(symbol, {
          symbol, type, strike, iv, contracts, cost,
          entryDate: today.date, dteLeft: ENTRY_DTE / TRADING_TO_CAL, heldDays: 0, peakPnl: 0,
        });
      }
    }

    // ---- equity curve / drawdown (marked at cost basis + cash) ----
    let openValue = 0;
    for (const pos of open.values()) openValue += pos.cost + pos.peakPnl * 0; // conservative: cost basis
    const eq = equity + openValue;
    peakEquity = Math.max(peakEquity, eq);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - eq) / peakEquity);
    curve.push(eq);
  }

  // liquidate remaining at last known state (cost basis, conservative)
  for (const pos of [...open.values()]) {
    const bars = histories[pos.symbol];
    const last = bars[bars.length - 1];
    const hv = historicalVol(bars.map((b) => b.close), 20) ?? pos.iv;
    const prem = priceOption(pos.type, last.close, pos.strike, pos.dteLeft, Math.max(hv, 0.1));
    closePos(pos, prem, last.date, 'end of backtest');
  }

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const years = (curve.length / 252) || 1;

  return {
    symbols: symsOk,
    tradingDays: curve.length,
    startingEquity,
    finalEquity: +equity.toFixed(2),
    totalReturnPct: +(((equity - startingEquity) / startingEquity) * 100).toFixed(1),
    cagrPct: +((Math.pow(Math.max(equity, 1) / startingEquity, 1 / years) - 1) * 100).toFixed(1),
    maxDrawdownPct: +(maxDrawdown * 100).toFixed(1),
    trades: closed.length,
    winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : null,
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : null,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    exitBreakdown: closed.reduce((m, t) => { m[t.reason] = (m[t.reason] || 0) + 1; return m; }, {}),
    closed,
  };
}

export const CAVEATS = [
  'Option prices are Black-Scholes approximations from realized vol — real IV, spreads, and gaps will differ.',
  'No earnings-date awareness in the backtest (live scans have the guard).',
  'A losing backtest means the logic is broken; a winning one still must prove out in paper trading.',
];
