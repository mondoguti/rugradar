# Options Trading Bot

A defined-risk options trading system sized for a small ($500) account. It scans
a universe of liquid underlyings, generates directional signals, picks the right
options structure for the volatility regime, sizes positions against hard risk
limits, and manages exits mechanically. Execution is paper-first; live orders go
through the **Robinhood Trading MCP** with Claude Code as the operator and you
confirming every order.

## Read this first — honest expectations

- **No bot guarantees profits.** Most retail options traders lose money. Anyone
  selling you a "best in the world" bot is selling you a story. What this system
  gives you is what actually separates survivors from blown-up accounts:
  position sizing, defined risk, mechanical exits, and a refusal to trade when
  conditions are bad.
- **$500 in options is the hard mode.** One bad undisciplined trade can take
  30%+ of the account. That's why every limit in `config.js` is enforced in
  code: max $50 risk per trade, max 2 positions, max 40% deployed, daily loss
  limit, PDT tracking.
- **Scaling is automatic (rinse and repeat).** Position sizing is a percentage
  of *current* equity, so contract counts compound as the account grows — and
  the percentage steps down as there's more to protect:

  | Equity | Risk per trade | Position slots |
  |---|---|---|
  | up to $1,000 | 10% | 2 |
  | $1,000–$5,000 | 7.5% | 3 |
  | above $5,000 | 5% | 4 |

  At $500 that's ~$50/trade and single cheap contracts. At $2,000 it's
  $150/trade — better underlyings, multiple contracts. At $10,000 it's
  $500/trade across 4 positions. Same rules, bigger numbers. Deposits count
  toward equity the same as gains.
- **The realistic goal for year one is to still be trading** — with a growing
  account and 50+ logged trades telling you what your edge actually is. Compounding
  small edges beats swinging for home runs.
- **Paper trade first. 20+ trades minimum.** The bot makes this the default;
  live execution requires deliberate extra steps. If the system can't beat
  paper, it has no business touching real money.

## How it decides

0. **Universe** (`src/universe.js`) — the curated static list PLUS up to 10
   dynamically discovered movers per scan (trending tickers, most actives, top
   gainers, filtered to $3–$300). Hot names get found automatically — and then
   have to survive the exact same gates as everything else.
   **Earnings guard** (`src/earnings.js`): any ticket whose expiry spans a
   known earnings date is skipped outright. Buying options into an earnings
   print means paying peak IV for a move everyone expects — the post-print IV
   collapse loses money even when the direction was right. The bot trades hot
   stocks' *trends*; it does not gamble their announcements.
1. **Signal** (`src/scanner.js`) — daily bars → trend (EMA20/EMA50), momentum
   (RSI), pullback quality (distance from EMA20 in ATRs), dollar-volume
   liquidity. Produces direction + 0–100 score. Score ≥ 60 required.
2. **Volatility regime** (`IV/HV`) — ATM implied volatility vs 20-day realized:
   - **cheap** (≤0.90): buying premium is acceptable → long call/put
   - **normal**: defined-risk debit spread (falls back to long without spread approval)
   - **rich** (≥1.25): premium should be *sold*, not bought → credit spread, or
     **stand aside** if you don't have spread approval. The bot refusing to
     trade is a feature.
3. **Structure** (`src/strategies.js`) — strike selection by delta targets
   (long ~0.55Δ; credit spreads sell ~0.25Δ), liquidity filters (OI ≥ 100,
   tight bid/ask), DTE windows (25–60 long, 21–45 spreads), credit spreads must
   collect ≥25% of width.
4. **Risk gate** (`src/risk.js`) — every ticket is validated against equity,
   cash, position count, deployment cap, daily loss limit, and PDT status
   before it can be executed. Tickets that fail are discarded, not shrunk.
5. **Exits** (`src/paper.js`) — mechanical, and for long options they live on
   the CHART, not the option price (premium-percentage stops harvest noise —
   the first real backtest proved it). Longs exit when the underlying breaks
   the setup (closes beyond EMA20 by 0.5 ATR against the trade), with a −65%
   hard stop as gap insurance and a trailing stop that lets winners run: at
   +60% the position arms a trail and closes only after giving back 35% from
   peak. Spreads keep fixed targets (capped payoff). Hard time-exit at 7 DTE,
   max hold 30 days. No discretion, no "it might come back".
   Sizing note: a long option's full premium counts as its planned risk.

