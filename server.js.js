const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const app = express();
const PORT = process.env.PORT || 8080;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ETHERSCAN_KEY = process.env.ETHERSCAN_KEY || 'AXVGSMJ8E546YEDAYQKXSQSX2ME4JPTPAD';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';
const PRICES = {
  pro:        process.env.STRIPE_PRICE_PRO   || 'price_placeholder',
  whale:      process.env.STRIPE_PRICE_WHALE || 'price_placeholder',
  whitelabel: 'price_1TJmkIFt2DJ7Dwg2rGP9j3Q9',
};

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;

// Store pending verifications: code -> email
const pendingVerifications = {};

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

async function sendTelegramAlert(email, tokenName, tokenSymbol, riskScore, address, chain) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('email', email).single();
    if (!user?.telegram_chat_id) return;
    const msg = `⚠️ <b>HIGH RISK ALERT</b>\n\n<b>${tokenName} (${tokenSymbol})</b>\nRisk Score: <b>${riskScore}/100</b>\nChain: ${chain}\nAddress: <code>${address.slice(0,12)}...${address.slice(-8)}</code>\n\n🔗 <a href="https://rugradar-rho.vercel.app">View on RugRadar</a>`;
    await sendTelegramMessage(user.telegram_chat_id, msg);
    console.log(`📱 Telegram alert sent to ${email}`);
  } catch (e) { console.error('Telegram alert error:', e.message); }
}

// Poll for Telegram bot messages
async function startTelegramPolling() {
  if (!TELEGRAM_BOT_TOKEN) return;
  let offset = 0;
  console.log('📱 Telegram bot polling started — @RugRadarScanBot');
  const poll = async () => {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await r.json();
      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;
          const chatId = msg.chat.id;
          const text = msg.text.trim();
          if (text === '/start' || text.startsWith('/start ')) {
            const code = text.split(' ')[1];
            if (code && pendingVerifications[code]) {
              const email = pendingVerifications[code];
              await supabase.from('users').update({ telegram_chat_id: chatId.toString() }).eq('email', email);
              delete pendingVerifications[code];
              await sendTelegramMessage(chatId, `✅ Connected! Your Telegram is now linked to ${email}.\n\nYou'll receive alerts here when any watched token turns HIGH RISK.`);
            } else {
              await sendTelegramMessage(chatId, `👋 Welcome to RugRadar!\n\nTo connect your account, go to your watchlist and click "Connect Telegram".`);
            }
          } else if (text === '/status') {
            const { data: user } = await supabase.from('users').select('email,plan').eq('telegram_chat_id', chatId.toString()).single();
            if (user) await sendTelegramMessage(chatId, `✅ Connected as: ${user.email}\nPlan: ${user.plan.toUpperCase()}`);
            else await sendTelegramMessage(chatId, '❌ Not connected. Visit RugRadar to link your account.');
          } else if (text === '/disconnect') {
            await supabase.from('users').update({ telegram_chat_id: null }).eq('telegram_chat_id', chatId.toString());
            await sendTelegramMessage(chatId, '✅ Disconnected. You will no longer receive alerts.');
          }
        }
      }
    } catch (e) { console.error('Poll error:', e.message); }
    setTimeout(poll, 2000);
  };
  poll();
}



async function sendAlertEmail(email, tokenName, tokenSymbol, riskLevel, riskScore, address, chain) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'RugRadar Alerts <onboarding@resend.dev>',
        to: [email],
        subject: `⚠️ HIGH RISK Alert — ${tokenName} (${tokenSymbol})`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#060608;color:#f0f0f8;padding:2rem;border-radius:12px"><h2 style="color:#ff3b3b;margin-bottom:1rem">⚠️ Risk Alert from RugRadar</h2><p style="color:#a0a0b8;margin-bottom:1.5rem">A token in your watchlist just changed to <strong style="color:#ff6b6b">HIGH RISK</strong>.</p><div style="background:#0d0d12;border:1px solid #2a2a3e;border-radius:10px;padding:1.25rem;margin-bottom:1.5rem"><div style="font-size:1.25rem;font-weight:700;margin-bottom:6px">${tokenName} (${tokenSymbol})</div><div style="font-family:monospace;font-size:11px;color:#5a5a7a;margin-bottom:12px">${address} · ${chain}</div><span style="background:rgba(255,59,59,0.12);color:#ff6b6b;border:1px solid rgba(255,59,59,0.25);padding:4px 12px;border-radius:100px;font-size:12px;font-weight:700">HIGH RISK — ${riskScore}/100</span></div><a href="https://rugradar-rho.vercel.app" style="background:#ff3b3b;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;margin-bottom:1.5rem">View on RugRadar →</a><p style="color:#5a5a7a;font-size:12px">You're receiving this because you watch this token on RugRadar. <a href="https://rugradar-rho.vercel.app/watchlist.html" style="color:#4a9eff">Manage watchlist</a></p></div>`,
      }),
    });
    console.log(`📧 Alert sent to ${email} for ${tokenName}`);
  } catch (e) { console.error('Email error:', e.message); }
}

