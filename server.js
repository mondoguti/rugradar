// RugRadar — Backend with Supabase DB + Stripe Payments
// Real persistent database — no more losing users on restart!

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_YOUR_KEY_HERE');
const ETHERSCAN_KEY = process.env.ETHERSCAN_KEY || 'AXVGSMJ8E546YEDAYQKXSQSX2ME4JPTPAD';

const app = express();
const PORT = process.env.PORT || 3001;

// ── SUPABASE CLIENT ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL     || 'https://pzjtninqghkiczbscolp.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6anRuaW5xZ2hraWN6YnNjb2xwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTU4MTY5MSwiZXhwIjoyMDkxMTU3NjkxfQ.7ZymgCfQwHh4prHdUmp-ZviaBrJ-65KWfTv_YHyeSMU' // NOT the anon key
);

// ── CONFIG ────────────────────────────────────────────────────────────────────
const ETHERSCAN_KEY         = process.env.ETHERSCAN_KEY         || 'YourEtherscanKeyHere';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_YOUR_WEBHOOK_SECRET';
const FRONTEND_URL          = process.env.FRONTEND_URL          || 'http://localhost:5500';

const PRICES = {
  pro:   process.env.STRIPE_PRICE_PRO   || 'price_PRO_ID_HERE',
  whale: process.env.STRIPE_PRICE_WHALE || 'price_WHALE_ID_HERE',
};

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── CHAIN CONFIG ──────────────────────────────────────────────────────────────
const CHAIN_CONFIG = {
  ETH:  { goplusId: '1',      etherscanBase: 'https://api.etherscan.io/v2/api', name: 'Ethereum' },
  BSC:  { goplusId: '56',     etherscanBase: 'https://api.bscscan.com/api',     name: 'BNB Chain' },
  BASE: { goplusId: '8453',   etherscanBase: 'https://api.basescan.org/api',    name: 'Base' },
  ARB:  { goplusId: '42161',  etherscanBase: 'https://api.arbiscan.io/api',     name: 'Arbitrum' },
  SOL:  { goplusId: 'solana', etherscanBase: null,                              name: 'Solana' },
};

// ══════════════════════════════════════════════════════════════════════════════
//  DATABASE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// Get or create a user by email
async function getOrCreateUser(email) {
  // Try to find existing user
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (existing) return existing;

  // Create new user
  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ email, plan: 'free' })
    .select()
    .single();

  if (error) throw new Error(`Failed to create user: ${error.message}`);
  console.log(`✅ New user created: ${email}`);
  return newUser;
}

// Check and increment scan count — returns true if allowed
async function checkAndIncrementScans(email) {
  const user = await getOrCreateUser(email);
  if (user.plan === 'pro' || user.plan === 'whale') return true; // unlimited

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Reset counter if it's a new day
  if (user.scan_date !== today) {
    await supabase
      .from('users')
      .update({ scans_today: 0, scan_date: today })
      .eq('email', email);
    user.scans_today = 0;
  }

  if (user.scans_today >= 3) return false; // limit hit

  // Increment
  await supabase
    .from('users')
    .update({ scans_today: user.scans_today + 1 })
    .eq('email', email);

  return true;
}

// Save a scan to history
async function saveScan(email, address, chain, result) {
  try {
    await supabase.from('scans').insert({
      user_email:   email || null,
      address,
      chain,
      chain_name:   result.chainName,
      token_name:   result.tokenInfo?.name,
      token_symbol: result.tokenInfo?.symbol,
      risk_level:   result.risk,
      risk_score:   result.score,
      flags:        result.flags,
      safe_checks:  result.safe,
      market_data:  result.marketData,
      sources:      result.sources,
    });
  } catch (e) {
    console.error('Failed to save scan:', e.message); // Non-fatal
  }
}

