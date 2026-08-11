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
import { getOptionsChain, useFixtures } from './marketdata.js';
import { discoverUniverse } from './universe.js';
import { earningsCheck } from './earnings.js';
import { buildTicket } from './strategies.js';
import { riskBudget, validateTicket, dayTradesInWindow, tierFor, governorState } from './risk.js';
import { loadPortfolio, savePortfolio, loadTickets, saveTickets, equity, etDay, writeJsonAtomic, appendOpsLog, readOpsLog, updateHighWater } from './portfolio.js';
import { executeTicketPaper, markPosition, exitDecision, closePositionPaper, settleExpiredBlind, recordLiveFill, recordLiveClose } from './paper.js';
import { performance, gateStatus, fmtMoney } from './report.js';
import { buildJournalRow, backfillOutcomes } from './journal.js';
import { nextEvent, eventsBetween, coverageWarnings } from './calendar.js';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'status';
const asJson = args.includes('--json');

const DATA_ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), useFixtures() ? 'data-fixtures' : 'data');
const HEARTBEAT = path.join(DATA_ROOT, 'heartbeat.json');
if (useFixtures()) console.error('FIXTURES MODE — all state under trading-bot/data-fixtures/; the real record is untouched.');

// Dead-man switch: the worst failure mode isn't a bad trade — it's an open
// position sitting unmanaged because the scheduler silently stopped. Every
// autopilot run stamps a heartbeat; every run checks the previous one.
function checkHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT)) return;
    let hb;
    try {
      hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
    } catch (e) {
      // Fail LOUD, never silent: an unreadable heartbeat means scheduler
      // health cannot be verified — exactly when the warning matters most.
      console.log(`⚠ DEAD-MAN WARNING: heartbeat unreadable (${e.message}) — scheduler health unverifiable; check recent commits`);
      return;
    }
    const day = new Date().getUTCDay(); // Sun=0, Mon=1
    const allowed = (day === 0 || day === 1) ? 80 : 30; // weekend gap is normal
    const ageCheck = (stamp, what) => {
      if (!stamp) return;
      const ageHours = (Date.now() - new Date(stamp)) / 3600000;
      if (ageHours > allowed) {
        console.log(`⚠ DEAD-MAN WARNING: ${what} was ${ageHours.toFixed(0)}h ago (allowed ${allowed}h) — scheduled runs may have been silently failing. Check the routine and recent commits.`);
      }
    };
    ageCheck(hb.lastRunAt, 'the last heartbeat of any kind');
    ageCheck(hb.lastManageAt, 'the last MANAGE leg (open positions may be sitting unmanaged)');

    // Count actual runs against the schedule — a single fresh timestamp can
    // hide a week of every-other-run failures.
    const runs = readOpsLog().filter((r) => r.ts && ['autopilot', 'manage'].includes(r.cmd));
    if (runs.length) {
      const now = Date.now();
      const windowStart = Math.max(now - 7 * 86400000, new Date(runs[0].ts).getTime());
      const todayUtc = new Date(now).toISOString().slice(0, 10);
      let weekdays = 0;
      for (let t = windowStart; t <= now; t += 86400000) {
        const d = new Date(t);
        // Skip today: this check runs at the START of the day's first run,
        // before either of today's runs could have logged — counting today
        // as 2 expected / 0 logged would false-alarm every healthy weekday.
        if (d.toISOString().slice(0, 10) === todayUtc) continue;
        if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) weekdays++;
      }
      const expected = weekdays * config.ops.runsPerWeekday;
      const got = runs.filter((r) => new Date(r.ts).getTime() >= windowStart).length;
      if (expected - got >= 2) { // >=2: slack for one boundary straggler
        console.log(`⚠ ${expected - got} scheduled run(s) appear to have been missed over the trailing window (${got}/${expected} logged) — check the cloud routines.`);
      }
    }
  } catch (e) {
    console.log(`⚠ DEAD-MAN WARNING: heartbeat check failed (${e.message}) — scheduler health unverifiable`);
  }
}

function writeHeartbeat(portfolio, kind = 'autopilot') {
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')); } catch { /* first run / corrupt */ }
    const now = new Date().toISOString();
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    writeJsonAtomic(HEARTBEAT, {
      lastRunAt: now,
      equity: +equity(portfolio).toFixed(2),
      openPositions: portfolio.positions.length,
      cmd: kind,
      // Per-leg stamps: autopilot runs both legs; a standalone manage run
      // must stamp its own leg without clobbering the scan stamp.
      lastScanAt: kind === 'autopilot' ? now : prev.lastScanAt ?? null,
      lastManageAt: now,
      bookGreeks: prev.bookGreeks ?? null, // refreshed by cmdStatus when marks allow
    });
  } catch { /* best effort */ }
}

