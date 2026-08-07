---
description: Execute a reviewed order ticket LIVE via the Robinhood Trading MCP
---

Execute a pending order ticket from the options bot through the robinhood-trading MCP server. Ticket ID (optional): $ARGUMENTS

SAFETY PROTOCOL — follow every step, in order, no exceptions:

0. Check the pre-registered go-live gate: `node trading-bot/src/index.js gate --json`.
   If `passed` is `false`, STOP. Tell me the paper record has not yet earned live
   execution (show the gate numbers). Proceeding anyway requires me to explicitly
   say, in this conversation, that I am bypassing the pre-registered gate — and
   you must note that bypass out loud before continuing.
1. Read the pending tickets: `node trading-bot/src/index.js tickets`. If a ticket ID was given, use that one; otherwise list them and ask me which to execute.
2. Re-validate before placing anything:
   - Check my actual Robinhood buying power via the MCP. If it's less than the ticket cost, STOP and tell me.
   - Check current quotes for the contract(s) via the MCP. If the mid has moved more than 10% against the ticket price since it was generated, STOP and show me the difference — stale tickets must be regenerated with /bot-scan, not chased.
   - Confirm the ticket's max loss is still within the risk budget shown in `node trading-bot/src/index.js status`.
3. Show me the final order: symbol, legs, contracts, limit price, total cost, max loss. Ask me to confirm with an explicit yes. NEVER place an order without my confirmation in this conversation, even if I've confirmed other orders before.
4. Place the order as a LIMIT order at the ticket's mid price (or the current mid if better). NEVER use market orders on options.
5. Immediately after the broker ACCEPTS the order (filled or still working), run
   `node trading-bot/src/index.js record-order <ticketId> --confirm` so the
   ticket survives the daily scan rotation until the fill is recorded.
   If the order doesn't fill within a reasonable time, ask me before improving
   the price. Never improve past 40% of the bid/ask spread from mid. If the
   order is canceled unfilled, set the ticket status back manually and tell me.
6. After a confirmed fill, record it with the reconciliation command — NEVER
   hand-edit portfolio.json:
   `node trading-bot/src/index.js record-fill <ticketId> --net=<total dollars> --confirm`
   where net is the TOTAL debit paid (long/debit spread) or TOTAL credit
   received (credit spread) from the actual Robinhood fill. The command
   validates the amount, sets `mode:"live"` (which stops `manage` from
   auto-closing it locally), pays the fee model, logs execution quality vs the
   ticket mid, and marks the ticket `executed_live` — atomically.
   Note: regulatory fees are modeled at $0.04/contract; Robinhood's actual
   pass-through may differ by a cent or two.

If anything in the MCP responses looks unexpected (auth errors, wrong account, unrecognized symbols), STOP and tell me instead of retrying.
