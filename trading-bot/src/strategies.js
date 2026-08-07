// Structure selection and order-ticket construction.
//
// Regime logic:
//   premium CHEAP  (IV/HV <= 0.90): buy it  -> long call/put
//   premium NORMAL                : defined-risk debit spread (or long if no spread approval)
//   premium RICH   (IV/HV >= 1.25): sell it -> credit spread; without spread approval, STAND ASIDE
//                                   (buying overpriced premium is how small accounts die)

import crypto from 'node:crypto';
import config from '../config.js';

function liquid(c) {
  const L = config.entries.liquidity;
  if (!c.mid || c.bid < L.minBid) return false;
  if (c.openInterest < L.minOpenInterest) return false;
  if ((c.ask - c.bid) / c.mid > L.maxBidAskPctOfMid && c.ask - c.bid > 0.10) return false;
  return true;
}

// Pick the expiry (among liquid contracts of the right type) whose DTE is
// closest to the middle of the allowed window.
function pickExpiry(contracts, [minDte, maxDte]) {
  const target = (minDte + maxDte) / 2;
  const expiries = [...new Set(contracts.filter((c) => c.dte >= minDte && c.dte <= maxDte).map((c) => c.expiry))];
  if (!expiries.length) return null;
  return expiries.reduce((best, e) => {
    const dte = contracts.find((c) => c.expiry === e).dte;
    const bestDte = contracts.find((c) => c.expiry === best).dte;
    return Math.abs(dte - target) < Math.abs(bestDte - target) ? e : best;
  });
}

function byDeltaTarget(contracts, target) {
  const ok = contracts.filter((c) => c.delta != null && liquid(c));
  if (!ok.length) return null;
  return ok.reduce((best, c) =>
    Math.abs(Math.abs(c.delta) - target) < Math.abs(Math.abs(best.delta) - target) ? c : best
  );
}

function ticketBase(signal, structure) {
  return {
    id: crypto.randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    symbol: signal.symbol,
    spot: signal.close,
    direction: signal.direction,
    score: signal.score,
    ivRegime: signal.ivRegime,
    structure,
    status: 'pending',
    thesis: signal.reasons.join('; '),
  };
}

function buildLong(signal, riskBudget) {
  const type = signal.direction === 'bullish' ? 'call' : 'put';
  const pool = signal.chain.contracts.filter((c) => c.type === type);
  const expiry = pickExpiry(pool.filter(liquid), config.entries.dte.long);
  if (!expiry) return null;
  const atExpiry = pool.filter((c) => c.expiry === expiry);

  // Delta ladder: prefer the 0.55Δ target, but if that contract doesn't fit
  // the risk budget, walk DOWN the delta ladder toward the 0.35 floor until
  // one does. Lower delta = cheaper premium = affordable for a small account,
  // while the floor keeps us out of lottery-ticket territory. Never below it.
  const { longEntry, longMin } = config.entries.delta;
  const ladder = atExpiry
    .filter((c) => liquid(c) && c.delta != null &&
      Math.abs(c.delta) >= longMin && Math.abs(c.delta) <= longEntry + 0.10 &&
      (!config.entries.maxPremiumPerContract || c.mid * 100 <= config.entries.maxPremiumPerContract))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let leg = null, contracts = 0;
  for (const c of ladder) {
    // The FULL premium is the planned risk — long options can gap to zero,
    // and thesis-based exits (no tight premium stop) mean drawdowns run
    // deeper than a fixed stop would pretend. Size accordingly.
    const costPerContract = c.mid * 100;
    const n = Math.floor(riskBudget / costPerContract);
    if (n >= 1) { leg = c; contracts = n; break; }
  }
  if (!leg) return null;

  return {
    ...ticketBase(signal, `long_${type}`),
    legs: [{ action: 'buy', type, expiry: leg.expiry, strike: leg.strike, contracts, mid: leg.mid, bid: leg.bid, ask: leg.ask, delta: leg.delta, iv: leg.iv, gamma: leg.gamma ?? null, theta: leg.theta ?? null, vega: leg.vega ?? null, openInterest: leg.openInterest }],
    netDebit: +(leg.mid * contracts * 100).toFixed(2),
    maxLoss: +(leg.mid * contracts * 100).toFixed(2),
    plannedRisk: +(leg.mid * contracts * 100).toFixed(2),
    maxGain: null, // unlimited (call) / substantial (put)
    breakeven: type === 'call' ? +(leg.strike + leg.mid).toFixed(2) : +(leg.strike - leg.mid).toFixed(2),
    dte: leg.dte,
  };
}

