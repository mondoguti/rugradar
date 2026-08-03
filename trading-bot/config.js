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

  risk: {
    maxRiskPerTradePct: 0.10,   // never risk more than 10% of equity on one trade
    maxRiskPerTradeAbs: 60,     // ...and never more than $60 regardless of equity
    maxOpenPositions: 2,        // small account = concentrated attention, not concentrated risk
    maxDeployedPct: 0.40,       // at most 40% of equity in open premium at once
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
      debitBuy: 0.55,
      debitSell: 0.30,
      creditSell: 0.25,
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
    profitTargetPct: {
      long: 0.75,               // close long options at +75%
      debitSpread: 0.60,        // close debit spreads at +60% of max profit potential
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
