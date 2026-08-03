// Paper broker. Simulates fills with realistic slippage, marks positions to
// market, and enforces the exit rules. This is where you prove the system
// works before a single real dollar moves.

import config from '../config.js';
import { getOptionsChain } from './marketdata.js';
import { savePortfolio } from './portfolio.js';
import { canDayTrade } from './risk.js';

// Positive position value = what you'd receive closing it (long structures).
// Credit spreads are stored with entryValue = collateral (max loss) and
// tracked via costToClose.

function slip(price, half) {
  return price + half * config.data.slippage;
}

export function executeTicketPaper(ticket, portfolio) {
  const isCredit = ticket.netCredit != null;
  let entryValue;
  if (isCredit) {
    entryValue = ticket.maxLoss; // collateral held
  } else {
    // pay slightly worse than mid on each leg
    entryValue = ticket.legs.reduce((a, leg) => {
      const half = (leg.ask - leg.bid) / 2;
      const px = leg.action === 'buy' ? slip(leg.mid, half) : Math.max(leg.mid - half * config.data.slippage, leg.bid);
      return a + (leg.action === 'buy' ? px : -px) * leg.contracts * 100;
    }, 0);
    entryValue = +entryValue.toFixed(2);
  }

  const position = {
    id: ticket.id,
    symbol: ticket.symbol,
    structure: ticket.structure,
    direction: ticket.direction,
    legs: ticket.legs,
    openedAt: new Date().toISOString(),
    entryValue,                        // debit paid (or collateral for credit)
    entryCredit: isCredit ? ticket.netCredit : null,
    maxLoss: ticket.maxLoss,
    maxGain: ticket.maxGain,
    dteAtOpen: ticket.dte,
    thesis: ticket.thesis,
    currentValue: entryValue,
    unrealizedPnl: 0,
  };

  portfolio.cash = +(portfolio.cash - entryValue).toFixed(2);
  portfolio.positions.push(position);
  savePortfolio(portfolio);
  return position;
}

function legMid(chain, leg) {
  const c = chain.contracts.find(
    (x) => x.type === leg.type && x.expiry === leg.expiry && x.strike === leg.strike
  );
  return c?.mid ?? null;
}

// Mark a position: current liquidation value (long) or cost-to-close (credit).
export async function markPosition(pos) {
  const chain = await getOptionsChain(pos.symbol);
  let value = 0;
  let stale = false;
  for (const leg of pos.legs) {
    const mid = legMid(chain, leg);
    if (mid == null) { stale = true; continue; }
    value += (leg.action === 'buy' ? mid : -mid) * leg.contracts * 100;
  }
  const isCredit = pos.entryCredit != null;
  if (isCredit) {
    // value is negative-ish: cost to close the short structure
    const costToClose = -value;
    pos.costToClose = +costToClose.toFixed(2);
    pos.currentValue = +(pos.entryValue + pos.entryCredit - costToClose).toFixed(2); // collateral + captured premium
    pos.unrealizedPnl = +(pos.entryCredit - costToClose).toFixed(2);
  } else {
    pos.currentValue = +value.toFixed(2);
    pos.unrealizedPnl = +(value - pos.entryValue).toFixed(2);
  }
  pos.markStale = stale;
  pos.dte = Math.min(...pos.legs.map((l) => Math.max(0, Math.round((new Date(`${l.expiry}T21:00:00Z`) - Date.now()) / 86400000))));
  pos.markedAt = new Date().toISOString();
  return pos;
}

// Returns {action: 'hold'|'close', reason} per exit rules.
export function exitDecision(pos) {
  const isCredit = pos.entryCredit != null;
  const kind = isCredit ? 'creditSpread' : pos.structure.includes('spread') ? 'debitSpread' : 'long';
  const target = config.exits.profitTargetPct[kind];
  const stop = config.exits.stopLossPct[kind];

  if (isCredit) {
    const captured = pos.entryCredit - (pos.costToClose ?? pos.entryCredit);
    if (captured >= pos.entryCredit * target) return { action: 'close', reason: `profit target: captured ${(captured / pos.entryCredit * 100).toFixed(0)}% of credit` };
    if (-pos.unrealizedPnl >= pos.entryCredit * stop) return { action: 'close', reason: `stop: loss ${pos.unrealizedPnl.toFixed(2)} >= ${stop}x credit` };
  } else {
    const pnlPct = pos.unrealizedPnl / pos.entryValue;
    const gainDenom = pos.maxGain ?? pos.entryValue; // spreads target % of max profit
    if (pos.structure.includes('spread')) {
      if (pos.unrealizedPnl >= gainDenom * target) return { action: 'close', reason: `profit target: +$${pos.unrealizedPnl} (${(target * 100)}% of max gain)` };
    } else if (pnlPct >= target) {
      return { action: 'close', reason: `profit target hit: +${(pnlPct * 100).toFixed(0)}%` };
    }
    if (pnlPct <= -stop) return { action: 'close', reason: `stop loss hit: ${(pnlPct * 100).toFixed(0)}%` };
  }

  if (pos.dte != null && pos.dte <= config.exits.timeExitDTE)
    return { action: 'close', reason: `time exit: ${pos.dte} DTE <= ${config.exits.timeExitDTE}` };

  const heldDays = (Date.now() - new Date(pos.openedAt)) / 86400000;
  if (heldDays >= config.exits.maxHoldDays)
    return { action: 'close', reason: `max hold time: ${Math.round(heldDays)} days` };

  return { action: 'hold', reason: 'within all limits' };
}

export function closePositionPaper(pos, portfolio, reason) {
  const isCredit = pos.entryCredit != null;
  const openedToday = pos.openedAt.slice(0, 10) === new Date().toISOString().slice(0, 10);

  if (openedToday && !canDayTrade(portfolio)) {
    return { blocked: true, reason: 'PDT: closing today would be a 4th day trade — hold until tomorrow unless catastrophic' };
  }

  let proceeds, realizedPnl;
  if (isCredit) {
    proceeds = +(pos.entryValue + pos.entryCredit - (pos.costToClose ?? 0)).toFixed(2);
    realizedPnl = +((pos.entryCredit - (pos.costToClose ?? 0))).toFixed(2);
  } else {
    proceeds = pos.currentValue;
    realizedPnl = +(pos.currentValue - pos.entryValue).toFixed(2);
  }

  portfolio.cash = +(portfolio.cash + proceeds).toFixed(2);
  portfolio.positions = portfolio.positions.filter((p) => p.id !== pos.id);
  portfolio.closed.push({
    ...pos,
    closedAt: new Date().toISOString(),
    closeReason: reason,
    realizedPnl,
  });
  if (openedToday) {
    portfolio.dayTrades.push({ date: new Date().toISOString(), symbol: pos.symbol, id: pos.id });
  }
  savePortfolio(portfolio);
  return { blocked: false, realizedPnl };
}