const out = (obj, human) => console.log(asJson ? JSON.stringify(obj, null, 2) : human);

async function cmdScan() {
  const portfolio = loadPortfolio();
  const budget = riskBudget(portfolio);
  const gov = governorState(portfolio);
  const { universe, note } = await discoverUniverse();
  console.error(`Scanning ${universe.length} symbols (risk budget $${budget.toFixed(2)}/trade) — ${note}`);
  if (gov.rung > 0) {
    // Suppression must be LOUD — a governed scan producing no tickets should
    // never look like a broken scanner.
    console.error(`⚠ DRAWDOWN GOVERNOR active (rung ${gov.rung}): ${(gov.dd * 100).toFixed(0)}% off high-water $${gov.highWater.toFixed(0)} — ${gov.riskFactor === 0 ? 'NEW ENTRIES HALTED pending human review' : `risk budget cut to ${gov.riskFactor}x, ${gov.slotPenalty} slot(s) removed`}. Expect fewer or no tickets; that is the governor, not a malfunction.`);
  }

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
    // Macro-event context: tag and WARN only — a blocking rule must first
    // earn activation via the pre-registered fomc rules on forward data.
    const mktDay = etDay();
    const nf = nextEvent('fomc', mktDay);
    const nc = nextEvent('cpi', mktDay);
    const expiry = t.legs?.[0]?.expiry;
    t.macro = {
      nextFomc: nf?.date ?? null,
      nextCpi: nc?.date ?? null,
      fomcBeforeExpiry: !!(nf && expiry && nf.date <= expiry),
    };
    if (nf?.days === 0) v.warnings.push('today is an FOMC decision day (2pm ET) — expect a volatility break this afternoon');
    if (t.structure.includes('credit') && t.macro.fomcBeforeExpiry) {
      v.warnings.push(`expiry spans FOMC ${nf.date} — binary-event risk on a short-premium structure (journaled for the pre-registered fomc-credit-veto rule)`);
    }
    tickets.push(t);
  }
  // Ticket persistence: archive everything being superseded (append-only,
  // recoverable by record-fill's archive fallback), and carry forward ONLY
  // live orders working at the broker — those are real in-flight commitments.
  // Stale 'pending' and earnings-held tickets are deliberately dropped at the
  // next scan: filling day-old quotes would change which trades the bot takes,
  // and the earnings-verification flow completes the same morning.
  const prevTickets = loadTickets();
  if (prevTickets.length) {
    try { fs.appendFileSync(path.join(DATA_ROOT, 'tickets-archive.jsonl'), prevTickets.map((t) => JSON.stringify(t)).join('\n') + '\n'); } catch { /* best effort */ }
  }
  const scanDay = etDay();
  const carried = prevTickets.filter((t) =>
    t.status === 'live_order_placed' &&
    (t.legs?.[0]?.expiry ?? '9999') >= scanDay &&
    !tickets.some((n) => n.id === t.id));
  saveTickets([...tickets, ...carried]);
  for (const w of coverageWarnings()) console.error(`⚠ ${w}`);

  // Journal today's vol surface per symbol — free feeds have no IV history,
  // so we build our own. Months of these snapshots unlock honest IV-rank,
  // skew, and term-structure signals no backtest can fabricate.
  // (Fixture runs write to data-fixtures/ via the DATA_ROOT redirect.)
  try {
    const jf = path.join(DATA_ROOT, 'iv-history.jsonl');
    fs.mkdirSync(path.dirname(jf), { recursive: true });
    const today = etDay(); // market day, not UTC day — a late-UTC run must not roll the date
    const existing = fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : '';
    // Journal-only symbols: recorded daily, NEVER traded (config.journalUniverse
    // — and universe.js excludes them from discovery, so they cannot sneak into
    // the tradeable scan via a trending list either).
    // INVARIANT: extraResults must never merge into `results` — the trading
    // path (candidates filter above) reads `results` and stays byte-identical.
    // The deadline is created FIRST and covers the extras scan too: history
    // fetches for 25 cold names on a degraded-feed day must never stall the
    // scheduled run (chains for extras are deferred to the bounded de-bias
    // loop below via chains:false).
    const extraSyms = (config.journalUniverse || []).filter((x) => !universe.includes(x));
    const deadline = Date.now() + (extraSyms.length ? 240_000 : 90_000);
    const { results: extraResults, errors: extraErrors } = extraSyms.length
      ? await scanUniverse(extraSyms, { deadline, chains: false })
      : { results: [], errors: [] };
    for (const e of extraErrors) console.error(`  ! journal-only ${e.symbol}: ${e.error}`);
    const journalResults = [...results, ...extraResults];
    const inJournalSet = new Set([...config.universe, ...(config.journalUniverse || [])]);
    // De-bias the dataset: the scanner only fetches chains for signal-worthy
    // symbols, which would record IV only on interesting days (selection
    // bias). For journal members, fetch the chain regardless so every symbol
    // gets a daily observation. Cache makes repeats cheap. Three consecutive
    // failures reads as an upstream outage (one outage hits every symbol).
    let misses = 0;
    for (const s of journalResults) {
      if (s.atmIV != null || !(s.hv20 > 0) || !inJournalSet.has(s.symbol)) continue;
      if (Date.now() > deadline || misses >= 3) {
        console.error('IV journal: aborting de-bias pass (time budget exhausted or repeated feed failures)');
        break;
      }
      try {
        const chain = await getOptionsChain(s.symbol);
        misses = 0;
        const iv = atmIV(chain);
        if (iv) { s.atmIV = iv; s.ivOverHv = iv / s.hv20; }
        s.chain = chain; // keep for the surface snapshot below — was discarded
      } catch { misses++; /* best effort — never blocks trading */ }
    }
    const add = journalResults
      .filter((s) => s.atmIV && s.ivOverHv && s.chain && !existing.includes(`"date":"${today}","symbol":"${s.symbol}"`))
      .map((s) => JSON.stringify(buildJournalRow(s, s.chain, today)));
    if (add.length) {
      fs.appendFileSync(jf, add.join('\n') + '\n');
      console.error(`IV journal: recorded ${add.length} symbol(s) for ${today}`);
    }
    // Label past journal rows whose 21-bar future has now been written.
    const b = await backfillOutcomes(new Set(journalResults.map((s) => s.symbol)));
    if (b.appended) console.error(`outcomes: labeled ${b.appended} past journal row(s) with forward returns`);
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
    if (pos.blocked) { console.log(`SKIP [${t.id}] ${t.symbol}: ${pos.reason}`); continue; }
    t.status = 'executed_paper';
    executed.push(pos);
    console.log(`FILLED [${t.id}] ${t.symbol} ${t.structure} — paid ${fmtMoney(pos.entryValue)} (cash left ${fmtMoney(portfolio.cash)})`);
  }
  saveTickets(loadTickets().map((t) => tickets.find((x) => x.id === t.id) || t));
  if (asJson) out({ executed }, '');
}

