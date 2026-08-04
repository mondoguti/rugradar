// Central configuration for the options bot.
// Every risk number here is a hard limit enforced by src/risk.js — the bot
// refuses to produce a ticket that violates them.

export default {
  account: {
    startingEquity: 500,        // paper account starting balance (USD)
  },

  // Liquid, optionable underlyings. ETFs first (tightest spreads), then
  // lower-priced liquid names where a $500 account can actually afford premium.
  universe: [
    'SPY', 'QQQ', 'IWM',
    'AAPL', 'AMD', 'INTC', 'PLTR', 'HOOD',
    'SOFI', 'F', 'BAC', 'T', 'AAL', 'RIVN', 'MARA',
  ],

  // Dynamic discovery: each scan also pulls trending / most-active / top-gainer
  // tickers and runs them through the SAME signal and risk gates as the static
  // list. Widens the funnel; never lowers the bar.
  discovery: {
    enabled: true,
    max: 10,                    // at most this many discovered names per scan
    maxTotal: 25,               // hard cap on total universe size
    priceRange: [3, 300],       // skip junk (<$3) and unaffordable (>$300) movers
  },

  risk: {
    // Graduated sizing — the rinse-and-repeat schedule. As equity compounds,
    // dollars risked per trade (and therefore contract counts) grow
    // automatically, while the PERCENTAGE risked steps down because there's
    // more account to protect. Position slots also unlock with size.
    //   $500 start:  10% = $50/trade, 2 positions
    //   at $2,000:  7.5% = $150/trade, 3 positions
    //   at $10,000:   5% = $500/trade, 4 positions
    tiers: [
      { upToEquity: 1000,     riskPct: 0.10,  maxPositions: 2 },
      { upToEquity: 5000,     riskPct: 0.075, maxPositions: 3 },
      { upToEquity: Infinity, riskPct: 0.05,  maxPositions: 4 },
    ],
    maxDeployedPct: 0.40,       // at most 40% of equity in open premium at once
    // Same-direction positions within a group are one bet in two costumes —
    // the validator rejects the second one.
    correlatedGroups: [
      ['SPY', 'QQQ', 'IWM'],
      ['AMD', 'INTC'],
      ['SOFI', 'HOOD', 'BAC'],
      ['F', 'RIVN'],
    ],
    dailyLossLimitPct: 0.10,    // stop opening new trades after -10% day
    pdt: {
      enabled: true,            // accounts under $25k: max 3 day trades per 5 trading days
      maxDayTrades: 3,
      windowDays: 5,
    },
  },

  entries: {
    minScore: 60,               // signal score 0-100 required to trade
    maxTicketsPerScan: 3,
    dte: {                      // days-to-expiration windows per structure
      long: [25, 60],
      debitSpread: [21, 45],
      creditSpread: [21, 45],
    },
    delta: {                    // strike selection targets (absolute delta)
      longEntry: 0.55,
      longMin: 0.35,            // NEVER buy below this — far-OTM "cheap" options are lottery tickets
      debitBuy: 0.55,
      debitSell: 0.30,
      creditSell: 0.25,
      nearTolerance: 0.15,      // reject if best liquid strike is further than this from target
    },
    maxSpreadWidth: 5,          // max $ width between spread strikes
    minCreditFractionOfWidth: 0.25, // credit spreads must collect >=25% of width or skip
    liquidity: {
      minOpenInterest: 100,
      minBid: 0.05,
      maxBidAskPctOfMid: 0.18,  // reject contracts with spreads wider than 18% of mid
    },
    ivRegime: {                 // ATM IV divided by 20-day historical volatility
      rich: 1.25,               // above this: premium is expensive -> sell it (spreads) or stand aside
      cheap: 0.90,              // below this: premium is cheap -> buying is acceptable
    },
  },

  exits: {
    // Let winners RUN: when a long/debit position reaches armAtPct, instead of
    // taking profit it arms a trailing stop — the trade stays on as long as
    // the move continues, and closes only after giving back giveBackPct of its
    // peak gain. Asymmetric exits are where outsized winners come from.
    trailing: {
      enabled: true,
      armAtPct: 0.60,           // arm the trail at +60% on the position
      giveBackPct: 0.35,        // close after retracing 35% from peak P&L
    },
    profitTargetPct: {
      long: 0.75,               // fixed target used only when trailing is disabled
      debitSpread: 0.60,        // spreads have capped max gain — fixed targets stay
      creditSpread: 0.50,       // buy back credit spreads at 50% of credit captured
    },
    stopLossPct: {
      long: 0.50,               // close long options at -50% of debit paid
      debitSpread: 0.50,
      creditSpread: 1.00,       // close credit spreads when loss equals credit received
    },
    timeExitDTE: 7,             // never hold long premium inside 7 DTE (gamma/theta burn)
    maxHoldDays: 30,
  },

  // Robinhood options approval levels: Level 2 = long calls/puts only.
  // Level 3 adds spreads. Flip this to true ONLY after Robinhood approves you
  // for spreads, otherwise credit/debit spread tickets are useless.
  approvals: {
    canTradeSpreads: false,
  },

  data: {
    riskFreeRate: 0.04,         // used for Black-Scholes greeks fallback
    historyDays: 150,
    slippage: 0.25,             // paper fills assume you give up 25% of the half-spread
  },
};