// ── CHAIN CONFIG ──────────────────────────────────────────────────────────────
const CHAIN_CONFIG = {
  ETH:    { goplusId: '1',       etherscanBase: 'https://api.etherscan.io/v2/api',         name: 'Ethereum' },
  BSC:    { goplusId: '56',      etherscanBase: 'https://api.bscscan.com/api',             name: 'BNB Chain' },
  BASE:   { goplusId: '8453',    etherscanBase: 'https://api.basescan.org/api',            name: 'Base' },
  ARB:    { goplusId: '42161',   etherscanBase: 'https://api.arbiscan.io/api',             name: 'Arbitrum' },
  SOL:    { goplusId: 'solana',  etherscanBase: null,                                      name: 'Solana' },
  MATIC:  { goplusId: '137',     etherscanBase: 'https://api.polygonscan.com/api',         name: 'Polygon' },
  AVAX:   { goplusId: '43114',   etherscanBase: 'https://api.snowtrace.io/api',            name: 'Avalanche' },
  FTM:    { goplusId: '250',     etherscanBase: 'https://api.ftmscan.com/api',             name: 'Fantom' },
  OP:     { goplusId: '10',      etherscanBase: 'https://api-optimistic.etherscan.io/api', name: 'Optimism' },
  BLAST:  { goplusId: '81457',   etherscanBase: null,                                      name: 'Blast' },
  ZKERA:  { goplusId: '324',     etherscanBase: null,                                      name: 'zkSync' },
  LINEA:  { goplusId: '59144',   etherscanBase: null,                                      name: 'Linea' },
  CRONOS: { goplusId: '25',      etherscanBase: null,                                      name: 'Cronos' },
  SCROLL: { goplusId: '534352',  etherscanBase: null,                                      name: 'Scroll' },
  MANTA:  { goplusId: '169',     etherscanBase: null,                                      name: 'Manta' },
};

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── API HELPERS ───────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchGoPlus(address, chainId) {
  try {
    const isSolana = chainId === 'solana';
    const url = isSolana
      ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`
      : `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`;
    const data = await fetchJSON(url);
    return data?.result?.[address.toLowerCase()] || data?.result?.[address] || null;
  } catch (e) { return null; }
}

async function fetchHoneypot(address, chainId) {
  try {
    if (chainId === 'solana') return null;
    return await fetchJSON(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`);
  } catch (e) { return null; }
}

async function fetchDexScreener(address) {
  try {
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    return data?.pairs?.[0] || null;
  } catch (e) { return null; }
}

async function fetchEtherscan(address, chainId) {
  try {
    if (chainId === 'solana') return null;
    const key = Object.keys(CHAIN_CONFIG).find(k => CHAIN_CONFIG[k].goplusId === chainId);
    const base = CHAIN_CONFIG[key]?.etherscanBase;
    if (!base) return null;
    const data = await fetchJSON(`${base}?module=contract&action=getsourcecode&address=${address}&apikey=${ETHERSCAN_KEY}`);
    return data?.result?.[0] || null;
  } catch (e) { return null; }
}