// Update user plan (called from Stripe webhook)
async function setUserPlan(email, plan, stripeCustomerId, stripeSubscriptionId) {
  await supabase
    .from('users')
    .upsert({
      email,
      plan,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
    }, { onConflict: 'email' });
  console.log(`✅ Plan updated: ${email} → ${plan}`);
}

// Find user by Stripe customer ID (for webhook events)
async function getUserByStripeId(customerId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .single();
  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CRYPTO SCAN APIs (same as before)
// ══════════════════════════════════════════════════════════════════════════════

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
  } catch (e) { console.error('GoPlus:', e.message); return null; }
}

async function fetchHoneypot(address, chainId) {
  try {
    if (chainId === 'solana') return null;
    return await fetchJSON(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`);
  } catch (e) { console.error('Honeypot:', e.message); return null; }
}

async function fetchDexScreener(address) {
  try {
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    return data?.pairs?.[0] || null;
  } catch (e) { console.error('DEXScreener:', e.message); return null; }
}

async function fetchEtherscan(address, chainId) {
  try {
    if (chainId === 'solana') return null;
    const key = Object.keys(CHAIN_CONFIG).find(k => CHAIN_CONFIG[k].goplusId === chainId);
    const base = CHAIN_CONFIG[key]?.etherscanBase;
    if (!base) return null;
    const data = await fetchJSON(`${base}?module=contract&action=getsourcecode&address=${address}&apikey=${ETHERSCAN_KEY}`);
    return data?.result?.[0] || null;
  } catch (e) { console.error('Etherscan:', e.message); return null; }
}

function calculateScore(goplus, honeypot, dex, etherscan) {
  let score = 0;
  const flags = [], safe = [];

  const isHoneypot = goplus?.is_honeypot === '1' || honeypot?.honeypotResult?.isHoneypot === true;
  isHoneypot
    ? (score += 25, flags.push({ label: 'Honeypot Detected', desc: 'Cannot sell — funds trapped', severity: 'critical' }))
    : safe.push({ label: 'Honeypot Test', desc: 'Buy and sell freely' });

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
    ? (score += 10, flags.push({ label: 'Owner Active', desc: 'Contract not renounced', severity: 'medium' }))
    : safe.push({ label: 'Contract Renounced', desc: 'Owner gave up control' });

  goplus?.lp_locked !== '1'
    ? (score += 10, flags.push({ label: 'Liquidity Unlocked', desc: 'LP can be removed anytime', severity: 'high' }))
    : safe.push({ label: 'Liquidity Locked', desc: 'LP cannot be rugged' });

  goplus?.is_proxy     === '1' && (score += 8,  flags.push({ label: 'Proxy Contract',      desc: 'Logic swappable without warning', severity: 'medium' }));
  goplus?.hidden_owner === '1' && (score += 8,  flags.push({ label: 'Hidden Owner',        desc: 'Concealed owner can reclaim control', severity: 'high' }));
  goplus?.is_blacklisted === '1' && (score += 5, flags.push({ label: 'Blacklist Function', desc: 'Owner can block wallets from selling', severity: 'medium' }));

  const topHolder = parseFloat(goplus?.holders?.[0]?.percent || 0) * 100;
  if (topHolder > 50)      { score += 5; flags.push({ label: 'Whale Concentration', desc: `Top wallet: ${topHolder.toFixed(1)}%`, severity: 'high' }); }
  else if (topHolder > 20) { score += 2; flags.push({ label: 'High Concentration',  desc: `Top wallet: ${topHolder.toFixed(1)}%`, severity: 'low' }); }
  else if (topHolder > 0)  safe.push({ label: 'Holder Distribution', desc: `Top wallet: ${topHolder.toFixed(1)}%` });

  etherscan?.SourceCode === ''
    ? (score += 4, flags.push({ label: 'Unverified Contract', desc: 'Source code hidden', severity: 'medium' }))
    : etherscan?.SourceCode && safe.push({ label: 'Verified Contract', desc: 'Publicly auditable' });

  const liqUSD = parseFloat(dex?.liquidity?.usd || 0);
  if (liqUSD > 0 && liqUSD < 5000) { score += 5; flags.push({ label: 'Very Low Liquidity', desc: `Only $${liqUSD.toLocaleString()}`, severity: 'medium' }); }
  else if (liqUSD >= 5000) safe.push({ label: 'Liquidity', desc: `$${liqUSD.toLocaleString()}` });

  return { score: Math.min(score, 100), risk: score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW', flags, safe };
}

// ══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── SCAN ─────────────────────────────────────────────────────────────────────
app.post('/api/scan', async (req, res) => {
  const { address, chain = 'ETH', email } = req.body;
  if (!address || address.length < 10) return res.status(400).json({ error: 'Invalid address' });

  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) return res.status(400).json({ error: 'Unsupported chain' });

  // Check scan limit
  if (email) {
    const allowed = await checkAndIncrementScans(email);
    if (!allowed) {
      return res.status(429).json({ error: 'Daily scan limit reached. Upgrade to Pro for unlimited scans.' });
    }
  }

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

    const result = {
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
    };

    // Save to DB in background (non-blocking)
    if (email) saveScan(email, address, chain, result);

    res.json(result);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Scan failed. Try again.' });
  }
});

// ── GET USER (plan status + today's scan count) ───────────────────────────────
app.get('/api/user/:email', async (req, res) => {
  try {
    const user = await getOrCreateUser(decodeURIComponent(req.params.email));
    const today = new Date().toISOString().split('T')[0];
    const scansToday = user.scan_date === today ? user.scans_today : 0;
    res.json({
      email:      user.email,
      plan:       user.plan,
      unlimited:  user.plan !== 'free',
      scansToday,
      scansLeft:  user.plan !== 'free' ? Infinity : Math.max(0, 3 - scansToday),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SCAN HISTORY ──────────────────────────────────────────────────────────────
app.get('/api/history/:email', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scans')
      .select('id, address, chain, chain_name, token_name, token_symbol, risk_level, risk_score, scanned_at')
      .eq('user_email', decodeURIComponent(req.params.email))
      .order('scanned_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WATCHLIST ─────────────────────────────────────────────────────────────────
app.get('/api/watchlist/:email', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .eq('user_email', decodeURIComponent(req.params.email))
      .order('added_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/watchlist', async (req, res) => {
  const { email, address, chain, tokenName, tokenSymbol } = req.body;
  try {
    const { data, error } = await supabase
      .from('watchlist')
      .upsert({ user_email: email, address, chain, token_name: tokenName, token_symbol: tokenSymbol }, { onConflict: 'user_email,address,chain' })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/watchlist', async (req, res) => {
  const { email, address, chain } = req.body;
  try {
    await supabase.from('watchlist').delete()
      .eq('user_email', email).eq('address', address).eq('chain', chain);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  STRIPE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/checkout', async (req, res) => {
  const { email, plan } = req.body;
  if (!email || !PRICES[plan]) return res.status(400).json({ error: 'Invalid request' });

  try {
    const user = await getOrCreateUser(email);
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('email', email);
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
    const user = await getOrCreateUser(email);
    if (!user.stripe_customer_id) return res.status(404).json({ error: 'No subscription found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: FRONTEND_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe event:', event.type);

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      if (s.metadata?.email && s.metadata?.plan) {
        await setUserPlan(s.metadata.email, s.metadata.plan, s.customer, s.subscription);
      }
      break;
    }
    case 'invoice.payment_failed':
    case 'customer.subscription.deleted': {
      const customerId = event.data.object.customer;
      const user = await getUserByStripeId(customerId);
      if (user) {
        await supabase.from('users').update({ plan: 'free' }).eq('email', user.email);
        console.log(`❌ Downgraded ${user.email} to free`);
      }
      break;
    }
  }

  res.json({ received: true });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', db: 'supabase', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🛡  RugRadar running on http://localhost:${PORT}`);
  console.log(`   Database: Supabase (persistent)\n`);
});