async function cmdManage() {
  const portfolio = loadPortfolio();
  if (!portfolio.positions.length) {
    console.log('No open positions.');
    updateHighWater(portfolio);
    savePortfolio(portfolio);
    writeHeartbeat(portfolio, 'manage');
    return;
  }
  const actions = [];
  for (const pos of [...portfolio.positions]) {
    try {
      await markPosition(pos);
    } catch (e) {
      // Chain fetch failed entirely (delisting, symbol change, feed outage).
      // The position must still be time-managed with data-free facts.
      pos.markStale = true; // a failed fetch IS a stale mark — freezes the high-water ratchet and labels status honestly
      pos.markFailures = (pos.markFailures || 0) + 1;
      console.log(`  ! could not mark ${pos.symbol} (failure #${pos.markFailures}): ${e.message}`);
      const blind = settleExpiredBlind(pos, portfolio);
      if (blind.settled) {
        console.log(`  SETTLED ${pos.symbol} blind: all legs expired with no market data — realized ${fmtMoney(blind.realizedPnl)} (conservative total loss)`);
      } else if (blind.liveExpired) {
        console.log(`  ⚠ LIVE position ${pos.symbol} is past expiry with no market data — reconcile the real broker settlement via /bot-manage and record the actual fill`);
      } else if (pos.markFailures >= 3) {
        console.log(`  ⚠ ${pos.symbol} has failed to mark ${pos.markFailures} runs in a row — investigate (delisted? renamed?)`);
      }
      continue;
    }
    // A successful chain fetch can still fail to quote the legs: expired
    // contracts vanish from live chains, and a worthless option's bid drops
    // to 0 (mid=null). Once every leg is past expiry the flag path can never
    // resolve — quotes for an expired contract never come back — so settle
    // blind exactly as the fetch-failure path does.
    if (pos.markStale) {
      const blind = settleExpiredBlind(pos, portfolio);
      if (blind.settled) {
        console.log(`  SETTLED ${pos.symbol} blind: all legs expired but quotes are gone — realized ${fmtMoney(blind.realizedPnl)} (conservative total loss)`);
        continue; // removed from portfolio.positions — nothing left to decide
      }
      if (blind.liveExpired) {
        console.log(`  ⚠ LIVE position ${pos.symbol} is past expiry with no quotes — reconcile the real broker settlement via /bot-manage and record the actual fill`);
        continue;
      }
    }
    const d = exitDecision(pos);
    actions.push({ id: pos.id, symbol: pos.symbol, structure: pos.structure, unrealizedPnl: pos.unrealizedPnl, dte: pos.dte, ...d });
  }
  updateHighWater(portfolio); // fresh marks in hand: ratchet high-water, step the governor
  savePortfolio(portfolio);

  // Macro-event heads-up (info only): open premium into a binary event is a
  // fact worth seeing, not a rule worth guessing at.
  if (portfolio.positions.length) {
    const today = etDay();
    const tomorrow = etDay(new Date(Date.now() + 86400000));
    for (const type of ['fomc', 'cpi']) {
      for (const d of eventsBetween(type, today, tomorrow)) {
        console.log(`  ℹ ${type.toUpperCase()} ${d === today ? 'TODAY' : 'tomorrow'} (${d}) with ${portfolio.positions.length} open position(s) — expect volatility around the release`);
      }
    }
  }

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
  writeHeartbeat(portfolio, 'manage');
  await refreshDigest(portfolio);
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
  const gov = governorState(portfolio);
  console.log(`Drawdown: ${(gov.dd * 100).toFixed(1)}% off high-water ${fmtMoney(gov.highWater)} (governor: ${gov.rung === 0 ? 'normal' : gov.riskFactor === 0 ? 'HALTED — human review required' : `de-risked ${gov.riskFactor}x, -${gov.slotPenalty} slot`})`);
  console.log(`Open positions: ${portfolio.positions.length}/${Math.max(0, tier.maxPositions - gov.slotPenalty)}`);
  for (const p of portfolio.positions) {
    if (p.needsReconcile) console.log(`  ⚠ ACTION NEEDED: LIVE position ${p.symbol} [${p.id}] expired with no local data — check the real broker settlement, then record it: node trading-bot/src/index.js record-close ${p.id} --net=<dollars> --confirm`);
  }
  for (const t of loadTickets()) {
    if (t.status !== 'live_order_placed') continue;
    const ageDays = (Date.now() - new Date(t.createdAt)) / 86400000;
    if (ageDays > 1) console.log(`  ⚠ ACTION NEEDED: live order [${t.id}] ${t.symbol} was placed ${Math.round(ageDays)}d ago and never recorded — check the broker: record-fill if it filled, or remove the ticket if it was canceled`);
  }
  let netDelta = 0, netTheta = 0, netVega = 0, haveGreeks = false, bull = 0, bear = 0;
  for (const p of portfolio.positions) {
    console.log(`  [${p.id}] ${p.symbol} ${p.structure}  in ${fmtMoney(p.entryValue)}  now ${fmtMoney(p.currentValue)}  uP&L ${fmtMoney(p.unrealizedPnl)}  opened ${p.openedAt.slice(0, 10)}${p.markStale ? '  [STALE MARK]' : ''}`);
    const spot = p.spotAtMark ?? p.spot ?? 0;
    for (const leg of p.legs) {
      // Mark-time deltas when available — entry-day deltas go stale after any
      // real move and misstate the book's true directional bet.
      const d = leg.markDelta ?? leg.delta;
      if (d == null) continue;
      const sign = leg.action === 'buy' ? 1 : -1;
      netDelta += sign * d * leg.contracts * 100 * spot;
      if (leg.markTheta != null) { netTheta += sign * leg.markTheta * leg.contracts * 100; haveGreeks = true; }
      if (leg.markVega != null) netVega += sign * leg.markVega * leg.contracts * 100;
    }
    if (p.direction === 'bullish') bull++; else if (p.direction === 'bearish') bear++;
  }
  if (portfolio.positions.length) {
    console.log(`Book exposure: net delta ${fmtMoney(netDelta)} of underlying (${bull} bullish / ${bear} bearish), as of last mark`);
    if (haveGreeks) {
      console.log(`Book greeks: theta ${fmtMoney(netTheta)}/day (${((netTheta / eq) * 100).toFixed(2)}% of equity daily), vega ${fmtMoney(netVega)} per vol point`);
    }
    // Journal exposure into the heartbeat so every scheduled run records it.
    try {
      if (fs.existsSync(HEARTBEAT)) {
        const hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
        hb.bookGreeks = {
          netDeltaDollars: +netDelta.toFixed(2),
          netThetaPerDay: haveGreeks ? +netTheta.toFixed(2) : null,
          netVega: haveGreeks ? +netVega.toFixed(2) : null,
        };
        writeJsonAtomic(HEARTBEAT, hb);
      }
    } catch { /* telemetry only */ }
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
  console.log(`\n${gateLine(gateStatus(portfolio))}`);
  const { shadowPerformance } = await import('./report.js');
  const sp = shadowPerformance(portfolio);
  if (sp && sp.tradesWithShadow > 0) {
    console.log(`Shadow PF at 50%-of-half-spread fills: ${sp.shadowProfitFactor ?? '—'} over all ${sp.closedTrades} closed trade(s), ${sp.tradesWithShadow} shadow-adjusted (pre-telemetry trades enter at recorded P&L; telemetry only — the gate reads recorded P&L). If shadow PF diverges hard from recorded PF, the slippage assumption is doing the earning.`);
  }

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
      ['score', (t) => t.score == null ? null : t.score >= 85 ? '85+' : t.score >= 75 ? '75-84' : t.score >= 65 ? '65-74' : '<65'],
      ['exit', (t) => (t.closeReason || '').split(':')[0]],
      // Fill-model changes must never pool silently: v1 trades filled credits
      // at raw mid with no fees; v2 pays slippage+fees everywhere.
      ['cost model', (t) => `v${t.costModelVersion ?? 1}`],
    ];
    for (const [name, fn] of dims) {
      console.log(`\nBy ${name}:`);
      for (const [k, trades] of Object.entries(groupBy(portfolio.closed, fn))) {
        console.log(`  ${k.padEnd(24)} ${stats(trades)}`);
      }
    }
    console.log(`\nTotal modeled friction (slippage + fees): ${fmtMoney(p.grossFriction)}${p.frictionPctOfGrossWins != null ? ` = ${p.frictionPctOfGrossWins}% of gross wins` : ''} — compare against real fills at go-live`);
  }
}