function buildVertical(signal, riskBudget, kind) {
  // kind: 'debit' (buy near, sell far) or 'credit' (sell near-OTM, buy wing)
  const bullish = signal.direction === 'bullish';
  const type = kind === 'debit' ? (bullish ? 'call' : 'put') : (bullish ? 'put' : 'call');
  const pool = signal.chain.contracts.filter((c) => c.type === type);
  const expiry = pickExpiry(pool.filter(liquid), config.entries.dte[kind === 'debit' ? 'debitSpread' : 'creditSpread']);
  if (!expiry) return null;
  const atExpiry = pool.filter((c) => c.expiry === expiry).sort((a, b) => a.strike - b.strike);

  const nearTarget = kind === 'debit' ? config.entries.delta.debitBuy : config.entries.delta.creditSell;
  const near = byDeltaTarget(atExpiry, nearTarget);
  if (!near) return null;
  // If the closest liquid strike is nowhere near the target delta, the chain
  // is too thin (or quotes are degraded) to build this structure honestly.
  if (Math.abs(Math.abs(near.delta) - nearTarget) > config.entries.delta.nearTolerance) return null;

  // Far leg sits further out-of-the-money than the near leg (calls: higher
  // strike, puts: lower), within maxSpreadWidth. In both structures we
  // buy/sell the near strike and take the opposite side further out.
  const otmDir = type === 'call' ? 1 : -1;
  const away = atExpiry.filter((c) =>
    (c.strike - near.strike) * otmDir > 0 &&
    Math.abs(c.strike - near.strike) <= config.entries.maxSpreadWidth &&
    liquid(c)
  );
  if (!away.length) return null;

  let far;
  if (kind === 'debit') {
    far = byDeltaTarget(away, config.entries.delta.debitSell) || away[0];
  } else {
    // Credit: among wings whose max loss fits the risk budget, take the one
    // collecting the most credit. Wider wings = more credit but more risk.
    let best = null;
    for (const w of away) {
      const wWidth = Math.abs(w.strike - near.strike);
      const wNet = near.mid - w.mid;
      if (wNet <= 0.05) continue;
      const wMaxLoss = (wWidth - wNet) * 100;
      if (wMaxLoss <= 0 || wMaxLoss > riskBudget) continue;
      if (wNet < wWidth * config.entries.minCreditFractionOfWidth) continue;
      if (!best || wNet > best.net) best = { w, net: wNet };
    }
    if (!best) return null;
    far = best.w;
  }

  const width = Math.abs(far.strike - near.strike);
  const net = near.mid - far.mid; // debit paid, or credit received (sell near, buy far)
  if (net <= 0.05) return null;

  const maxLossPer = kind === 'debit' ? net * 100 : (width - net) * 100;
  if (maxLossPer <= 0) return null;
  const contracts = Math.floor(riskBudget / maxLossPer);
  if (contracts < 1) return null;

  const legs = kind === 'debit'
    ? [
        { action: 'buy', type, expiry, strike: near.strike, contracts, mid: near.mid, bid: near.bid, ask: near.ask, delta: near.delta, iv: near.iv, gamma: near.gamma ?? null, theta: near.theta ?? null, vega: near.vega ?? null, openInterest: near.openInterest },
        { action: 'sell', type, expiry, strike: far.strike, contracts, mid: far.mid, bid: far.bid, ask: far.ask, delta: far.delta, iv: far.iv, gamma: far.gamma ?? null, theta: far.theta ?? null, vega: far.vega ?? null, openInterest: far.openInterest },
      ]
    : [
        { action: 'sell', type, expiry, strike: near.strike, contracts, mid: near.mid, bid: near.bid, ask: near.ask, delta: near.delta, iv: near.iv, gamma: near.gamma ?? null, theta: near.theta ?? null, vega: near.vega ?? null, openInterest: near.openInterest },
        { action: 'buy', type, expiry, strike: far.strike, contracts, mid: far.mid, bid: far.bid, ask: far.ask, delta: far.delta, iv: far.iv, gamma: far.gamma ?? null, theta: far.theta ?? null, vega: far.vega ?? null, openInterest: far.openInterest },
      ];

  const structure = kind === 'debit'
    ? (bullish ? 'call_debit_spread' : 'put_debit_spread')
    : (bullish ? 'put_credit_spread' : 'call_credit_spread');

  return {
    ...ticketBase(signal, structure),
    legs,
    width,
    [kind === 'debit' ? 'netDebit' : 'netCredit']: +(net * contracts * 100).toFixed(2),
    maxLoss: +(maxLossPer * contracts).toFixed(2),
    plannedRisk: +(maxLossPer * contracts).toFixed(2),
    maxGain: kind === 'debit' ? +((width - net) * contracts * 100).toFixed(2) : +(net * contracts * 100).toFixed(2),
    dte: near.dte,
  };
}

