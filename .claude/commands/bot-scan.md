---
description: Scan the market for options setups and build order tickets
---

Run the options bot scanner and interpret the results for me.

1. Run: `node trading-bot/src/index.js scan`
2. Show me the signal table and every generated ticket with its thesis, cost, max loss, and breakeven.
3. For each ticket, give your own independent read: does the setup make sense given current market conditions? Flag anything that looks off (earnings within the DTE window, wide bid/ask spreads, news I should know about).
4. Remind me which tickets are affordable given my current buying power and PDT status (`node trading-bot/src/index.js status`).

Do NOT place any orders. This command is analysis only — execution happens via /bot-execute after I review.