// The go-live gate in plain language. Read-only reporting — the bot never
// trades toward the quota, and /bot-execute checks this before any live order.
function gateLine(g) {
  return `Progress to live trading: ${g.closedTrades} of ${config.goLive.minClosedTrades} trades logged; profit factor ${g.profitFactor ?? 'not yet meaningful'} (needs > ${g.pfNeeded}). ${g.passed ? 'GATE PASSED — live execution is unlocked, pending your explicit go.' : 'The bot will not place real orders until this gate is green.'}`;
}

async function cmdGate() {
  const portfolio = loadPortfolio();
  const g = gateStatus(portfolio);
  if (asJson) { out(g, ''); return; }
  console.log(gateLine(g));
  if (!g.passed) {
    console.log(`Still needed: ${g.tradesNeeded} more closed trade(s)${g.profitFactor != null && g.profitFactor <= g.pfNeeded ? ` AND profit factor above ${g.pfNeeded} (currently ${g.profitFactor})` : ''}.`);
    if (g.estWeeksRemaining != null) console.log(`At the current pace (~${g.tradesPerWeek} trades/week) that is roughly ${g.estWeeksRemaining} more week(s).`);
    console.log('The bot never trades to fill a quota — slower is fine. The gate was frozen ' + g.frozenAt + ' and changes require a written pre-registration note.');
  }
}

