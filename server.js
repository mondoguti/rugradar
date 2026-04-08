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
  pro:   process.env.STRIPE_PRICE_PRO   || 'price_placeholder',
  whale: process.env.STRIPE_PRICE_WHALE || 'price_placeholder',
};

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;

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

function calculateScore(goplus, honeypot, dex, etherscan) {
  let score = 0;
  const flags = [], safe = [];

  const isHoneypot = goplus?.is_honeypot === '1' || honeypot?.honeypotResult?.isHoneypot === true;
  isHoneypot
    ? (score += 25, flags.push({ label: 'Honeypot Detected', desc: 'Cannot sell — funds will be trapped', severity: 'critical' }))
    : safe.push({ label: 'Honeypot Test', desc: 'Token can be bought and sold freely' });

  const buyTax  = parseFloat(goplus?.buy_tax  || honeypot?.simulationResult?.buyTax  || 0);
  const sellTax = parseFloat(goplus?.sell_tax || honeypot?.simulationResult?.sellTax || 0);
  if (sellTax > 20 || buyTax > 20)      { score += 15; flags.push({ label: 'Extreme Tax',   desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%`, severity: 'high' }); }
  else if (sellTax > 10 || buyTax > 10) { score += 8;  flags.push({ label: 'High Tax',      desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%`, severity: 'medium' }); }
  else safe.push({ label: 'Tax Rate', desc: `Buy: ${buyTax.toFixed(1)}% / Sell: ${sellTax.toFixed(1)}%` });

  goplus?.is_mintable === '1'
    ? (score += 10, flags.push({ label: 'Mintable Supply', desc: 'Owner can print unlimited tokens', severity: 'high' }))
    : safe.push({ label: 'Fixed Supply', desc: 'Cannot mint new tokens' });

  const renounced = goplus?.owner_address === '0x0000000000000000000000000000000000000000';
  !renounced && goplus?.owner_address
    ? (score += 10, flags.push({ label: 'Owner Active', desc: 'Contract not renounced — owner can modify', severity: 'medium' }))
    : safe.push({ label: 'Contract Renounced', desc: 'Owner gave up control' });

  goplus?.lp_locked !== '1'
    ? (score += 10, flags.push({ label: 'Liquidity Unlocked', desc: 'LP can be removed anytime — rug risk', severity: 'high' }))
    : safe.push({ label: 'Liquidity Locked', desc: 'LP cannot be removed' });

  goplus?.is_proxy     === '1' && (score += 8,  flags.push({ label: 'Proxy Contract',      desc: 'Contract logic can be swapped without warning', severity: 'medium' }));
  goplus?.hidden_owner === '1' && (score += 8,  flags.push({ label: 'Hidden Owner',        desc: 'Concealed owner can reclaim control', severity: 'high' }));
  goplus?.is_blacklisted === '1' && (score += 5, flags.push({ label: 'Blacklist Function', desc: 'Owner can block wallets from selling', severity: 'medium' }));

  const topHolder = parseFloat(goplus?.holders?.[0]?.percent || 0) * 100;
  if (topHolder > 50)      { score += 5; flags.push({ label: 'Whale Concentration', desc: `Top wallet holds ${topHolder.toFixed(1)}%`, severity: 'high' }); }
  else if (topHolder > 20) { score += 2; flags.push({ label: 'High Concentration',  desc: `Top wallet holds ${topHolder.toFixed(1)}%`, severity: 'low' }); }
  else if (topHolder > 0)  safe.push({ label: 'Holder Distribution', desc: `Top wallet holds ${topHolder.toFixed(1)}%` });

  if (etherscan) {
    etherscan.SourceCode === ''
      ? (score += 4, flags.push({ label: 'Unverified Contract', desc: 'Source code is hidden — cannot be audited', severity: 'medium' }))
      : safe.push({ label: 'Verified Contract', desc: 'Source code is publicly auditable' });
  }

  const liqUSD = parseFloat(dex?.liquidity?.usd || 0);
  if (liqUSD > 0 && liqUSD < 5000) { score += 5; flags.push({ label: 'Very Low Liquidity', desc: `Only $${liqUSD.toLocaleString()} — easy to manipulate`, severity: 'medium' }); }
  else if (liqUSD >= 5000) safe.push({ label: 'Liquidity', desc: `$${liqUSD.toLocaleString()} in liquidity` });

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
    const { score, risk, flags, safe } = calculateScore(goplusData, honeypotData, dexData, ethData);
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
      supabase.from('users').upsert({ email, plan, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription }, { onConflict: 'email' })
        .then(() => console.log(`✅ Upgraded ${email} to ${plan}`));
    }
  } else if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    supabase.from('users').select('*').eq('stripe_customer_id', customerId).single()
      .then(({ data: user }) => { if (user) supabase.from('users').update({ plan: 'free' }).eq('email', user.email); });
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
    const { score, risk, flags, safe } = calculateScore(goplusData, honeypotData, dexData, ethData);
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
    if (emailSent) await sendAlertEmail(email, tokenName, tokenSymbol, riskLevel, riskScore, address, chain);
    res.json({ success: true, emailSent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.listen(PORT, () => console.log(`🛡 RugRadar running on port ${PORT} — ${Object.keys(CHAIN_CONFIG).length} chains supported`));