// Quote-quality check: when the market is closed (or the feed is degraded),
// most tradeable-delta contracts show empty bids. Building tickets from the
// few weird survivors produces garbage — refuse instead.
function chainUsable(chain) {
  const relevant = chain.contracts.filter(
    (c) => c.dte >= 15 && c.dte <= 70 && c.delta != null &&
      Math.abs(c.delta) >= 0.25 && Math.abs(c.delta) <= 0.75
  );
  if (relevant.length < 6) return false;
  const quoted = relevant.filter((c) => c.bid > 0 && c.mid != null);
  return quoted.length / relevant.length >= 0.5;
}

// Main entry: turn a scanner signal into the best available ticket, or a
// {skipped, reason} record when discipline says stand aside.
export function buildTicket(signal, riskBudget) {
  if (!signal.chain) return { skipped: true, symbol: signal.symbol, reason: 'no chain data' };
  if (signal.direction === 'neutral') return { skipped: true, symbol: signal.symbol, reason: 'no directional edge' };
  if (!chainUsable(signal.chain))
    return { skipped: true, symbol: signal.symbol, reason: 'options quotes degraded (market closed?) — rescan 9:45am-4pm ET' };

  const spreadsOk = config.approvals.canTradeSpreads;

  if (signal.ivRegime === 'rich') {
    if (spreadsOk) {
      const t = buildVertical(signal, riskBudget, 'credit');
      if (t) return t;
      return { skipped: true, symbol: signal.symbol, reason: 'rich IV but no viable credit spread' };
    }
    return { skipped: true, symbol: signal.symbol, reason: 'IV rich vs HV — refusing to overpay for premium (need spread approval to sell it)' };
  }

  if (signal.ivRegime === 'cheap' || !spreadsOk) {
    const t = buildLong(signal, riskBudget);
    if (t) return t;
    return { skipped: true, symbol: signal.symbol, reason: 'no affordable liquid contract at target delta' };
  }

  // normal regime with spread approval: prefer defined-risk debit spread
  const t = buildVertical(signal, riskBudget, 'debit') || buildLong(signal, riskBudget);
  if (t) return t;
  return { skipped: true, symbol: signal.symbol, reason: 'no viable structure passed liquidity/sizing filters' };
}