// Pre-registered signal evaluator: reports each rulebook rule as
// PASS / FAIL / INSUFFICIENT_DATA against forward data, plus per-symbol VRP.
// Read-only by design — activating a passing rule takes a human commit.
async function cmdSignals() {
  const { evaluateRules, vrpBySymbol, joinedRows } = await import('./signals.js');
  const portfolio = loadPortfolio();
  const { results, joinedCount, journalCount } = evaluateRules(portfolio);
  const vrp = vrpBySymbol(joinedRows(), 60);
  if (asJson) { out({ journalRows: journalCount, joinedRows: joinedCount, rules: results, vrp }, ''); return; }

  console.log(`Journal: ${journalCount} rows, ${joinedCount} labeled with forward outcomes (labels appear ~21 trading days after each row)`);
  console.log('\n=== PRE-REGISTERED RULES ===');
  for (const r of results) {
    console.log(`${r.status.padEnd(18)} ${r.id.padEnd(18)} n=${r.n ?? 0}${r.statistic != null ? `  stat ${r.statistic}` : ''}`);
    if (r.detail) console.log(`  ${r.detail}`);
  }
  console.log('\n=== PER-SYMBOL VRP (median atmIV - rv21, >=60 joined rows) ===');
  if (!vrp.length) {
    console.log('  none yet — needs ~3 months of journal + outcome labels. The dataset is accruing on every scan.');
  } else {
    for (const v of vrp) console.log(`  ${v.symbol.padEnd(6)} ${v.medianVrp >= 0 ? '+' : ''}${v.medianVrp}  (n=${v.n}) ${v.medianVrp >= 0 ? 'premium seller\'s edge' : 'NO variance premium'}`);
  }
  console.log('\nActivation protocol: a PASS here is necessary, never sufficient — activation requires a human commit flipping the named config flag and citing the rule id. See data/pre-registrations.json.');
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
  const after = loadPortfolio();
  console.log(gateLine(gateStatus(after)));
  writeHeartbeat(after, 'autopilot');
  await refreshDigest(after);
}

