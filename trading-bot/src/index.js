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
import { scanUniverse, marketRegime, atmIV } from './scanner.js';
import { getOptionsChain } from './marketdata.js';
import { discoverUniverse } from './universe.js';
import { earningsCheck } from './earnings.js';
import { buildTicket } from './strategies.js';
import { riskBudget, validateTicket, dayTradesInWindow, tierFor } from './risk.js';
import { loadPortfolio, savePortfolio, loadTickets, saveTickets, equity } from './portfolio.js';
import { executeTicketPaper, markPosition, exitDecision, closePositionPaper, settleExpiredBlind } from './paper.js';
import { performance, fmtMoney } from './report.js';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'status';
const asJson = args.includes('--json');

const DATA_ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data');
const HEARTBEAT = path.join(DATA_ROOT, 'heartbeat.json');

// Dead-man switch: the worst failure mode isn't a bad trade — it's an open
// position sitting unmanaged because the scheduler silently stopped. Every
// autopilot run stamps a heartbeat; every run checks the previous one.
function checkHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT)) return;
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
    const ageHours = (Date.now() - new Date(hb.lastRunAt)) / 3600000;
    const day = new Date().getUTCDay(); // Sun=0, Mon=1
    const allowed = (day === 0 || day === 1) ? 80 : 30; // weekend gap is normal
    if (ageHours > allowed) {
      console.log(`⚠ DEAD-MAN WARNING: last autopilot heartbeat was ${ageHours.toFixed(0)}h ago (allowed ${allowed}h) — scheduled runs may have been silently failing. Check the routine and recent commits.`);
    }
  } catch { /* best effort */ }
}

function writeHeartbeat(portfolio) {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(HEARTBEAT, JSON.stringify({
      lastRunAt: new Date().toISOString(),
      equity: +equity(portfolio).toFixed(2),
      openPositions: portfolio.positions.length,
    }, null, 2));
  } catch { /* best effort */ }
}

const out = (obj, human) => console.log(asJson ? JSON.stringify(obj, null, 2) : human);

