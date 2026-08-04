// Paper broker. Simulates fills with realistic slippage, marks positions to
// market, and enforces the exit rules. This is where you prove the system
// works before a single real dollar moves.

import config from '../config.js';
import { getOptionsChain, getDailyHistory } from './marketdata.js';
import { ema, atr } from './indicators.js';
import { savePortfolio, etDay } from './portfolio.js';
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
    mode: 'paper',                     // live fills recorded via /bot-execute set 'live'
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

function legQuote(chain, leg) {
  return chain.contracts.find(
    (x) => x.type === leg.type && x.expiry === leg.expiry && x.strike === leg.strike
  ) ?? null;
}

// Mark a position: current liquidation value (long) or cost-to-close (credit).
// Computes two values per position: the fair mid-based mark (drives exit
// decisions) and a slippage-adjusted exit value (drives paper close fills, so
// paper results don't flatter themselves — entries already pay slippage).
export async function markPosition(pos) {
  const chain = await getOptionsChain(pos.symbol);
  let value = 0;       // at mid
  let exitValue = 0;   // what you'd actually collect/pay closing, with slippage
  let stale = false;
  for (const leg of pos.legs) {
    const q = legQuote(chain, leg);
    if (q?.mid == null) { stale = true; continue; }
    const half = (q.ask - q.bid) / 2;
    // closing reverses the leg: bought legs get sold (receive less than mid),
    // sold legs get bought back (pay more than mid)
    const closePx = leg.action === 'buy'
      ? Math.max(q.mid - half * config.data.slippage, q.bid)
      : q.mid + half * config.data.slippage;
    value += (leg.action === 'buy' ? q.mid : -q.mid) * leg.contracts * 100;
    exitValue += (leg.action === 'buy' ? closePx : -closePx) * leg.contracts * 100;
  }
  const isCredit = pos.entryCredit != null;
  if (isCredit) {
    // value is negative-ish: cost to close the short structure
    const costToClose = -value;
    pos.costToClose = +costToClose.toFixed(2);
    pos.costToCloseSlipped = +(-exitValue).toFixed(2);
    pos.currentValue = +(pos.entryValue + pos.entryCredit - costToClose).toFixed(2); // collateral + captured premium
    pos.unrealizedPnl = +(pos.entryCredit - costToClose).toFixed(2);
  } else {
    pos.currentValue = +value.toFixed(2);
    pos.exitValue = +exitValue.toFixed(2);
    pos.unrealizedPnl = +(value - pos.entryValue).toFixed(2);
  }
  // track the high-water mark for the trailing stop
  if (!stale) pos.peakPnl = Math.max(pos.peakPnl ?? 0, pos.unrealizedPnl);
  pos.markStale = stale;

  // Thesis check for long options: has the underlying broken the setup?
  // (Exits live on the chart, not on option-price noise.)
  if (!isCredit && !pos.structure.includes('spread')) {
    try {
      const bars = await getDailyHistory(pos.symbol);
      const closes = bars.map((b) => b.close);
      const e20 = ema(closes, 20);
      const a = atr(bars, 14);
      const close = closes[closes.length - 1];
      const m = config.exits.long.thesisStopAtrMult;
      const bullish = pos.direction === 'bullish';
      const broken = bullish ? close < e20 - m * a : close > e20 + m * a;
      pos.thesisBroken = broken;
      pos.thesisNote = broken
        ? `underlying ${close.toFixed(2)} closed ${bullish ? 'below' : 'above'} EMA20 ${bullish ? '-' : '+'} ${m} ATR (${(bullish ? e20 - m * a : e20 + m * a).toFixed(2)})`
        : null;
    } catch { pos.thesisBroken = false; }
  }
  pos.dte = Math.min(...pos.legs.map((l) => Math.max(0, Math.round((new Date(`${l.expiry}T21:00:00Z`) - Date.now()) / 86400000))));
  pos.markedAt = new Date().toISOString();
  return pos;
}

// Returns {action: 'hold'|'close', reason} per exit rules.
export function exitDecision(pos) {
  const isCredit = pos.entryCredit != null;
  const kind = isCredit ? 'creditSpread' : pos.structure.includes('spread') ? 'debitSpread' : 'long';
  const target = config.exits.profitTargetPct[kind];
  const stop = config.exits.stopLossPct[kind]; // undefined for 'long' — handled below

  // A stale mark (missing leg quote) must never drive a P&L-based exit —
  // only time-based rules below apply until quotes come back.
  if (pos.markStale) {
    if (pos.dte != null && pos.dte <= config.exits.timeExitDTE)
      return { action: 'close', reason: `time exit on stale mark: ${pos.dte} DTE — verify price manually before closing` };
    return { action: 'hold', reason: 'mark is stale (missing leg quote) — no P&L decision possible' };
  }

  if (isCredit) {
    const captured = pos.entryCredit - (pos.costToClose ?? pos.entryCredit);
    if (captured >= pos.entryCredit * target) return { action: 'close', reason: `profit target: captured ${(captured / pos.entryCredit * 100).toFixed(0)}% of credit` };
    if (-pos.unrealizedPnl >= pos.entryCredit * stop) return { action: 'close', reason: `stop: loss ${pos.unrealizedPnl.toFixed(2)} >= ${stop}x credit` };
  } else if (kind === 'debitSpread') {
    const pnlPct = pos.unrealizedPnl / pos.entryValue;
    const gainDenom = pos.maxGain ?? pos.entryValue;
    if (pos.unrealizedPnl >= gainDenom * target) return { action: 'close', reason: `profit target: +$${pos.unrealizedPnl} (${(target * 100)}% of max gain)` };
    if (pnlPct <= -stop) return { action: 'close', reason: `stop loss hit: ${(pnlPct * 100).toFixed(0)}%` };
  } else {
    // long options: chart-based exits, not premium-noise stops
    const pnlPct = pos.unrealizedPnl / pos.entryValue;
    const trail = config.exits.trailing;
    if (pnlPct <= -config.exits.long.hardStopPct)
      return { action: 'close', reason: `hard stop (gap backstop): ${(pnlPct * 100).toFixed(0)}%` };
    if (pos.thesisBroken)
      return { action: 'close', reason: `thesis broken: ${pos.thesisNote}` };
    if (trail.enabled) {
      const peakPct = (pos.peakPnl ?? 0) / pos.entryValue;
      if (peakPct >= trail.armAtPct && pos.unrealizedPnl <= pos.peakPnl * (1 - trail.giveBackPct)) {
        return { action: 'close', reason: `trailing stop: peaked +${(peakPct * 100).toFixed(0)}%, gave back ${(trail.giveBackPct * 100)}% of peak` };
      }
    } else if (pnlPct >= target) {
      return { action: 'close', reason: `profit target hit: +${(pnlPct * 100).toFixed(0)}%` };
    }
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
  const openedToday = etDay(pos.openedAt) === etDay();

  if (openedToday && !canDayTrade(portfolio)) {
    return { blocked: true, reason: 'PDT: closing today would be a 4th day trade — hold until tomorrow unless catastrophic' };
  }

  // Paper closes fill at the slippage-adjusted price, not the flattering mid.
  let proceeds, realizedPnl;
  if (isCredit) {
    const closeCost = pos.costToCloseSlipped ?? pos.costToClose ?? 0;
    proceeds = +(pos.entryValue + pos.entryCredit - closeCost).toFixed(2);
    realizedPnl = +(pos.entryCredit - closeCost).toFixed(2);
  } else {
    proceeds = pos.exitValue ?? pos.currentValue;
    realizedPnl = +(proceeds - pos.entryValue).toFixed(2);
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