// Live reconciliation: the ONLY sanctioned way live fills enter the record.
// Both commands echo what they parsed and refuse to write without --confirm.
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

// Mark a pending ticket as "order placed at the broker" so it survives the
// daily scan rotation until the fill is recorded (or the legs expire).
async function cmdRecordOrder() {
  const ticketId = args.find((a) => !a.startsWith('--') && a !== 'record-order');
  if (!ticketId) { console.log('Usage: record-order <ticketId> --confirm'); return; }
  const tickets = loadTickets();
  const t = tickets.find((x) => x.id === ticketId);
  if (!t) { console.log(`No ticket ${ticketId}. Run tickets to list them.`); process.exitCode = 1; return; }
  if (!['pending', 'needs_earnings_verification'].includes(t.status)) {
    console.log(`Ticket ${ticketId} is ${t.status} — only a pending ticket can be marked as placed.`); process.exitCode = 1; return;
  }
  console.log(`Marking [${t.id}] ${t.symbol} ${t.structure} as LIVE ORDER PLACED — it will survive daily scans until the fill is recorded.`);
  if (!args.includes('--confirm')) { console.log('\nDry run — re-run with --confirm to write.'); return; }
  t.status = 'live_order_placed';
  saveTickets(tickets);
  console.log(`Recorded. After the fill: record-fill ${t.id} --net=<dollars> --confirm`);
}