async function cmdScan() {
  const portfolio = loadPortfolio();
  const budget = riskBudget(portfolio);
  const { universe, note } = await discoverUniverse();
  console.error(`Scanning ${universe.length} symbols (risk budget $${budget.toFixed(2)}/trade) — ${note}`);

  const { results, errors } = await scanUniverse(universe);
  for (const e of errors) console.error(`  ! ${e.symbol}: ${e.error}`);

  const regime = config.entries.marketRegimeFilter ? await marketRegime() : 'neutral';
  if (regime !== 'neutral') console.error(`Market regime (SPY): ${regime}trend — ${regime === 'up' ? 'bearish' : 'bullish'} entries blocked`);

  const candidates = results.filter((s) => s.direction !== 'neutral' && s.score >= config.entries.minScore);
  const tickets = [];
  const skips = [];
  for (const signal of candidates) {
    if (tickets.length >= config.entries.maxTicketsPerScan) break;
    if ((regime === 'down' && signal.direction === 'bullish') || (regime === 'up' && signal.direction === 'bearish')) {
      skips.push({ skipped: true, symbol: signal.symbol, reason: `market regime: SPY ${regime}trend — no ${signal.direction} entries against the tape` });
      continue;
    }
    const t = buildTicket(signal, budget);
    if (t.skipped) { skips.push(t); continue; }
    const v = validateTicket(t, portfolio);
    t.validation = v;
    if (!v.ok) { skips.push({ skipped: true, symbol: t.symbol, reason: v.failures.join('; ') }); continue; }
    // Never hold long premium through an earnings print.
    const e = await earningsCheck(t);
    t.earningsDate = e.date;
    if (e.block) { skips.push({ skipped: true, symbol: t.symbol, reason: e.reason }); continue; }
    if (e.warning) v.warnings.push(e.warning);
    tickets.push(t);
  }
  saveTickets(tickets);

  // Journal today's ATM IV per symbol — free feeds have no IV history, so we
  // build our own. Months of these snapshots unlock honest IV-rank signals
  // and credit-spread research that the backtester can't do today.
  try {
    const jf = path.join(DATA_ROOT, 'iv-history.jsonl');
    fs.mkdirSync(path.dirname(jf), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const existing = fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : '';
    // De-bias the dataset: the scanner only fetches chains for signal-worthy
    // symbols, which would record IV only on interesting days (selection
    // bias). For the STATIC universe, fetch the chain regardless so every
    // symbol gets a daily observation. Cache makes repeats cheap.
    for (const s of results) {
      if (s.atmIV == null && s.hv20 > 0 && config.universe.includes(s.symbol)) {
        try {
          const chain = await getOptionsChain(s.symbol);
          const iv = atmIV(chain);
          if (iv) { s.atmIV = iv; s.ivOverHv = iv / s.hv20; }
        } catch { /* best effort — never blocks trading */ }
      }
    }
    const add = results
      .filter((s) => s.atmIV && s.ivOverHv && !existing.includes(`"date":"${today}","symbol":"${s.symbol}"`))
      .map((s) => JSON.stringify({ date: today, symbol: s.symbol, close: s.close, hv20: +s.hv20.toFixed(4), atmIV: +s.atmIV.toFixed(4), ivOverHv: +s.ivOverHv.toFixed(3) }));
    if (add.length) {
      fs.appendFileSync(jf, add.join('\n') + '\n');
      console.error(`IV journal: recorded ${add.length} symbol(s) for ${today}`);
    }
  } catch { /* journaling is best-effort, never blocks trading */ }

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
    if (t.earningsDate) console.log(`   earnings: ${t.earningsDate} (after expiry — clear)`);
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
  for (const pos of [...portfolio.positions]) {
    try {
      await markPosition(pos);
    } catch (e) {
      // Chain fetch failed entirely (delisting, symbol change, feed outage).
      // The position must still be time-managed with data-free facts.
      pos.markFailures = (pos.markFailures || 0) + 1;
      console.log(`  ! could not mark ${pos.symbol} (failure #${pos.markFailures}): ${e.message}`);
      const blind = settleExpiredBlind(pos, portfolio);
      if (blind.settled) {
        console.log(`  SETTLED ${pos.symbol} blind: all legs expired with no market data — realized ${fmtMoney(blind.realizedPnl)} (conservative total loss)`);
      } else if (pos.markFailures >= 3) {
        console.log(`  ⚠ ${pos.symbol} has failed to mark ${pos.markFailures} runs in a row — investigate (delisted? renamed?)`);
      }
      continue;
    }
    const d = exitDecision(pos);
    actions.push({ id: pos.id, symbol: pos.symbol, structure: pos.structure, unrealizedPnl: pos.unrealizedPnl, dte: pos.dte, ...d });
  }
  savePortfolio(portfolio);

  for (const a of actions) {
    const icon = a.action === 'close' ? '→ CLOSE' : a.action === 'flag' ? '⚑ FLAG ' : '  hold ';
    console.log(`${icon} [${a.id}] ${a.symbol} ${a.structure}  uP&L ${fmtMoney(a.unrealizedPnl)}  ${a.dte} DTE  — ${a.reason}`);
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
  let netDelta = 0, bull = 0, bear = 0;
  for (const p of portfolio.positions) {
    console.log(`  [${p.id}] ${p.symbol} ${p.structure}  in ${fmtMoney(p.entryValue)}  now ${fmtMoney(p.currentValue)}  uP&L ${fmtMoney(p.unrealizedPnl)}  opened ${p.openedAt.slice(0, 10)}${p.markStale ? '  [STALE MARK]' : ''}`);
    const spot = p.spotAtMark ?? p.spot ?? 0;
    for (const leg of p.legs) {
      if (leg.delta == null) continue;
      netDelta += (leg.action === 'buy' ? 1 : -1) * leg.delta * leg.contracts * 100 * spot;
    }
    if (p.direction === 'bullish') bull++; else if (p.direction === 'bearish') bear++;
  }
  if (portfolio.positions.length) {
    console.log(`Book exposure: net delta ${fmtMoney(netDelta)} of underlying (${bull} bullish / ${bear} bearish) — the book's aggregate directional bet`);
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

  // --detail: the verdict-day breakdowns — which scores, regimes, and
  // structures actually carried the record. This is where conviction-based
  // sizing either earns its evidence or dies.
  if (args.includes('--detail') && portfolio.closed.length) {
    const stats = (trades) => {
      const wins = trades.filter((t) => t.realizedPnl > 0);
      const gw = wins.reduce((a, t) => a + t.realizedPnl, 0);
      const gl = Math.abs(trades.filter((t) => t.realizedPnl <= 0).reduce((a, t) => a + t.realizedPnl, 0));
      return `n=${String(trades.length).padStart(2)}  win ${((wins.length / trades.length) * 100).toFixed(0).padStart(3)}%  PF ${gl > 0 ? (gw / gl).toFixed(2) : '—'}  total ${fmtMoney(trades.reduce((a, t) => a + t.realizedPnl, 0))}`;
    };
    const groupBy = (arr, keyFn) => arr.reduce((m, t) => { const k = keyFn(t) ?? '—'; (m[k] ??= []).push(t); return m; }, {});
    const dims = [
      ['structure', (t) => t.structure],
      ['direction', (t) => t.direction],
      ['iv regime', (t) => t.ivRegime],
      ['score', (t) => t.score == null ? null : t.score >= 85 ? '85+' : t.score >= 75 ? '75-84' : '65-74'],
      ['exit', (t) => (t.closeReason || '').split(':')[0]],
    ];
    for (const [name, fn] of dims) {
      console.log(`\nBy ${name}:`);
      for (const [k, trades] of Object.entries(groupBy(portfolio.closed, fn))) {
        console.log(`  ${k.padEnd(24)} ${stats(trades)}`);
      }
    }
    const slip = portfolio.closed.reduce((a, t) => a + (t.entrySlippageCost || 0) + (t.exitSlippageCost || 0), 0);
    console.log(`\nModeled slippage paid across closed trades: ${fmtMoney(slip)} — compare against real fills at go-live`);
  }
}

async function cmdBacktest() {
  const { backtest, CAVEATS } = await import('./backtest.js');
  const daysArg = args.find((a) => a.startsWith('--days='));
  const offsetArg = args.find((a) => a.startsWith('--offset='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 750;
  const offset = offsetArg ? parseInt(offsetArg.split('=')[1], 10) : 0;
  const regimeFilter = !args.includes('--no-regime') && config.entries.marketRegimeFilter;
  const stratArg = args.find((a) => a.startsWith('--strategy='));
  const strategy = stratArg ? stratArg.split('=')[1] : 'long';
  console.error(`Backtesting ${config.universe.length} symbols over ~${days} bars${offset ? ` ending ${offset} bars ago (OUT-OF-SAMPLE window)` : ' (recent window — the one the strategy was tuned on)'}${regimeFilter ? ', SPY regime filter ON' : ', regime filter OFF'}, strategy: ${strategy.toUpperCase()}${strategy === 'credit' ? ' (selling 25-delta spreads, ZERO variance-risk-premium assumed)' : ''}...`);
  const r = await backtest({ days, offset, regimeFilter, strategy });
  if (asJson) { out(r, ''); return; }
  const { closed, ...stats } = r;
  console.log(`\nSymbols with data: ${stats.symbols.join(', ')}`);
  console.log(`Period:            ${stats.tradingDays} trading days (~${(stats.tradingDays / 252).toFixed(1)}y)`);
  console.log(`Equity:            ${fmtMoney(stats.startingEquity)} -> ${fmtMoney(stats.finalEquity)}  (${stats.totalReturnPct >= 0 ? '+' : ''}${stats.totalReturnPct}%, CAGR ${stats.cagrPct}%)`);
  console.log(`Max drawdown:      ${stats.maxDrawdownPct}%`);
  console.log(`Trades:            ${stats.trades}  win rate ${stats.winRate ?? '—'}%  avg win ${fmtMoney(stats.avgWin)}  avg loss ${fmtMoney(stats.avgLoss)}  PF ${stats.profitFactor ?? '—'}`);
  console.log(`Exits:             ${Object.entries(stats.exitBreakdown).map(([k, v]) => `${k} x${v}`).join(', ') || '—'}`);
  console.log('\nCaveats:');
  for (const c of CAVEATS) console.log(`  - ${c}`);
}

// One-shot daily cycle for scheduled runs: manage exits first (frees slots),
// then scan for new setups, then paper-execute whatever passed every gate.
// PAPER ONLY by design — live orders always go through human confirmation.
async function cmdAutopilot() {
  console.log(`\n=== autopilot run ${new Date().toISOString()} ===`);
  checkHeartbeat();
  console.log('--- manage open positions ---');
  await cmdManage();
  console.log('--- scan for setups ---');
  await cmdScan();
  // Unattended runs must not violate the earnings discipline: tickets whose
  // earnings date is unknown are HELD, not bought. The operator (human or the
  // scheduled Claude routine) verifies the date and flips them back to
  // "pending" only when earnings fall after expiry.
  const heldTickets = loadTickets();
  let held = 0;
  for (const t of heldTickets) {
    if (t.status === 'pending' && t.validation?.warnings?.some((w) => w.includes('earnings date unknown'))) {
      t.status = 'needs_earnings_verification';
      held++;
    }
  }
  if (held) {
    saveTickets(heldTickets);
    console.log(`HELD ${held} ticket(s) pending earnings verification — if the company's next earnings date is AFTER the option expiry, set status back to "pending" in trading-bot/data/tickets.json and re-run paper-buy; otherwise discard.`);
  }
  console.log('--- paper-execute passing tickets ---');
  await cmdPaperBuy();
  console.log('--- portfolio after run ---');
  await cmdStatus();
  writeHeartbeat(loadPortfolio());
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

const commands = { scan: cmdScan, tickets: cmdTickets, 'paper-buy': cmdPaperBuy, manage: cmdManage, status: cmdStatus, report: cmdReport, backtest: cmdBacktest, autopilot: cmdAutopilot, reset: cmdReset };
const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\nCommands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
