// Performance reporting over the closed-trade history.

import { equity } from './portfolio.js';

export function performance(portfolio) {
  const closed = portfolio.closed;
  const wins = closed.filter((t) => t.realizedPnl > 0);
  const losses = closed.filter((t) => t.realizedPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const eq = equity(portfolio);

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
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
    realizedPnl: +closed.reduce((a, t) => a + t.realizedPnl, 0).toFixed(2),
  };
}

export function fmtMoney(n) {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