## Setup

```bash
# nothing to install — Node 18+ and zero dependencies
node trading-bot/src/index.js status
```

Live execution additionally needs the Robinhood pieces (see your Robinhood
"Agentic Trading" settings):

1. A Robinhood **Agentic account** with options approval (Level 2 = long
   calls/puts; Level 3 adds spreads — flip `approvals.canTradeSpreads` in
   `config.js` only after Level 3 approval).
2. On your machine: `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading`
3. In Claude Code run `/mcp`, select `robinhood-trading`, authenticate.

## Daily workflow

```bash
node trading-bot/src/index.js scan       # after market open settles (~10:00 ET)
node trading-bot/src/index.js paper-buy  # execute tickets in the paper account
node trading-bot/src/index.js manage     # daily: mark positions, apply exit rules
node trading-bot/src/index.js status     # portfolio snapshot
node trading-bot/src/index.js report     # win rate, profit factor, P&L
```

Or drive it from Claude Code with the included commands:

| Command | What it does |
|---|---|
| `/bot-scan` | run scanner, sanity-check tickets (earnings, news, spreads) |
| `/bot-execute` | place a reviewed ticket live via Robinhood MCP — asks for confirmation on every order |
| `/bot-manage` | check exits, close live positions (with confirmation) |

Offline/testing mode: `node trading-bot/fixtures/generate.js` then add
`--fixtures` to any command to run against synthetic data.

## How new signals earn their way in (the anti-overfitting protocol)

The strategy's tunables are FROZEN — an overfitting post-mortem proved that
re-tuning on backtests manufactures fake edges. New ideas follow one road:

1. **Journal.** Every scan snapshots the vol surface (ATM IV near/far,
   25-delta skew, term slope), realized-vol estimators, and flow proxies per
   symbol into `data/iv-history.jsonl` — data money can't buy at this price,
   accruing daily.
2. **Label.** ~21 trading days later, each row gets its forward outcomes
   (`data/outcomes.jsonl`): 5/10/21-day returns and realized vol (rv21).
3. **Pre-register.** Every hypothesis lives in `data/pre-registrations.json`
   (append-only) with its exact test, threshold, and minimum sample — written
   BEFORE the data can answer. Rules may be withdrawn, never edited.
4. **Evaluate forward.** `node trading-bot/src/index.js signals` reports each
   rule as PASS / FAIL / INSUFFICIENT_DATA on forward data only.
5. **Activate by hand.** A PASS is necessary, never sufficient: activation
   requires a human commit flipping the named config flag and citing the rule
   id. The evaluator itself can never change behavior.

## Going live (only after paper proves out)

Checklist before the first real order:
- [ ] 20+ paper trades logged, `report` shows positive expectancy (profit factor > 1.2)
- [ ] You understand every trade the bot proposed — including the ones it skipped
- [ ] Robinhood options approval confirmed; `canTradeSpreads` matches your level
- [ ] You accept that the whole $500 is money you can lose

Live rules the commands enforce: limit orders at mid only (never market),
re-quote before placing, stop if price moved >10% from ticket, explicit
human confirmation on every single order.

## Rules that keep a $500 account alive

- **PDT**: under $25k equity you get 3 day trades per 5 trading days. The bot
  tracks them and blocks a 4th. Plan to hold overnight.
- **Never add to losers.** The bot won't; don't override it.
- **One earnings rule**: don't hold long premium through earnings — IV crush
  eats the position even when you're right on direction. Check earnings dates
  before executing (`/bot-scan` asks Claude to flag this).
- **Commissions/fees**: Robinhood options are $0 commission but $0.03–0.04/contract
  regulatory fees apply; the paper broker's slippage model approximates real fill costs.

## Disclaimers

This is not financial advice. Options involve substantial risk of loss and are
not suitable for everyone. Past performance (paper or live) does not guarantee
future results. You are responsible for every order placed through your
brokerage account. Data comes from free delayed feeds (CBOE delayed quotes,
Stooq/Yahoo daily bars) — verify quotes at the broker before executing.