function calculateScore(goplus, honeypot, dex, etherscan, chain = 'ETH') {
  let score = 0;
  const flags = [], safe = [];

  // ── CHAIN AWARENESS ──
  // Non-EVM chains (SOL, XRP etc) don't have full GoPlus/Honeypot support
  // We only score what we can CONFIRM — never penalize missing data
  const isEVM = !['SOL'].includes(chain);
  const hasGoplusData = !!goplus;
  const hasHoneypotData = !!honeypot;
  const hasAnySecurityData = hasGoplusData || hasHoneypotData;

  // For non-EVM chains with no security data, return neutral result
  if (!isEVM && !hasAnySecurityData) {
    return {
      score: 0,
      risk: 'LOW',
      flags: [],
      safe: [{ label: 'Chain Notice', desc: 'Full security scanning not available for this chain — check DEX data manually' }]
    };
  }

  // For EVM tokens with no data at all — mild warning only
  if (isEVM && !hasAnySecurityData) {
    score += 5;
    flags.push({ label: 'Limited Security Data', desc: 'Security APIs returned no data for this token', severity: 'medium' });
  }

  // ── HONEYPOT — only flag if CONFIRMED ──
  const isHoneypot = goplus?.is_honeypot === '1' || honeypot?.honeypotResult?.isHoneypot === true;
  if (isHoneypot) {
    score += 50;
    flags.push({ label: 'Honeypot Detected', desc: 'Cannot sell — funds will be permanently trapped', severity: 'critical' });
  } else if (hasAnySecurityData) {
    safe.push({ label: 'Honeypot Test Passed', desc: 'Token can be bought and sold freely' });
  }

  // ── TAX — only if confirmed ──
  const buyTax  = parseFloat(goplus?.buy_tax  || honeypot?.simulationResult?.buyTax  || 0);
  const sellTax = parseFloat(goplus?.sell_tax || honeypot?.simulationResult?.sellTax || 0);
  if (sellTax > 20 || buyTax > 20)      { score += 25; flags.push({ label: 'Extreme Tax',  desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%`, severity: 'critical' }); }
  else if (sellTax > 10 || buyTax > 10) { score += 15; flags.push({ label: 'High Tax',     desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%`, severity: 'high' }); }
  else if (sellTax > 5  || buyTax > 5)  { score += 6;  flags.push({ label: 'Moderate Tax', desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%`, severity: 'medium' }); }
  else if (hasGoplusData) safe.push({ label: 'Normal Tax', desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%` });

  // ── MINTABLE — only if confirmed ──
  const isMintable = goplus?.is_mintable === '1';
  if (isMintable) { score += 18; flags.push({ label: 'Mintable Supply', desc: 'Owner can create unlimited new tokens', severity: 'high' }); }
  else if (hasGoplusData) safe.push({ label: 'Fixed Supply', desc: 'Cannot mint new tokens' });

  // ── OWNER — only if confirmed active ──
  const ownerAddr = goplus?.owner_address;
  const renounced = !ownerAddr || ownerAddr === '0x0000000000000000000000000000000000000000';
  const ownerActive = !renounced;
  if (ownerActive && hasGoplusData) { score += 15; flags.push({ label: 'Owner Active', desc: 'Contract not renounced — owner retains control', severity: 'high' }); }
  else if (hasGoplusData) safe.push({ label: 'Contract Renounced', desc: 'Owner gave up control' });

  // ── LIQUIDITY LOCK — only flag if EXPLICITLY unlocked ──
  const lpLocked = goplus?.lp_locked === '1';
  const lpExplicitlyUnlocked = goplus?.lp_locked === '0';
  const lpUnlocked = lpExplicitlyUnlocked;
  if (lpLocked) {
    safe.push({ label: 'Liquidity Locked', desc: 'LP cannot be removed — rug protected' });
  } else if (lpExplicitlyUnlocked) {
    score += 25;
    flags.push({ label: 'Liquidity Unlocked', desc: 'LP tokens not locked — dev can remove all liquidity', severity: 'critical' });
  } else if (hasGoplusData) {
    score += 6;
    flags.push({ label: 'LP Lock Status Unknown', desc: 'Cannot verify if liquidity is locked — check manually', severity: 'medium' });
  }

  // ── CONTRACT TRICKS — only if confirmed ──
  if (goplus?.is_proxy === '1')                { score += 14; flags.push({ label: 'Proxy Contract',     desc: 'Contract logic can be swapped silently', severity: 'high' }); }
  if (goplus?.hidden_owner === '1')            { score += 14; flags.push({ label: 'Hidden Owner',       desc: 'Concealed owner can reclaim control', severity: 'critical' }); }
  if (goplus?.is_blacklisted === '1')          { score += 12; flags.push({ label: 'Blacklist Function', desc: 'Owner can block wallets from selling', severity: 'high' }); }
  if (goplus?.can_take_back_ownership === '1') { score += 12; flags.push({ label: 'Reclaim Ownership',  desc: 'Renouncement can be reversed', severity: 'high' }); }
  if (goplus?.transfer_pausable === '1')       { score += 10; flags.push({ label: 'Transfer Pausable',  desc: 'Owner can freeze all transfers', severity: 'high' }); }
  if (goplus?.selfdestruct === '1')            { score += 20; flags.push({ label: 'Self-Destruct',      desc: 'Contract can be destroyed — funds lost', severity: 'critical' }); }

  // ── HOLDER CONCENTRATION — only if data present ──
  const topHolder = parseFloat(goplus?.holders?.[0]?.percent || 0) * 100;
  if (topHolder > 70)      { score += 20; flags.push({ label: 'Extreme Whale',       desc: `Top wallet: ${topHolder.toFixed(1)}% — single dump risk`, severity: 'critical' }); }
  else if (topHolder > 50) { score += 15; flags.push({ label: 'Whale Concentration', desc: `Top wallet: ${topHolder.toFixed(1)}%`, severity: 'critical' }); }
  else if (topHolder > 30) { score += 8;  flags.push({ label: 'High Concentration',  desc: `Top wallet: ${topHolder.toFixed(1)}%`, severity: 'high' }); }
  else if (topHolder > 15) { score += 4;  flags.push({ label: 'Moderate Concentration', desc: `Top wallet: ${topHolder.toFixed(1)}%`, severity: 'medium' }); }
  else if (topHolder > 0)  safe.push({ label: 'Holder Distribution', desc: `Top wallet: ${topHolder.toFixed(1)}%` });

  // ── HOLDER COUNT — only flag small new tokens ──
  const holderCount = parseInt(goplus?.holder_count || 0);
  if (holderCount > 0 && holderCount < 30)         { score += 15; flags.push({ label: 'Extremely Few Holders', desc: `Only ${holderCount} holders — pump & dump risk`, severity: 'critical' }); }
  else if (holderCount >= 30 && holderCount < 100)  { score += 10; flags.push({ label: 'Very Few Holders',     desc: `Only ${holderCount} holders`, severity: 'high' }); }
  else if (holderCount >= 100 && holderCount < 300) { score += 4;  flags.push({ label: 'Low Holder Count',     desc: `${holderCount} holders`, severity: 'medium' }); }
  else if (holderCount >= 300) safe.push({ label: 'Holder Count', desc: `${holderCount.toLocaleString()} holders` });

  // ── CONTRACT VERIFICATION ──
  if (etherscan?.SourceCode === '') { score += 10; flags.push({ label: 'Unverified Contract', desc: 'Source code hidden — cannot be audited', severity: 'high' }); }
  else if (etherscan?.SourceCode)   safe.push({ label: 'Verified Contract', desc: 'Source code publicly auditable' });

  // ── LIQUIDITY AMOUNT ──
  const liqUSD = parseFloat(dex?.liquidity?.usd || 0);
  if (dex && liqUSD === 0)               { score += 15; flags.push({ label: 'Zero Liquidity',             desc: 'No liquidity found — cannot trade safely', severity: 'critical' }); }
  else if (liqUSD > 0 && liqUSD < 1000)  { score += 15; flags.push({ label: 'Dangerously Low Liquidity', desc: `Only $${liqUSD.toLocaleString()}`, severity: 'critical' }); }
  else if (liqUSD >= 1000 && liqUSD < 5000)  { score += 8; flags.push({ label: 'Very Low Liquidity',    desc: `$${liqUSD.toLocaleString()}`, severity: 'high' }); }
  else if (liqUSD >= 5000 && liqUSD < 20000) { score += 3; flags.push({ label: 'Low Liquidity',         desc: `$${liqUSD.toLocaleString()}`, severity: 'medium' }); }
  else if (liqUSD >= 20000) safe.push({ label: 'Good Liquidity', desc: `$${liqUSD.toLocaleString()}` });

  // ── COMPOUNDING ──
  const criticalCount = flags.filter(f => f.severity === 'critical').length;
  const highCount = flags.filter(f => f.severity === 'high').length;
  if (criticalCount >= 3) score += 15;
  else if (criticalCount >= 2) score += 8;
  if (lpUnlocked && ownerActive && isMintable) score += 15;
  else if (lpUnlocked && ownerActive) score += 10;

  return { score: Math.min(score, 100), risk: score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW', flags, safe };
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', db: 'supabase', chains: Object.keys(CHAIN_CONFIG).length }));

app.post('/api/scan', async (req, res) => {
  const { address, chain = 'ETH', email } = req.body;
  if (!address || address.length < 10) return res.status(400).json({ error: 'Invalid address' });
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) return res.status(400).json({ error: 'Unsupported chain' });
  try {
    const [gp, hp, dx, eth] = await Promise.allSettled([
      fetchGoPlus(address, chainCfg.goplusId),
      fetchHoneypot(address, chainCfg.goplusId),
      fetchDexScreener(address),
      fetchEtherscan(address, chainCfg.goplusId),
    ]);
    const goplusData   = gp.status  === 'fulfilled' ? gp.value  : null;
    const honeypotData = hp.status  === 'fulfilled' ? hp.value  : null;
    const dexData      = dx.status  === 'fulfilled' ? dx.value  : null;
    const ethData      = eth.status === 'fulfilled' ? eth.value : null;
    const { score, risk, flags, safe } = calculateScore(goplusData, honeypotData, dexData, ethData, chain);
    res.json({
      address, chain, chainName: chainCfg.name, score, risk, flags, safe,
      tokenInfo: {
        name:    goplusData?.token_name   || dexData?.baseToken?.name   || 'Unknown',
        symbol:  goplusData?.token_symbol || dexData?.baseToken?.symbol || '???',
        holders: parseInt(goplusData?.holder_count || 0),
      },
      marketData: dexData ? {
        priceUSD:       parseFloat(dexData.priceUsd || 0),
        liquidityUSD:   parseFloat(dexData.liquidity?.usd || 0),
        volume24h:      parseFloat(dexData.volume?.h24 || 0),
        priceChange24h: parseFloat(dexData.priceChange?.h24 || 0),
      } : null,
      sources: { goplus: !!goplusData, honeypot: !!honeypotData, dexscreener: !!dexData, etherscan: !!ethData },
      scannedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: 'Scan failed. Try again.' }); }
});

app.get('/api/user/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) {
      await supabase.from('users').insert({ email, plan: 'free' });
      return res.json({ email, plan: 'free', unlimited: false, scansToday: 0, scansLeft: 3 });
    }
    const today = new Date().toISOString().split('T')[0];
    const scansToday = user.scan_date === today ? user.scans_today : 0;
    res.json({ email: user.email, plan: user.plan, unlimited: user.plan !== 'free', scansToday, scansLeft: user.plan !== 'free' ? 999 : Math.max(0, 3 - scansToday) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/checkout', async (req, res) => {
  const { email, plan } = req.body;
  if (!email || !PRICES[plan]) return res.status(400).json({ error: 'Invalid request' });
  try {
    let customerId;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (user?.stripe_customer_id) {
      customerId = user.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await supabase.from('users').upsert({ email, stripe_customer_id: customerId }, { onConflict: 'email' });
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${FRONTEND_URL}?cancelled=true`,
      metadata: { email, plan },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/portal', async (req, res) => {
  const { email } = req.body;
  try {
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user?.stripe_customer_id) return res.status(404).json({ error: 'No subscription found' });
    const session = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: FRONTEND_URL });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata?.email;
    const plan  = session.metadata?.plan;
    if (email && plan) {
      if (plan === 'whitelabel') {
        // White-label add-on — activate whitelabel AND upgrade to pro if not already on pro/whale
        supabase.from('users').select('plan').eq('email', email).single().then(({ data: u }) => {
          const newPlan = (u?.plan === 'whale') ? 'whale' : 'pro';
          supabase.from('users').upsert({
            email,
            plan: newPlan,
            stripe_customer_id: session.customer,
            whitelabel_active: true,
            whitelabel_subscription_id: session.subscription
          }, { onConflict: 'email' }).then(() => console.log(`✅ White-label activated for ${email} — plan: ${newPlan}`));
        });
      } else {
        supabase.from('users').upsert({ email, plan, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription }, { onConflict: 'email' })
          .then(() => console.log(`✅ Upgraded ${email} to ${plan}`));
      }
    }
  } else if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
    const subId = event.data.object.id || event.data.object.subscription;
    const customerId = event.data.object.customer;
    // Check if it's a whitelabel sub cancellation
    supabase.from('users').select('*').eq('whitelabel_subscription_id', subId).single()
      .then(({ data: wlUser }) => {
        if (wlUser) {
          supabase.from('users').update({ whitelabel_active: false, whitelabel_subscription_id: null }).eq('email', wlUser.email);
          console.log(`❌ White-label cancelled for ${wlUser.email}`);
        }
      });
    // Also handle main plan cancellation
    supabase.from('users').select('*').eq('stripe_customer_id', customerId).single()
      .then(({ data: user }) => { if (user && user.whitelabel_subscription_id !== subId) supabase.from('users').update({ plan: 'free' }).eq('email', user.email); });
  }
  res.json({ received: true });
});

// ── API KEY ROUTES ────────────────────────────────────────────────────────────

app.post('/api/keys/generate', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || user.plan !== 'whale') return res.status(403).json({ error: 'Whale plan required for API access' });
    const { data: existing } = await supabase.from('api_keys').select('*').eq('user_email', email).single();
    if (existing) return res.json({ apiKey: existing.api_key, created: false });
    const { data: newKey, error } = await supabase.from('api_keys').insert({ user_email: email }).select().single();
    if (error) throw error;
    res.json({ apiKey: newKey.api_key, created: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/keys/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || user.plan !== 'whale') return res.status(403).json({ error: 'Whale plan required' });
    const { data: key } = await supabase.from('api_keys').select('*').eq('user_email', email).single();
    if (!key) return res.json({ apiKey: null });
    res.json({ apiKey: key.api_key, requestsToday: key.requests_today, lastUsed: key.last_used });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/scan', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required. Add header: x-api-key: your_key' });
  try {
    const { data: keyData } = await supabase.from('api_keys').select('*').eq('api_key', apiKey).single();
    if (!keyData) return res.status(401).json({ error: 'Invalid API key' });
    const today = new Date().toISOString().split('T')[0];
    if (keyData.request_date !== today) {
      await supabase.from('api_keys').update({ requests_today: 0, request_date: today }).eq('api_key', apiKey);
      keyData.requests_today = 0;
    }
    if (keyData.requests_today >= 1000) return res.status(429).json({ error: 'Daily limit of 1000 API requests reached' });
    await supabase.from('api_keys').update({ requests_today: keyData.requests_today + 1, last_used: new Date().toISOString() }).eq('api_key', apiKey);
    const { address, chain = 'ETH' } = req.body;
    if (!address || address.length < 10) return res.status(400).json({ error: 'Invalid address' });
    const chainCfg = CHAIN_CONFIG[chain];
    if (!chainCfg) return res.status(400).json({ error: 'Unsupported chain' });
    const [gp, hp, dx, eth] = await Promise.allSettled([
      fetchGoPlus(address, chainCfg.goplusId),
      fetchHoneypot(address, chainCfg.goplusId),
      fetchDexScreener(address),
      fetchEtherscan(address, chainCfg.goplusId),
    ]);
    const goplusData   = gp.status  === 'fulfilled' ? gp.value  : null;
    const honeypotData = hp.status  === 'fulfilled' ? hp.value  : null;
    const dexData      = dx.status  === 'fulfilled' ? dx.value  : null;
    const ethData      = eth.status === 'fulfilled' ? eth.value : null;
    const { score, risk, flags, safe } = calculateScore(goplusData, honeypotData, dexData, ethData, chain);
    res.json({
      address, chain, chainName: chainCfg.name, score, risk, flags, safe,
      tokenInfo: { name: goplusData?.token_name || dexData?.baseToken?.name || 'Unknown', symbol: goplusData?.token_symbol || dexData?.baseToken?.symbol || '???' },
      marketData: dexData ? { priceUSD: parseFloat(dexData.priceUsd || 0), liquidityUSD: parseFloat(dexData.liquidity?.usd || 0), priceChange24h: parseFloat(dexData.priceChange?.h24 || 0) } : null,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/watchlist', async (req, res) => {
  const { email, address, chain, tokenName, tokenSymbol } = req.body;
  try {
    const { data, error } = await supabase.from('watchlist')
      .upsert({ user_email: email, address, chain, token_name: tokenName, token_symbol: tokenSymbol }, { onConflict: 'user_email,address,chain' })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/watchlist/:email', async (req, res) => {
  try {
    const { data, error } = await supabase.from('watchlist').select('*')
      .eq('user_email', decodeURIComponent(req.params.email))
      .order('added_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/watchlist', async (req, res) => {
  const { email, address, chain } = req.body;
  try {
    await supabase.from('watchlist').delete()
      .eq('user_email', email).eq('address', address).eq('chain', chain);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/watchlist/update', async (req, res) => {
  const { email, address, chain, tokenName, tokenSymbol, riskLevel, riskScore } = req.body;
  try {
    const { data: existing } = await supabase.from('watchlist').select('last_risk_level')
      .eq('user_email', email).eq('address', address).eq('chain', chain).single();
    await supabase.from('watchlist').update({
      token_name: tokenName, token_symbol: tokenSymbol,
      last_risk_level: riskLevel, last_risk_score: riskScore,
      last_checked: new Date().toISOString()
    }).eq('user_email', email).eq('address', address).eq('chain', chain);
    const emailSent = riskLevel === 'HIGH' && existing?.last_risk_level !== 'HIGH';
    if (emailSent) {
      await sendAlertEmail(email, tokenName, tokenSymbol, riskLevel, riskScore, address, chain);
      await sendTelegramAlert(email, tokenName, tokenSymbol, riskScore, address, chain);
    }
    res.json({ success: true, emailSent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TELEGRAM ROUTES ───────────────────────────────────────────────────────────
app.post('/api/telegram/connect', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || user.plan !== 'whale') return res.status(403).json({ error: 'Whale plan required' });
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();
    pendingVerifications[code] = email;
    setTimeout(() => delete pendingVerifications[code], 10 * 60 * 1000); // expire in 10 min
    res.json({ code, botUsername: 'RugRadarScanBot', deepLink: `https://t.me/RugRadarScanBot?start=${code}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/telegram/status/:email', async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('email', decodeURIComponent(req.params.email)).single();
    res.json({ connected: !!user?.telegram_chat_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/telegram/disconnect', async (req, res) => {
  const { email } = req.body;
  try {
    await supabase.from('users').update({ telegram_chat_id: null }).eq('email', email);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── WHITE-LABEL ROUTES ────────────────────────────────────────────────────────

app.get('/api/wl/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase.from('whitelabel').select('*').eq('slug', req.params.slug).eq('active', true).single();
    if (error || !data) return res.status(404).json({ error: 'White-label config not found' });
    res.json({
      brandName: data.brand_name,
      logoUrl: data.logo_url,
      primaryColor: data.primary_color,
      slug: data.slug,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wl', async (req, res) => {
  const { slug, brandName, logoUrl, primaryColor, ownerEmail } = req.body;
  if (!slug || !brandName || !ownerEmail) return res.status(400).json({ error: 'slug, brandName and ownerEmail required' });
  try {
    const { data: user } = await supabase.from('users').select('plan').eq('email', ownerEmail).single();
    if (!user || (user.plan !== 'whale' && !user.whitelabel_active)) return res.status(403).json({ error: 'White-label add-on required. Upgrade at rugradar-rho.vercel.app' });
    const { data, error } = await supabase.from('whitelabel').upsert({
      slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, ''),
      brand_name: brandName,
      logo_url: logoUrl || null,
      primary_color: primaryColor || '#ff3b3b',
      owner_email: ownerEmail,
      active: true,
    }, { onConflict: 'slug' }).select().single();
    if (error) throw error;
    res.json({ success: true, url: `https://rugradar-rho.vercel.app?wl=${data.slug}`, ...data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`🛡 RugRadar running on port ${PORT} — ${Object.keys(CHAIN_CONFIG).length} chains supported`);
  startTelegramPolling();
});
