---
description: Execute a reviewed order ticket LIVE via the Robinhood Trading MCP
---

Execute a pending order ticket from the options bot through the robinhood-trading MCP server. Ticket ID (optional): $ARGUMENTS

SAFETY PROTOCOL — follow every step, in order, no exceptions:

1. Read the pending tickets: `node trading-bot/src/index.js tickets`. If a ticket ID was given, use that one; otherwise list them and ask me which to execute.
2. Re-validate before placing anything:
   - Check my actual Robinhood buying power via the MCP. If it's less than the ticket cost, STOP and tell me.
   - Check current quotes for the contract(s) via the MCP. If the mid has moved more than 10% against the ticket price since it was generated, STOP and show me the difference — stale tickets must be regenerated with /bot-scan, not chased.
   - Confirm the ticket's max loss is still within the risk budget shown in `node trading-bot/src/index.js status`.
3. Show me the final order: symbol, legs, contracts, limit price, total cost, max loss. Ask me to confirm with an explicit yes. NEVER place an order without my confirmation in this conversation, even if I've confirmed other orders before.
4. Place the order as a LIMIT order at the ticket's mid price (or the current mid if better). NEVER use market orders on options.
5. If the order doesn't fill within a reasonable time, ask me before improving the price. Never improve past 40% of the bid/ask spread from mid.
6. After a confirmed fill, record it: update `trading-bot/data/portfolio.json` — move the ticket into positions with the actual fill price (mirror what `executeTicketPaper` in trading-bot/src/paper.js does, using real fill values), set the position's `mode` field to `"live"` (CRITICAL — this is what stops `manage` from auto-closing it in local state while the real position stays open at Robinhood), and mark the ticket status `executed_live`.

If anything in the MCP responses looks unexpected (auth errors, wrong account, unrecognized symbols), STOP and tell me instead of retrying.
