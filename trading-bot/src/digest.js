// Plain-language owner digest: data/DIGEST.md, regenerated wholesale on every
// scheduled run. The go-live bar requires the owner to understand every trade
// proposed and skipped — but the bot's outputs are ephemeral container logs.
// This file is the owner's window, committed with the rest of the state.
//
// Anti-flattery rules: every dollar figure comes from performance()/
// gateStatus() — zero digest-local arithmetic; full regeneration each run (no
// accretion, no cherry-picking); read-only over portfolio/tickets.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { performance, gateStatus, fmtMoney } from './report.js';
import { governorState } from './risk.js';
import { readOpsLog } from './portfolio.js';
import { loadJournal } from './journal.js';

import { useFixtures } from './marketdata.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIGEST = path.join(ROOT, useFixtures() ? 'data-fixtures' : 'data', 'DIGEST.md');

// One-sentence explanations a non-trader can read.
const STRUCTURE_PLAIN = {
  long_call: 'bought call options — profits if the stock rises',
  long_put: 'bought put options — profits if the stock falls',
  call_debit_spread: 'a call spread (bought one, sold one) — profits if the stock rises, with capped cost and capped gain',
  put_debit_spread: 'a put spread — profits if the stock falls, with capped cost and capped gain',
  put_credit_spread: 'sold a put spread — collects premium and profits if the stock stays up, risk strictly capped',
  call_credit_spread: 'sold a call spread — collects premium and profits if the stock stays down, risk strictly capped',
};

const section = (title, lines) =>
  `## ${title}\n\n${lines.length ? lines.join('\n') : 'Nothing right now.'}\n`;

export function writeDigest({ portfolio, tickets = [], heartbeat = null }) {
  const p = performance(portfolio);
  const gate = gateStatus(portfolio);
  const gov = governorState(portfolio);

  const account = [
    `Your paper account is worth **${fmtMoney(p.equity)}** (started at ${fmtMoney(p.startingEquity)}, ${p.totalReturnPct >= 0 ? 'up' : 'down'} ${Math.abs(p.totalReturnPct)}%).`,
  ];
  if (gov.rung > 0) {
    account.push(`⚠ The drawdown safety brake is ON (${(gov.dd * 100).toFixed(0)}% below the account's best level): ${gov.riskFactor === 0 ? 'no new trades until a human reviews' : 'trade size is cut in half until the account recovers'}.`);
  }
  for (const pos of portfolio.positions) {
    const plain = STRUCTURE_PLAIN[pos.structure] ?? pos.structure;
    account.push(`- **${pos.symbol}**: ${plain}. Put in ${fmtMoney(pos.entryValue)}, now marked at ${fmtMoney(pos.currentValue)} (${pos.unrealizedPnl >= 0 ? 'up' : 'down'} ${fmtMoney(Math.abs(pos.unrealizedPnl ?? 0))})${pos.markStale ? ' — prices are stale, treat the mark as approximate' : ''}.`);
  }
  if (!portfolio.positions.length) account.push('No positions are open — the bot only trades when its rules are satisfied. Sitting out IS a strategy.');

  const trades = portfolio.closed.slice(-10).reverse().map((t) => {
    const plain = STRUCTURE_PLAIN[t.structure] ?? t.structure;
    return `- **${t.symbol}** (${(t.closedAt || '').slice(0, 10)}): ${plain}. Why entered: ${t.thesis || '—'}. Why exited: ${t.closeReason || '—'}. Result after costs: **${fmtMoney(t.realizedPnl)}**.`;
  });

  const gateLines = [
    `${gate.closedTrades} of ${config.goLive.minClosedTrades} required trades logged; profit factor ${gate.profitFactor ?? 'not yet meaningful'} (needs > ${gate.pfNeeded}).`,
    gate.passed
      ? '**The gate is GREEN** — live trading is unlocked, pending your explicit go-ahead.'
      : 'The bot will NOT place real-money orders until this gate is green. It never trades faster just to fill the quota.',
  ];
  if (!gate.passed && gate.estWeeksRemaining != null) {
    gateLines.push(`At the current pace (~${gate.tradesPerWeek} trades/week) the remaining ${gate.tradesNeeded} trades take roughly ${gate.estWeeksRemaining} more week(s).`);
  }

  const costLines = [
    `Total modeled trading friction so far (slippage + fees): **${fmtMoney(p.grossFriction)}**${p.frictionPctOfGrossWins != null ? ` — that is ${p.frictionPctOfGrossWins}% of gross wins` : ''}.`,
    'Friction is the silent killer of small accounts; the bot models it pessimistically on purpose.',
  ];

  const ops = readOpsLog();
  const lastRun = ops.length ? ops[ops.length - 1] : null;
  const failedRecent = ops.slice(-14).filter((r) => r.ok === false).length;
  const health = [];
  if (heartbeat?.lastRunAt) health.push(`Last scheduled run: ${heartbeat.lastRunAt} (${heartbeat.cmd ?? '—'}).`);
  else if (lastRun) health.push(`Last logged run: ${lastRun.ts} (${lastRun.cmd}, ${lastRun.ok ? 'ok' : 'FAILED'}).`);
  if (failedRecent) health.push(`⚠ ${failedRecent} of the last 14 runs failed — check the run log (data/ops-log.jsonl).`);
  health.push(`Research dataset: ${loadJournal().length} daily volatility snapshots collected so far (grows every scan; becomes tradeable evidence at ~120 days).`);

  const attention = [];
  for (const t of tickets) {
    if (t.status === 'needs_earnings_verification') {
      attention.push(`- Ticket **${t.symbol}** is HELD until someone verifies the earnings date: if earnings land before ${t.legs?.[0]?.expiry}, discard it; otherwise set it back to "pending".`);
    }
  }
  for (const pos of portfolio.positions) {
    if (pos.needsReconcile) attention.push(`- LIVE position **${pos.symbol}** expired with no local data — record the real settlement: \`record-close ${pos.id} --net=<dollars> --confirm\`.`);
  }
  if (gov.riskFactor === 0) attention.push('- The drawdown circuit breaker HALTED new trades — a human needs to review the account before it resumes.');

  const md = [
    '# Trading Bot — Owner Digest',
    '',
    `_Auto-generated ${new Date().toISOString()}. Every figure comes from the same code that runs the account; nothing here is hand-adjusted._`,
    '',
    section('Your account', account),
    section('Recent trades (last 10)', trades),
    section('Progress to real money', gateLines),
    section('What trading costs you', costLines),
    section('System health', health),
    section('Needs your attention', attention),
  ].join('\n');

  // Atomic write, same guarantee as portfolio.json.
  const tmp = `${DIGEST}.tmp`;
  fs.mkdirSync(path.dirname(DIGEST), { recursive: true });
  fs.writeFileSync(tmp, md);
  fs.renameSync(tmp, DIGEST);
  return DIGEST;
}
