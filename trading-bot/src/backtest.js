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
import { historicalVol } from './indicators.js';
import { bsPrice } from './bs.js';
import { tierFor } from './risk.js';

const SLIP = 0.03;              // 3% haircut each way on premium
const ENTRY_DTE = 45;           // model entries as ~45 DTE ATM options
const TRADING_TO_CAL = 1.4;     // trading days -> calendar days

function priceOption(type, spot, strike, tradingDteLeft, iv) {
  const dte = Math.max(tradingDteLeft * TRADING_TO_CAL, 1);
  return bsPrice({ type, spot, strike, dte, iv, r: config.data.riskFreeRate }) ?? 0;
}

export async function backtest({ symbols = config.universe, days = 750, startingEquity = config.account.startingEquity } = {}) {
  // preload history
  const histories = {};
  for (const s of symbols) {
    try {
      const bars = await getDailyHistory(s, days);
      if (bars.length >= 80) histories[s] = bars;
    } catch { /* symbol unavailable — skip */ }
  }
  const symsOk = Object.keys(histories);
  const maxLen = Math.max(...symsOk.map((s) => histories[s].length));

  let equity = startingEquity;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const open = new Map();       // symbol -> position
  const closed = [];
  const curve = [];

  const closePos = (pos, exitPremium, date, reason) => {
    const proceeds = exitPremium * (1 - SLIP) * pos.contracts * 100;
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
        const pnl = value * (1 - SLIP) - pos.cost;
        const pnlPct = pnl / pos.cost;
        pos.peakPnl = Math.max(pos.peakPnl, pnl);

        const trail = config.exits.trailing;
        const stop = config.exits.stopLossPct.long;
        let exit = null;
        if (pnlPct <= -stop) exit = 'stop loss';
        else if (trail.enabled) {
          const peakPct = pos.peakPnl / pos.cost;
          if (peakPct >= trail.armAtPct && pnl <= pos.peakPnl * (1 - trail.giveBackPct)) exit = 'trailing stop';
        } else if (pnlPct >= config.exits.profitTargetPct.long) exit = 'profit target';
        if (!exit && pos.dteLeft * TRADING_TO_CAL <= config.exits.timeExitDTE) exit = 'time exit';
        if (!exit && pos.heldDays >= config.exits.maxHoldDays) exit = 'max hold';
        if (exit) closePos(pos, prem, today.date, exit);
      }

      // ---- look for entry ----
      if (!open.has(symbol) && open.size < tierFor(equity).maxPositions) {
        const sig = analyzeBars(window);
        if (!sig || sig.direction === 'neutral' || sig.score < config.entries.minScore) continue;
        const type = sig.direction === 'bullish' ? 'call' : 'put';
        const iv = Math.max(sig.hv20, 0.10);
        const strike = today.close; // ATM ~0.5 delta
        const prem = priceOption(type, today.close, strike, ENTRY_DTE / TRADING_TO_CAL, iv);
        if (prem < 0.05) continue;
        const entryPremium = prem * (1 + SLIP);
        const costPer = entryPremium * 100;
        const budget = equity * tierFor(equity).riskPct;
        const riskPer = costPer * config.exits.stopLossPct.long;
        const contracts = Math.floor(budget / riskPer);
        if (contracts < 1 || costPer * contracts > budget * 2 || costPer * contracts > equity * config.risk.maxDeployedPct) continue;
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
