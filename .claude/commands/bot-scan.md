---
description: Scan the market for options setups and build order tickets
---

Run the options bot scanner and interpret the results for me.

1. Run: `node trading-bot/src/index.js scan` (the scan auto-discovers trending/most-active movers on top of the static universe, and skips tickets whose expiry spans a known earnings date)
2. Show me the signal table and every generated ticket with its thesis, cost, max loss, and breakeven.
3. For each ticket, give your own independent read: does the setup make sense given current market conditions? Flag anything that looks off (wide bid/ask spreads, news I should know about).
4. CRITICAL — earnings verification: for any ticket marked "earnings date unknown", search the web for the company's next earnings date. If it falls before the option's expiry, tell me to reject the ticket — we never hold long premium through an earnings print (IV crush). Do the same check for discovered "hot" movers, whose dates the free feed often misses.
4. Remind me which tickets are affordable given my current buying power and PDT status (`node trading-bot/src/index.js status`).

Do NOT place any orders. This command is analysis only — execution happens via /bot-execute after I review.