async function cmdRecordFill() {
  const ticketId = args.find((a) => !a.startsWith('--') && a !== 'record-fill');
  const net = parseFloat(argVal('net'));
  if (!ticketId || !Number.isFinite(net)) {
    console.log('Usage: record-fill <ticketId> --net=<total dollars> --confirm');
    console.log('  net = TOTAL dollars: debit paid (long/debit spread) or credit received (credit spread)');
    return;
  }
  const tickets = loadTickets();
  let t = tickets.find((x) => x.id === ticketId);
  let fromArchive = false;
  if (!t) {
    // A fill can land after the daily scan already rotated tickets.json —
    // fall back to the append-only archive, newest entry first.
    try {
      const lines = fs.readFileSync(path.join(DATA_ROOT, 'tickets-archive.jsonl'), 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let cand; try { cand = JSON.parse(lines[i]); } catch { continue; }
        if (cand.id === ticketId) { t = cand; fromArchive = true; break; }
      }
    } catch { /* no archive yet */ }
    if (t) {
      const ageDays = (Date.now() - new Date(t.createdAt)) / 86400000;
      if (!(ageDays <= 14) && !args.includes('--force-stale')) {
        console.log(`Ticket ${ticketId} was found only in the archive and is ${Math.round(ageDays)} day(s) old — its quotes are stale calibration data. Re-verify everything, then re-run with --force-stale.`);
        process.exitCode = 1; return;
      }
    }
  }
  if (!t) { console.log(`No ticket ${ticketId} in tickets.json or the archive. Run tickets to list current ones.`); process.exitCode = 1; return; }
  if (['executed_paper', 'executed_live'].includes(t.status)) { console.log(`Ticket ${ticketId} is already ${t.status} — refusing a duplicate fill.`); process.exitCode = 1; return; }
  const portfolio = loadPortfolio();
  if (portfolio.positions.some((p) => p.id === t.id)) { console.log(`Position ${t.id} already exists — refusing a duplicate.`); process.exitCode = 1; return; }
  if (portfolio.closed.some((c) => c.id === t.id)) { console.log(`Trade ${t.id} is already in the closed record — refusing a duplicate.`); process.exitCode = 1; return; }
  const isCredit = t.netCredit != null;
  const contracts = t.legs[0].contracts;
  if (isCredit && (net < 0 || net > t.width * contracts * 100)) {
    console.log(`Credit ${fmtMoney(net)} is outside [0, width x contracts x 100 = ${fmtMoney(t.width * contracts * 100)}] — check the number.`); process.exitCode = 1; return;
  }
  if (!isCredit && net <= 0) { console.log('A debit fill must be a positive dollar amount.'); process.exitCode = 1; return; }

  console.log(`Recording LIVE fill for [${t.id}] ${t.symbol} ${t.structure}:`);
  for (const leg of t.legs) console.log(`  ${leg.action.toUpperCase()} ${leg.contracts}x ${leg.expiry} $${leg.strike} ${leg.type} (ticket mid $${leg.mid})`);
  console.log(`  typed net: ${fmtMoney(net)} ${isCredit ? 'credit received' : 'debit paid'}  |  ticket mid net: ${fmtMoney(Math.abs(t.netDebit ?? t.netCredit))}`);
  console.log(`  implied max loss: ${fmtMoney(isCredit ? t.width * 100 * contracts - net : net)}`);
  if (!args.includes('--confirm')) { console.log('\nDry run — re-run with --confirm to write.'); return; }

  const pos = recordLiveFill(t, net, portfolio);
  if (fromArchive) {
    tickets.push({ ...t, status: 'executed_live' }); // restore into tickets.json so status surfacing stays truthful
  } else {
    t.status = 'executed_live';
  }
  saveTickets(tickets);
  console.log(`RECORDED live position ${pos.id} — entry ${fmtMoney(pos.entryValue)}${pos.entryCredit ? ` (credit ${fmtMoney(pos.entryCredit)})` : ''}, fees ${fmtMoney(pos.entryFees)}, slippage vs mid ${fmtMoney(pos.entrySlippageCost)}`);
  if (portfolio.cash < 0) {
    console.log(`⚠ ACTION NEEDED: the local cash mirror went negative (${fmtMoney(portfolio.cash)}) — the real account funded this fill, so reconcile local cash against the broker balance.`);
  }
}

