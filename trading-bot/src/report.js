// Performance reporting over the closed-trade history.

import config from '../config.js';
import { equity, readExecLog } from './portfolio.js';

export function performance(portfolio) {
  const closed = portfolio.closed;
  const wins = closed.filter((t) => t.realizedPnl > 0);
  const losses = closed.filter((t) => t.realizedPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const eq = equity(portfolio);
  // Total modeled friction: slippage both ways plus per-contract fees, on
  // CLOSED and OPEN trades alike (the open book's entry friction is real
  // money already spent). v1 records carried no ledger fields; their
  // slippage is backed out of the fields they did keep. On a small account
  // this number decides viability more than the strategy does.
  const tradeFriction = (t) => {
    if (t.entrySlippageCost != null || t.entryFees != null) {
      return (t.entrySlippageCost || 0) + (t.exitSlippageCost || 0) + (t.entryFees || 0) + (t.exitFees || 0);
    }
    const midEntry = (t.legs || []).reduce((a, l) => a + (l.action === 'buy' ? 1 : -1) * (l.mid ?? 0) * (l.contracts ?? 0) * 100, 0);
    const entrySlip = Number.isFinite(t.entryValue) && midEntry ? Math.max(0, t.entryValue - midEntry) : 0;
    const exitSlip = Number.isFinite(t.currentValue) && Number.isFinite(t.exitValue) ? Math.max(0, t.currentValue - t.exitValue) : 0;
    return entrySlip + exitSlip;
  };
  const closedFriction = closed.reduce((a, t) => a + tradeFriction(t), 0);
  const openFriction = portfolio.positions.reduce((a, p) => a + (p.entrySlippageCost || 0) + (p.entryFees || 0), 0);
  const grossFriction = +(closedFriction + openFriction).toFixed(2);
  // Friction as a share of the price moves the bot actually caught (mid-to-
  // mid gross per closed trade) — the honest denominator; net wins is not.
  const midGrossAbs = closed.reduce((a, t) => a + Math.abs(t.realizedPnl + tradeFriction(t)), 0);

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
    closedFriction: +closedFriction.toFixed(2),
    openFriction: +openFriction.toFixed(2),
    frictionPctOfMidPnl: midGrossAbs > 0 ? +((closedFriction / midGrossAbs) * 100).toFixed(1) : null,
    frictionPctOfGrossWins: grossWin > 0 ? +((grossFriction / grossWin) * 100).toFixed(1) : null, // denominator = NET realized wins
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

// TELEMETRY ONLY: recompute PF as if fills paid 50% of the half-spread.
// NOTE: extraCostAt50 equals the recorded slippage by construction (25% of
// the half-spread each way; the sell-side bid clamp is inert at these
// factors), so this is a bound, not an independent measurement — the
// naturalFill field on each exec-log row gives the true worst case.
// instead of the modeled 25%. Answers "would a harsher slippage assumption
// flip the record's verdict?" without touching recorded P&L — the gate reads
// recorded numbers, never this.
export function shadowPerformance(portfolio) {
  const extras = new Map(); // id -> total extra cost across open+close
  for (const e of readExecLog()) {
    if (e.shadow?.extraCostAt50 == null) continue;
    extras.set(e.id, (extras.get(e.id) || 0) + e.shadow.extraCostAt50);
  }
  if (!extras.size) return null;
  const closedIds = new Set(portfolio.closed.map((t) => t.id));
  // Honest blend: trades without shadow entries (pre-telemetry v1 fills)
  // enter at recorded P&L — the caller labels that.
  const shadowPnls = portfolio.closed.map((t) => t.realizedPnl - (extras.get(t.id) || 0));
  const gw = shadowPnls.filter((p) => p > 0).reduce((a, p) => a + p, 0);
  const gl = Math.abs(shadowPnls.filter((p) => p <= 0).reduce((a, p) => a + p, 0));
  let closedFriction = 0, openFriction = 0;
  for (const [id, v] of extras) (closedIds.has(id) ? (closedFriction += v) : (openFriction += v));
  return {
    closedTrades: portfolio.closed.length,
    tradesWithShadow: [...extras.keys()].filter((id) => closedIds.has(id)).length,
    shadowProfitFactor: gl > 0 ? +(gw / gl).toFixed(2) : null,
    extraFrictionClosed: +closedFriction.toFixed(2),
    extraFrictionOpenPositions: +openFriction.toFixed(2),
  };
}

export function fmtMoney(n) {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
