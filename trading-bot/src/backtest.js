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

// Strike whose Black-Scholes |delta| equals a target. Φ⁻¹ precomputed for the
// rungs the strategies use (zero-dep). For a call, N(d1)=|Δ| → d1=Φ⁻¹(|Δ|);
// for a put, N(d1)=1−|Δ| → d1=−Φ⁻¹(|Δ|).
const PHI_INV = { 25: -0.6744897, 30: -0.5244005, 35: -0.3853205, 40: -0.2533471, 45: -0.1256613, 50: 0, 55: 0.1256613, 60: 0.2533471, 65: 0.3853205 };
function strikeAtDelta(type, spot, tradingDte, iv, absDelta) {
  const z = PHI_INV[Math.round(absDelta * 100)];
  if (z == null) return null;
  const d1 = type === 'call' ? z : -z;
  const T = Math.max(tradingDte * TRADING_TO_CAL, 1) / 365;
  const lnSK = d1 * iv * Math.sqrt(T) - (config.data.riskFreeRate + iv * iv / 2) * T;
  return spot * Math.exp(-lnSK);
}

// `offset` shifts the test window into the past by that many bars — the
// out-of-sample lever. Tuning happened against the recent window (offset 0);
// a strategy that only wins there is curve-fit. Run with offset >= days to
// validate on data the tuning never saw.
// strategy: 'long' buys calls/puts on the signal (needs Level 2).
// 'credit' SELLS a 0.25-delta credit spread in the signal's direction
// (bullish -> put credit spread below the market; needs Level 3). Credit mode
// deliberately assumes ZERO variance risk premium (IV = realized vol) — real
// markets price IV above realized vol on average, so live credits should be
// richer than modeled. Pessimistic by construction.
export async function backtest({ symbols = config.universe, days = 750, offset = 0, startingEquity = config.account.startingEquity, regimeFilter = config.entries.marketRegimeFilter, strategy = 'long' } = {}) {
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
      if (pos && pos.kind === 'credit') {
        pos.dteLeft -= 1;
        pos.heldDays += 1;
        const hv = historicalVol(window.map((b) => b.close), 20) ?? pos.iv;
        const iv = Math.max(hv, 0.10);
        // cost to buy the spread back, with adverse slippage
        const shortP = priceOption(pos.type, today.close, pos.shortK, pos.dteLeft, iv);
        const wingP = priceOption(pos.type, today.close, pos.wingK, pos.dteLeft, iv);
        const costToClose = Math.max((shortP - wingP) * (1 + SLIP) + HALF_SPREAD_FLOOR, 0);
        const captured = pos.credit - costToClose;

        let exit = null;
        if (captured >= pos.credit * config.exits.profitTargetPct.creditSpread) exit = 'credit captured';
        if (!exit && costToClose - pos.credit >= pos.credit * config.exits.stopLossPct.creditSpread) exit = 'credit stop';
        if (!exit && pos.dteLeft * TRADING_TO_CAL <= config.exits.timeExitDTE) exit = 'time exit';
        if (!exit && pos.heldDays * TRADING_TO_CAL >= config.exits.maxHoldDays) exit = 'max hold'; // heldDays counts trading days; maxHoldDays is calendar
        if (exit) {
          // collateral back plus captured premium, minus 4 legs of fees round-trip
          const proceeds = Math.max(pos.cost + captured * 100 * pos.contracts - 4 * FEE * pos.contracts, 0);
          const pnl = +(proceeds - pos.cost).toFixed(2);
          equity += proceeds;
          closed.push({ symbol: pos.symbol, type: `${pos.type}_credit_spread`, entryDate: pos.entryDate, exitDate: today.date, pnl, reason: exit, heldDays: pos.heldDays });
          open.delete(symbol);
        }
      } else if (pos && pos.kind === 'debit') {
        pos.dteLeft -= 1;
        pos.heldDays += 1;
        const hv = historicalVol(window.map((b) => b.close), 20) ?? pos.iv;
        const iv = Math.max(hv, 0.10);
        const buyP = priceOption(pos.type, today.close, pos.buyK, pos.dteLeft, iv);
        const sellP = priceOption(pos.type, today.close, pos.sellK, pos.dteLeft, iv);
        const exitNet = Math.max((buyP - sellP) * (1 - SLIP) - HALF_SPREAD_FLOOR, 0);
        const pnl = exitNet * 100 * pos.contracts - 2 * FEE * pos.contracts - pos.cost;
        const pnlPct = pnl / pos.cost;

        let exit = null;
        if (pnl >= pos.maxGain * config.exits.profitTargetPct.debitSpread) exit = 'profit target';
        if (!exit && pnlPct <= -config.exits.stopLossPct.debitSpread) exit = 'stop loss';
        if (!exit && pos.dteLeft * TRADING_TO_CAL <= config.exits.timeExitDTE) exit = 'time exit';
        if (!exit && pos.heldDays * TRADING_TO_CAL >= config.exits.maxHoldDays) exit = 'max hold'; // heldDays counts trading days; maxHoldDays is calendar
        if (exit) {
          const proceeds = Math.max(exitNet * 100 * pos.contracts - 2 * FEE * pos.contracts, 0);
          equity += proceeds;
          closed.push({ symbol: pos.symbol, type: `${pos.type}_debit_spread`, entryDate: pos.entryDate, exitDate: today.date, pnl: +(proceeds - pos.cost).toFixed(2), reason: exit, heldDays: pos.heldDays });
          open.delete(symbol);
        }
      } else if (pos) {
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
        if (!exit && pos.heldDays * TRADING_TO_CAL >= config.exits.maxHoldDays) exit = 'max hold'; // heldDays counts trading days; maxHoldDays is calendar
        if (exit) closePos(pos, prem, today.date, exit);
      }

      // ---- look for entry ----
      if (!open.has(symbol) && open.size < tierFor(equity).maxPositions) {
        const sig = analyzeBars(window);
        if (!sig || sig.direction === 'neutral' || sig.score < config.entries.minScore) continue;
        const regime = regimeAt(offset);
        if ((regime === 'down' && sig.direction === 'bullish') || (regime === 'up' && sig.direction === 'bearish')) continue;
        // correlated-exposure guard, mirroring the live validator (SPY+QQQ long = one bet twice)
        const group = config.risk.correlatedGroups.find((g) => g.includes(symbol));
        if (group && [...open.values()].some((p) => p.symbol !== symbol && group.includes(p.symbol) && p.direction === sig.direction)) continue;

        const iv = Math.max(sig.hv20, 0.10);
        const budget = equity * tierFor(equity).riskPct;
        const entryDte = ENTRY_DTE / TRADING_TO_CAL;

        if (strategy === 'credit') {
          // SELL a 0.25-delta spread; scan candidate wing widths exactly the
          // way live buildVertical does — every width up to maxSpreadWidth,
          // 25%-of-width minimum on the PRE-cost mid net, keep the richest
          // credit whose max loss fits the budget.
          const type = sig.direction === 'bullish' ? 'put' : 'call';
          const shortK = strikeAtDelta(type, today.close, entryDte, iv, 0.25);
          if (shortK == null) continue;
          const shortP = priceOption(type, today.close, shortK, entryDte, iv);
          let best = null;
          for (let w = 0.5; w <= config.entries.maxSpreadWidth + 1e-9; w += 0.5) {
            const wingK = type === 'put' ? shortK - w : shortK + w;
            if (wingK <= 0) break; // cheap underlying: put wing hit zero, wider only goes lower
            const wingP = priceOption(type, today.close, wingK, entryDte, iv);
            const midNet = shortP - wingP;
            if (!Number.isFinite(midNet) || midNet <= 0.05) continue;
            if (midNet < w * config.entries.minCreditFractionOfWidth) continue;
            const credit = midNet * (1 - SLIP) - HALF_SPREAD_FLOOR;
            if (credit <= 0.02) continue;
            const maxLossPer = (w - credit) * 100;
            if (maxLossPer <= 0 || maxLossPer > budget) continue;
            if (!best || credit > best.credit) best = { w, wingK, credit, maxLossPer };
          }
          if (!best) continue;
          const contracts = Math.floor(budget / best.maxLossPer);
          if (contracts < 1 || best.maxLossPer * contracts > equity * config.risk.maxDeployedPct) continue;
          const cost = best.maxLossPer * contracts; // collateral held
          equity -= cost;
          open.set(symbol, {
            kind: 'credit', symbol, type, direction: sig.direction, shortK, wingK: best.wingK, width: best.w, credit: best.credit, iv, contracts, cost,
            entryDate: today.date, dteLeft: entryDte, heldDays: 0,
          });
          continue;
        }

        if (strategy === 'debit') {
          // Buy ~0.55Δ, sell ~0.30Δ — the live bot's modal structure in
          // normal IV regimes, previously unsimulated.
          const type = sig.direction === 'bullish' ? 'call' : 'put';
          const buyK = strikeAtDelta(type, today.close, entryDte, iv, config.entries.delta.debitBuy);
          let sellK = strikeAtDelta(type, today.close, entryDte, iv, config.entries.delta.debitSell);
          if (buyK == null || sellK == null) continue;
          const otm = type === 'call' ? 1 : -1;
          if (Math.abs(sellK - buyK) > config.entries.maxSpreadWidth) sellK = buyK + otm * config.entries.maxSpreadWidth;
          if (sellK <= 0) continue;
          const buyP = priceOption(type, today.close, buyK, entryDte, iv);
          const sellP = priceOption(type, today.close, sellK, entryDte, iv);
          const midNet = buyP - sellP;
          if (!Number.isFinite(midNet) || midNet <= 0.05) continue;
          const width = Math.abs(sellK - buyK);
          const debit = midNet * (1 + SLIP) + HALF_SPREAD_FLOOR;
          const costPer = debit * 100 + 2 * FEE;
          const contracts = Math.floor(budget / costPer);
          if (contracts < 1 || costPer * contracts > equity * config.risk.maxDeployedPct) continue;
          const cost = costPer * contracts;
          equity -= cost;
          open.set(symbol, {
            kind: 'debit', symbol, type, direction: sig.direction, buyK, sellK, width, iv, contracts, cost,
            maxGain: (width - midNet) * 100 * contracts,
            entryDate: today.date, dteLeft: entryDte, heldDays: 0,
          });
          continue;
        }

        // LONG mode: mirror the live delta ladder — prefer the highest
        // affordable delta from 0.65 down to the 0.35 floor, premium cap
        // applied to the UN-slipped premium exactly as live caps the mid.
        const type = sig.direction === 'bullish' ? 'call' : 'put';
        let strike = null, prem = null, contracts = 0;
        for (const d of [0.65, 0.60, 0.55, 0.50, 0.45, 0.40, 0.35]) {
          const k = strikeAtDelta(type, today.close, entryDte, iv, d);
          if (k == null) continue;
          const p = priceOption(type, today.close, k, entryDte, iv);
          if (p < 0.05) continue;
          if (config.entries.maxPremiumPerContract && p * 100 > config.entries.maxPremiumPerContract) continue;
          // affordability is part of the walk-down: live buildLong steps to a
          // cheaper rung when the budget can't fill this one, so must we
          const n = Math.floor(budget / ((p * (1 + SLIP) + HALF_SPREAD_FLOOR) * 100 + FEE));
          if (n >= 1) { strike = k; prem = p; contracts = n; break; }
        }
        if (strike == null) continue;
        const entryPremium = prem * (1 + SLIP) + HALF_SPREAD_FLOOR;
        const costPer = entryPremium * 100 + FEE;
        // full premium = planned risk (mirrors live sizing)
        if (costPer * contracts > equity * config.risk.maxDeployedPct) continue;
        const cost = costPer * contracts;
        equity -= cost;
        open.set(symbol, {
          kind: 'long', symbol, type, direction: sig.direction, strike, iv, contracts, cost,
          entryDate: today.date, dteLeft: entryDte, heldDays: 0, peakPnl: 0,
        });
      }
    }

    // ---- equity curve / drawdown (marked at cost basis + cash) ----
    let openValue = 0;
    for (const pos of open.values()) openValue += pos.cost; // conservative: cost basis
    const eq = equity + openValue;
    peakEquity = Math.max(peakEquity, eq);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - eq) / peakEquity);
    curve.push(eq);
  }

  // liquidate remaining at last known state (cost basis, conservative)
  for (const pos of [...open.values()]) {
    const bars = histories[pos.symbol];
    const last = bars[bars.length - 1];
    const hv = Math.max(historicalVol(bars.map((b) => b.close), 20) ?? pos.iv, 0.1);
    if (pos.kind === 'credit') {
      const shortP = priceOption(pos.type, last.close, pos.shortK, pos.dteLeft, hv);
      const wingP = priceOption(pos.type, last.close, pos.wingK, pos.dteLeft, hv);
      const costToClose = Math.max((shortP - wingP) * (1 + SLIP) + HALF_SPREAD_FLOOR, 0);
      const proceeds = Math.max(pos.cost + (pos.credit - costToClose) * 100 * pos.contracts - 4 * FEE * pos.contracts, 0);
      const pnl = +(proceeds - pos.cost).toFixed(2);
      equity += proceeds;
      closed.push({ symbol: pos.symbol, type: `${pos.type}_credit_spread`, entryDate: pos.entryDate, exitDate: last.date, pnl, reason: 'end of backtest', heldDays: pos.heldDays });
      open.delete(pos.symbol);
      continue;
    }
    if (pos.kind === 'debit') {
      const buyP = priceOption(pos.type, last.close, pos.buyK, pos.dteLeft, hv);
      const sellP = priceOption(pos.type, last.close, pos.sellK, pos.dteLeft, hv);
      const exitNet = Math.max((buyP - sellP) * (1 - SLIP) - HALF_SPREAD_FLOOR, 0);
      const proceeds = Math.max(exitNet * 100 * pos.contracts - 2 * FEE * pos.contracts, 0);
      equity += proceeds;
      closed.push({ symbol: pos.symbol, type: `${pos.type}_debit_spread`, entryDate: pos.entryDate, exitDate: last.date, pnl: +(proceeds - pos.cost).toFixed(2), reason: 'end of backtest', heldDays: pos.heldDays });
      open.delete(pos.symbol);
      continue;
    }
    const prem = priceOption(pos.type, last.close, pos.strike, pos.dteLeft, hv);
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
  'CREDIT and DEBIT spread modes measure structure mechanics under IV=HV pricing: selling premium has zero edge by construction here (the real-world case is the variance risk premium, invisible to this model). Use them to size friction and validate exits, not to judge strategy edge.',
  'The live bot routes structures by IV regime (cheap->long, normal->debit, rich->credit); the backtest cannot (IV/HV is identically 1 under its pricing), so each mode simulates ALL signals through one structure. Run all three modes for coverage.',
];
