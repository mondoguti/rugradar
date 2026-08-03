#!/usr/bin/env node
// CLI for the options bot.
//
//   node trading-bot/src/index.js scan            find setups, write order tickets
//   node trading-bot/src/index.js tickets         show pending tickets
//   node trading-bot/src/index.js paper-buy       execute pending tickets in the paper account
//   node trading-bot/src/index.js manage          mark positions, apply exit rules (auto-closes in paper)
//   node trading-bot/src/index.js status          portfolio snapshot
//   node trading-bot/src/index.js report          performance stats
//   node trading-bot/src/index.js reset --confirm wipe paper portfolio and start over
//
// Flags: --fixtures (synthetic offline data)  --json (machine-readable output)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { scanUniverse } from './scanner.js';
import { buildTicket } from './strategies.js';
import { riskBudget, validateTicket, dayTradesInWindow, tierFor } from './risk.js';
import { loadPortfolio, savePortfolio, loadTickets, saveTickets, equity } from './portfolio.js';
import { executeTicketPaper, markPosition, exitDecision, closePositionPaper } from './paper.js';
import { performance, fmtMoney } from './report.js';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'status';
const asJson = args.includes('--json');

const out = (obj, human) => console.log(asJson ? JSON.stringify(obj, null, 2) : human);

async function cmdScan() {
  const portfolio = loadPortfolio();
  const budget = riskBudget(portfolio);
  console.error(`Scanning ${config.universe.length} symbols (risk budget $${budget.toFixed(2)}/trade)...`);

  const { results, errors } = await scanUniverse();
  for (const e of errors) console.error(`  ! ${e.symbol}: ${e.error}`);

  const candidates = results.filter((s) => s.direction !== 'neutral' && s.score >= config.entries.minScore);
  const tickets = [];
  const skips = [];
  for (const signal of candidates) {
    if (tickets.length >= config.entries.maxTicketsPerScan) break;
    const t = buildTicket(signal, budget);
    if (t.skipped) { skips.push(t); continue; }
    const v = validateTicket(t, portfolio);
    t.validation = v;
    if (v.ok) tickets.push(t); else skips.push({ skipped: true, symbol: t.symbol, reason: v.failures.join('; ') });
  }
  saveTickets(tickets);

  if (asJson) {
    out({ signals: results.map(({ chain, ...s }) => s), tickets, skips }, '');
    return;
  }

  console.log('\n=== SIGNALS ===');
  for (const s of results) {
    const flag = s.score >= config.entries.minScore && s.direction !== 'neutral' ? '●' : ' ';
    console.log(`${flag} ${s.symbol.padEnd(6)} ${s.direction.padEnd(8)} score ${String(s.score).padStart(3)}  close ${s.close.toFixed(2).padStart(8)}  RSI ${s.rsi.toFixed(0).padStart(3)}  IV/HV ${s.ivOverHv ? s.ivOverHv.toFixed(2) : ' — '} ${s.ivRegime !== 'unknown' ? `(${s.ivRegime})` : ''}`);
  }

  console.log(`\n=== TICKETS (${tickets.length}) ===`);
  for (const t of tickets) {
    console.log(`\n[${t.id}] ${t.symbol} ${t.structure.toUpperCase()} — score ${t.score}, ${t.dte} DTE`);
    for (const leg of t.legs) {
      console.log(`   ${leg.action.toUpperCase()} ${leg.contracts}x ${t.symbol} ${leg.expiry} $${leg.strike} ${leg.type} @ ~$${leg.mid.toFixed(2)} (Δ${leg.delta?.toFixed(2)}, OI ${leg.openInterest})`);
    }
    console.log(`   cost ${fmtMoney(t.netDebit ?? -t.netCredit)}  max loss ${fmtMoney(t.maxLoss)}  max gain ${t.maxGain ? fmtMoney(t.maxGain) : 'uncapped'}${t.breakeven ? `  breakeven $${t.breakeven}` : ''}`);
    console.log(`   thesis: ${t.thesis}`);
    for (const w of t.validation.warnings) console.log(`   ⚠ ${w}`);
  }
  if (!tickets.length) console.log('  (none — nothing met the bar today. Not trading IS a position.)');

  if (skips.length) {
    console.log('\n=== STOOD ASIDE ===');
    for (const s of skips) console.log(`  ${s.symbol}: ${s.reason}`);
  }
  console.log('\nNext: review tickets, then `npm run bot paper-buy` (paper) or /bot-execute in Claude Code (live).');
}

async function cmdTickets() {
  const tickets = loadTickets();
  out(tickets, tickets.length ? JSON.stringify(tickets, null, 2) : 'No pending tickets. Run `npm run bot scan` first.');
}

