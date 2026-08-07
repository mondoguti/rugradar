// Performance reporting over the closed-trade history.

import config from '../config.js';
import { equity } from './portfolio.js';

export function performance(portfolio) {
  const closed = portfolio.closed;
  const wins = closed.filter((t) => t.realizedPnl > 0);
  const losses = closed.filter((t) => t.realizedPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const eq = equity(portfolio);
  // Total modeled friction: slippage both ways plus per-contract fees. On a
  // small account this number decides viability more than the strategy does.
  const grossFriction = +closed.reduce(
    (a, t) => a + (t.entrySlippageCost || 0) + (t.exitSlippageCost || 0) + (t.entryFees || 0) + (t.exitFees || 0), 0
  ).toFixed(2);

  return {
    startingEquity: portfolio.startingEquity,
    equity: +eq.toFixed(2),
    cash: portfolio.cash,
    totalReturnPct: +(((eq - portfolio.startingEquity) / portfolio.startingEquity) * 100).toFixed(2),
    openPositions: portfolio.positions.length,
    closedTrades: closed.length,
    winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : null,
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : null,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : null,
    // null when there are no losses yet — Infinity is not JSON-representable
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    realizedPnl: +closed.reduce((a, t) => a + t.realizedPnl, 0).toFixed(2),
    grossFriction,
    frictionPctOfGrossWins: grossWin > 0 ? +((grossFriction / grossWin) * 100).toFixed(1) : null,
  };
}

// The pre-registered go-live gate, as code. Read-only: reports progress,
// never feeds trading logic (a gate that pressures the scan is a quota).
export function gateStatus(portfolio) {
  const { minClosedTrades, minProfitFactor, frozenAt } = config.goLive;
  const p = performance(portfolio);
  const closed = portfolio.closed;
  let tradesPerWeek = null, estWeeksRemaining = null;
  if (closed.length >= 2) {
    const times = closed.map((t) => new Date(t.closedAt).getTime()).sort((a, b) => a - b);
    const spanWeeks = (times[times.length - 1] - times[0]) / (7 * 86400000);
    if (spanWeeks > 0) {
      tradesPerWeek = +(closed.length / spanWeeks).toFixed(2);
      const remaining = Math.max(0, minClosedTrades - closed.length);
      estWeeksRemaining = tradesPerWeek > 0 ? +(remaining / tradesPerWeek).toFixed(1) : null;
    }
  }
  return {
    closedTrades: p.closedTrades,
    tradesNeeded: Math.max(0, minClosedTrades - p.closedTrades),
    profitFactor: p.profitFactor,
    pfNeeded: minProfitFactor,
    passed: p.closedTrades >= minClosedTrades && p.profitFactor != null && p.profitFactor > minProfitFactor,
    tradesPerWeek,
    estWeeksRemaining,
    frozenAt,
  };
}

export function fmtMoney(n) {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