async function cmdRecordClose() {
  const posId = args.find((a) => !a.startsWith('--') && a !== 'record-close');
  const net = parseFloat(argVal('net'));
  if (!posId || !Number.isFinite(net)) {
    console.log('Usage: record-close <positionId> --net=<total dollars> [--reason="why"] --confirm');
    console.log('  net = TOTAL dollars: proceeds received (long/debit) or buyback cost paid (credit spread)');
    return;
  }
  const portfolio = loadPortfolio();
  const pos = portfolio.positions.find((p) => p.id === posId);
  if (!pos) { console.log(`No open position ${posId}.`); process.exitCode = 1; return; }
  if (pos.mode !== 'live') { console.log('That is a PAPER position — paper closes come only from the rules engine (manage). Refusing.'); process.exitCode = 1; return; }

  const isCredit = pos.entryCredit != null;
  // Bounds: an impossible number must never enter the permanent record. The
  // typed value is TOTAL dollars, always >= 0 — sign confusion (typing a P&L
  // instead of a fill value) is the classic fat-finger here.
  if (net < 0) {
    console.log('net must be >= 0 total dollars: the BUYBACK COST paid (credit spread) or the PROCEEDS received (long/debit). Never a P&L.');
    process.exitCode = 1; return;
  }
  if (isCredit && net > pos.entryValue + pos.entryCredit + 0.01) {
    console.log(`Buyback cost ${fmtMoney(net)} exceeds the spread's total width ${fmtMoney(pos.entryValue + pos.entryCredit)} — impossible; check the number.`);
    process.exitCode = 1; return;
  }
  const feesEst = pos.legs.reduce((a, l) => a + l.contracts, 0) * config.data.feePerContract;
  const entryFeesPaid = pos.entryFees || 0;
  const impliedPnl = isCredit
    ? +(pos.entryCredit - net - entryFeesPaid - feesEst).toFixed(2)
    : +(net - feesEst - pos.entryValue - entryFeesPaid).toFixed(2);
  const maxLossAll = +(pos.entryValue + entryFeesPaid + feesEst).toFixed(2);
  const tol = 1; // live fills vs ticket-mid-based maxGain: allow small drift
  if (!args.includes('--override') && (impliedPnl < -maxLossAll - tol || (pos.maxGain != null && impliedPnl > pos.maxGain + tol))) {
    console.log(`Implied P&L ${fmtMoney(impliedPnl)} is outside this structure's possible range [${fmtMoney(-maxLossAll)}, ${pos.maxGain != null ? fmtMoney(pos.maxGain) : 'uncapped'}] — refusing. Re-check the number; add --override only if the broker record truly says so.`);
    process.exitCode = 1; return;
  }
  console.log(`Recording LIVE close for [${pos.id}] ${pos.symbol} ${pos.structure}:`);
  console.log(`  entry ${fmtMoney(pos.entryValue)}${isCredit ? ` (credit ${fmtMoney(pos.entryCredit)})` : ''}, typed ${isCredit ? 'buyback cost' : 'proceeds'}: ${fmtMoney(net)}`);
  console.log(`  implied realized P&L: ${fmtMoney(impliedPnl)}  (structure range: ${fmtMoney(-maxLossAll)} to ${pos.maxGain != null ? fmtMoney(pos.maxGain) : 'uncapped'})`);
  if (!args.includes('--confirm')) { console.log('\nDry run — re-run with --confirm to write.'); return; }

  const r = recordLiveClose(pos, net, portfolio, argVal('reason'));
  if (r.blocked) { console.log(`BLOCKED: ${r.reason}`); process.exitCode = 1; return; }
  console.log(`RECORDED live close — realized ${fmtMoney(r.realizedPnl)} (after fees)`);
}

// Owner digest: best-effort render of data/DIGEST.md after scheduled runs.
async function refreshDigest(portfolio) {
  try {
    const { writeDigest } = await import('./digest.js');
    let heartbeat = null;
    try { heartbeat = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')); } catch { /* none yet */ }
    writeDigest({ portfolio, tickets: loadTickets(), heartbeat });
  } catch (e) { console.error(`digest: skipped (${e.message})`); }
}

async function cmdDigest() {
  const portfolio = loadPortfolio();
  await refreshDigest(portfolio);
  console.log('Wrote trading-bot/data/DIGEST.md');
}

async function cmdReset() {
  if (!args.includes('--confirm')) { console.log('This wipes the paper portfolio. Re-run with --confirm.'); return; }
  for (const f of ['portfolio.json', 'tickets.json']) {
    const p = path.join(DATA_ROOT, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log(`Paper portfolio reset (${DATA_ROOT}).`);
}

// Ops-ledger wrapper for the two scheduled entry points: every run appends an
// outcome line — success or failure — so missed/failed runs are countable.
const withOpsLog = (kind, fn) => async () => {
  const t0 = Date.now();
  const finish = (ok, note) => {
    let extra = {};
    try {
      const p = loadPortfolio();
      extra = { equity: +equity(p).toFixed(2), openPositions: p.positions.length };
    } catch { /* a corrupt portfolio must not mask the run outcome */ }
    appendOpsLog({ ts: new Date().toISOString(), cmd: kind, ok, durationMs: Date.now() - t0, ...extra, ...(note ? { note } : {}) });
  };
  try {
    await fn();
    finish(true);
  } catch (e) {
    finish(false, e.message);
    throw e; // preserve the non-zero exit code
  }
};

const commands = { scan: cmdScan, tickets: cmdTickets, 'paper-buy': cmdPaperBuy, manage: withOpsLog('manage', cmdManage), status: cmdStatus, report: cmdReport, gate: cmdGate, signals: cmdSignals, digest: cmdDigest, 'record-order': cmdRecordOrder, 'record-fill': cmdRecordFill, 'record-close': cmdRecordClose, backtest: cmdBacktest, autopilot: withOpsLog('autopilot', cmdAutopilot), reset: cmdReset };
const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\nCommands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
