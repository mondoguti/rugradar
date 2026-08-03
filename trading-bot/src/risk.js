// Risk gatekeeper. Every ticket passes through validateTicket() before it can
// be executed (paper or live). These checks are the whole point of the bot.

import config from '../config.js';
import { equity, realizedToday } from './portfolio.js';

export function riskBudget(portfolio) {
  const eq = equity(portfolio);
  return Math.min(eq * config.risk.maxRiskPerTradePct, config.risk.maxRiskPerTradeAbs);
}

// Rolling day-trade count over the PDT window (5 trading days ~ 7 calendar days).
export function dayTradesInWindow(portfolio, now = new Date()) {
  const windowMs = config.risk.pdt.windowDays * 1.4 * 86400000; // trading->calendar days
  return portfolio.dayTrades.filter((d) => now - new Date(d.date) < windowMs).length;
}

export function canDayTrade(portfolio) {
  if (!config.risk.pdt.enabled) return true;
  return dayTradesInWindow(portfolio) < config.risk.pdt.maxDayTrades;
}

export function validateTicket(ticket, portfolio) {
  const failures = [];
  const warnings = [];
  const eq = equity(portfolio);
  const budget = riskBudget(portfolio);

  if (ticket.maxLoss == null || ticket.maxLoss <= 0) failures.push('ticket has no defined max loss');
  const risk = ticket.plannedRisk ?? ticket.maxLoss;
  if (risk > budget * 1.01) failures.push(`planned risk $${risk} exceeds budget $${budget.toFixed(2)}`);

  const cost = ticket.netDebit ?? ticket.maxLoss; // credit spreads tie up collateral = maxLoss
  if (cost > portfolio.cash) failures.push(`cost $${cost} exceeds cash $${portfolio.cash.toFixed(2)}`);

  if (portfolio.positions.length >= config.risk.maxOpenPositions)
    failures.push(`already at max open positions (${config.risk.maxOpenPositions})`);

  if (portfolio.positions.some((p) => p.symbol === ticket.symbol))
    failures.push(`already have an open position in ${ticket.symbol}`);

  const deployed = portfolio.positions.reduce((a, p) => a + p.entryValue, 0);
  if (deployed + cost > eq * config.risk.maxDeployedPct)
    failures.push(`would deploy $${(deployed + cost).toFixed(2)}, over ${config.risk.maxDeployedPct * 100}% of equity`);

  const todayPnl = realizedToday(portfolio);
  if (todayPnl < -eq * config.risk.dailyLossLimitPct)
    failures.push(`daily loss limit hit (today: $${todayPnl.toFixed(2)}) — no new trades today`);

  if (!canDayTrade(portfolio))
    warnings.push('PDT: no day trades left in window — do NOT close this position the same day you open it');

  if (ticket.dte != null && ticket.dte < 21)
    warnings.push(`short DTE (${ticket.dte}) — theta decay accelerates`);

  for (const leg of ticket.legs || []) {
    if (leg.mid && leg.ask && (leg.ask - leg.bid) / leg.mid > 0.15)
      warnings.push(`${leg.type} ${leg.strike} bid/ask spread is wide — use a limit order at mid, never market`);
  }

  return { ok: failures.length === 0, failures, warnings };
}
