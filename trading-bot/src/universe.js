// Dynamic universe discovery — merges the curated static list with what the
// market is actually excited about today: trending tickers and most-active
// names from Yahoo's free endpoints. Everything discovered still has to pass
// the exact same signal, liquidity, and risk gates as the static list; this
// widens the funnel, never lowers the bar.

import { useFixtures } from './marketdata.js';
import config from '../config.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

async function tryJson(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Plain US equity tickers only — no indices (^GSPC), crypto (BTC-USD),
// futures (ES=F), or foreign listings (RY.TO).
const isEquityTicker = (s) => /^[A-Z]{1,5}$/.test(s);

async function fetchTrending() {
  const j = await tryJson('https://query1.finance.yahoo.com/v1/finance/trending/US?count=25');
  return (j?.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(isEquityTicker);
}

async function fetchScreener(scrIds) {
  const j = await tryJson(
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrIds}&count=25`
  );
  const quotes = j?.finance?.result?.[0]?.quotes || [];
  const [lo, hi] = config.discovery.priceRange;
  return quotes
    .filter((q) => isEquityTicker(q.symbol || ''))
    .filter((q) => q.regularMarketPrice == null || (q.regularMarketPrice >= lo && q.regularMarketPrice <= hi))
    .map((q) => q.symbol);
}

// Returns the scan universe: static list plus up to `max` discovered movers.
// Discovery failures are silent-but-reported — the static list always works.
export async function discoverUniverse() {
  const base = [...config.universe];
  if (!config.discovery.enabled || useFixtures()) {
    return { universe: base, discovered: [], note: useFixtures() ? 'fixtures mode: discovery off' : 'discovery disabled' };
  }

  const [trending, actives, gainers] = await Promise.all([
    fetchTrending(),
    fetchScreener('most_actives'),
    fetchScreener('day_gainers'),
  ]);

  const seen = new Set(base);
  const discovered = [];
  // interleave sources so one noisy list doesn't dominate
  const sources = [actives, gainers, trending];
  for (let i = 0; discovered.length < config.discovery.max; i++) {
    const src = sources[i % sources.length];
    const idx = Math.floor(i / sources.length);
    if (sources.every((s) => idx >= s.length)) break;
    const sym = src[idx];
    if (sym && !seen.has(sym)) { seen.add(sym); discovered.push(sym); }
  }

  const note = discovered.length
    ? `discovered ${discovered.length} movers: ${discovered.join(', ')}`
    : 'discovery endpoints unreachable — using static universe only';
  return { universe: [...base, ...discovered].slice(0, config.discovery.maxTotal), discovered, note };
}
