---
description: Check open positions against exit rules; close what needs closing
---

Manage the options bot's open positions.

1. Run `node trading-bot/src/index.js manage` to mark positions and get hold/close decisions. (In live mode, also cross-check each position's current value against real quotes from the robinhood-trading MCP — the bot's marks use delayed data.)
2. For every position the bot says to CLOSE:
   - If this is a live position, show me the position, the reason, current P&L, and ask for confirmation, then close it via the MCP with a LIMIT order at mid. Never market orders.
   - Respect PDT warnings: if closing would use a day trade we don't have, tell me and recommend holding until tomorrow unless the loss is accelerating.
3. For positions on HOLD, give me a one-line health check each: P&L, DTE, and whether the original thesis still holds.
4. After any live close, record the realized P&L in `trading-bot/data/portfolio.json` (mirror `closePositionPaper` in trading-bot/src/paper.js with real fill values).

Rule of thumb you must enforce: winners get taken at target, losers get cut at stop, and NOTHING long premium is held inside 7 DTE. No "it might come back". The rules exist because emotions don't scale.