async function cmdPaperBuy() {
  const portfolio = loadPortfolio();
  const tickets = loadTickets().filter((t) => t.status === 'pending');
  if (!tickets.length) { console.log('No pending tickets. Run scan first.'); return; }
  const executed = [];
  for (const t of tickets) {
    const v = validateTicket(t, portfolio);
    if (!v.ok) { console.log(`SKIP [${t.id}] ${t.symbol}: ${v.failures.join('; ')}`); continue; }
    const pos = executeTicketPaper(t, portfolio);
    t.status = 'executed_paper';
    executed.push(pos);
    console.log(`FILLED [${t.id}] ${t.symbol} ${t.structure} — paid ${fmtMoney(pos.entryValue)} (cash left ${fmtMoney(portfolio.cash)})`);
  }
  saveTickets(loadTickets().map((t) => tickets.find((x) => x.id === t.id) || t));
  if (asJson) out({ executed }, '');
}

async function cmdManage() {
  const portfolio = loadPortfolio();
  if (!portfolio.positions.length) { console.log('No open positions.'); return; }
  const actions = [];
  for (const pos of portfolio.positions) {
    try {
      await markPosition(pos);
    } catch (e) {
      console.log(`  ! could not mark ${pos.symbol}: ${e.message}`);
      continue;
    }
    const d = exitDecision(pos);
    actions.push({ id: pos.id, symbol: pos.symbol, structure: pos.structure, unrealizedPnl: pos.unrealizedPnl, dte: pos.dte, ...d });
  }
  savePortfolio(portfolio);

  for (const a of actions) {
    console.log(`${a.action === 'close' ? '→ CLOSE' : '  hold '} [${a.id}] ${a.symbol} ${a.structure}  uP&L ${fmtMoney(a.unrealizedPnl)}  ${a.dte} DTE  — ${a.reason}`);
  }

  const toClose = actions.filter((a) => a.action === 'close');
  for (const a of toClose) {
    const pos = portfolio.positions.find((p) => p.id === a.id);
    if (!pos) continue;
    // NEVER auto-close a live position in local state — the real position
    // would stay open at the broker. Live closes go through /bot-manage
    // (Robinhood MCP), which records the actual fill afterwards.
    if (pos.mode === 'live') {
      console.log(`  LIVE position ${a.symbol}: close it via /bot-manage in Claude Code, then record the real fill`);
      continue;
    }
    const r = closePositionPaper(pos, portfolio, a.reason);
    if (r.blocked) console.log(`  BLOCKED closing ${a.symbol}: ${r.reason}`);
    else console.log(`  CLOSED ${a.symbol} for ${fmtMoney(r.realizedPnl)} realized`);
  }
  if (asJson) out({ actions }, '');
}

async function cmdStatus() {
  const portfolio = loadPortfolio();
  const eq = equity(portfolio);
  const dt = dayTradesInWindow(portfolio);
  if (asJson) { out({ equity: eq, ...portfolio }, ''); return; }
  const tier = tierFor(eq);
  console.log(`Equity ${fmtMoney(eq)}  (cash ${fmtMoney(portfolio.cash)}, started ${fmtMoney(portfolio.startingEquity)})`);
  console.log(`Sizing tier: ${(tier.riskPct * 100).toFixed(1)}% risk/trade = ${fmtMoney(eq * tier.riskPct)} budget, ${tier.maxPositions} position slots`);
  console.log(`Day trades used: ${dt}/${config.risk.pdt.maxDayTrades} in rolling window`);
  console.log(`Open positions: ${portfolio.positions.length}/${tier.maxPositions}`);
  for (const p of portfolio.positions) {
    console.log(`  [${p.id}] ${p.symbol} ${p.structure}  in ${fmtMoney(p.entryValue)}  now ${fmtMoney(p.currentValue)}  uP&L ${fmtMoney(p.unrealizedPnl)}  opened ${p.openedAt.slice(0, 10)}`);
  }
}

async function cmdReport() {
  const portfolio = loadPortfolio();
  const p = performance(portfolio);
  if (asJson) { out(p, ''); return; }
  console.log(`Equity:        ${fmtMoney(p.equity)} (${p.totalReturnPct >= 0 ? '+' : ''}${p.totalReturnPct}%)`);
  console.log(`Realized P&L:  ${fmtMoney(p.realizedPnl)} over ${p.closedTrades} closed trades`);
  console.log(`Win rate:      ${p.winRate ?? '—'}%   avg win ${fmtMoney(p.avgWin)}   avg loss ${fmtMoney(p.avgLoss)}   profit factor ${p.profitFactor ?? '—'}`);
  console.log(`Open:          ${p.openPositions} position(s)`);
  if (p.closedTrades < 20) console.log(`\nNote: ${p.closedTrades} trades is not statistical evidence. 20+ paper trades minimum before judging the system — or going live.`);
}

async function cmdReset() {
  if (!args.includes('--confirm')) { console.log('This wipes the paper portfolio. Re-run with --confirm.'); return; }
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const f of ['portfolio.json', 'tickets.json']) {
    const p = path.join(ROOT, 'data', f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log('Paper portfolio reset.');
}

const commands = { scan: cmdScan, tickets: cmdTickets, 'paper-buy': cmdPaperBuy, manage: cmdManage, status: cmdStatus, report: cmdReport, reset: cmdReset };
const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\nCommands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
