// Risk gatekeeper. Every ticket passes through validateTicket() before it can
// be executed (paper or live). These checks are the whole point of the bot.

import config from '../config.js';
import { equity, realizedToday, etDay } from './portfolio.js';
import { tradingDaysBetween } from './calendar.js';

// Current sizing tier for an equity level — see config.risk.tiers.
export function tierFor(eq) {
  return config.risk.tiers.find((t) => eq <= t.upToEquity) ?? config.risk.tiers[config.risk.tiers.length - 1];
}

// Drawdown-governor state, read from the persisted rung (stepped by
// updateHighWater on every manage/autopilot run). Rung 0 = normal.
export function governorState(portfolio) {
  const g = config.risk.drawdownGovernor;
  const rung = g?.enabled ? (portfolio.governorRung || 0) : 0;
  const eq = equity(portfolio);
  const hw = portfolio.equityHighWater || portfolio.startingEquity;
  return {
    rung,
    dd: hw > 0 ? Math.max(0, 1 - eq / hw) : 0,
    highWater: hw,
    riskFactor: rung > 0 ? g.rungs[rung - 1].riskFactor : 1,
    slotPenalty: rung > 0 ? g.rungs[rung - 1].slotPenalty : 0,
  };
}

export function riskBudget(portfolio) {
  const eq = equity(portfolio);
  // The governor can only SHRINK the budget — a pre-registered harm-reduction
  // overlay, never a source of extra size.
  return eq * tierFor(eq).riskPct * governorState(portfolio).riskFactor;
}

// Rolling day-trade count over the PDT window, in ACTUAL trading days —
// FINRA counts business days. Vs the old 5x1.4-calendar-day approximation
// this is MORE conservative around holidays (the old code could release
// after as few as 4 trading days) but business-day-granular: a slot frees at
// ET midnight of the 5th-trading-day anniversary rather than at the old
// stamp+7d moment — up to ~15h earlier in clock time on holiday-free weeks
// (FINRA-consistent; disclosed in the README record-integrity section).
export function dayTradesInWindow(portfolio, now = new Date()) {
  const today = etDay(now);
  return portfolio.dayTrades.filter((d) => tradingDaysBetween(etDay(new Date(d.date)), today) < config.risk.pdt.windowDays).length;
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

  const gov = governorState(portfolio);
  if (gov.riskFactor === 0) {
    failures.push(`drawdown circuit breaker: ${(gov.dd * 100).toFixed(0)}% off high-water ${gov.highWater.toFixed(0)} — new entries halted pending human review`);
  }

  const maxPositions = Math.max(0, tierFor(eq).maxPositions - gov.slotPenalty);
  if (portfolio.positions.length >= maxPositions)
    failures.push(`already at max open positions (${maxPositions} at this equity tier${gov.slotPenalty ? `, reduced by the drawdown governor` : ''})`);

  if (portfolio.positions.some((p) => p.symbol === ticket.symbol))
    failures.push(`already have an open position in ${ticket.symbol}`);

  const group = config.risk.correlatedGroups.find((g) => g.includes(ticket.symbol));
  if (group) {
    const clash = portfolio.positions.find(
      (p) => p.symbol !== ticket.symbol && group.includes(p.symbol) && p.direction === ticket.direction
    );
    if (clash)
      failures.push(`correlated exposure: already ${clash.direction} ${clash.symbol} (group ${group.join('/')})`);
  }

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
