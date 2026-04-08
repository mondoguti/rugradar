const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const app = express();
const PORT = process.env.PORT || 3001;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const ETHERSCAN_KEY = 'YOUR_REAL_ETHERSCAN_KEY';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';
const PRICES = { pro: process.env.STRIPE_PRICE_PRO || 'price_placeholder', whale: process.env.STRIPE_PRICE_WHALE || 'price_placeholder' };
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.get('/api/health', (_, res) => res.json({ status: 'ok', db: 'supabase' }));
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
      cancel_url: `${FRONTEND_URL}?cancelled=true`,
      metadata: { email, plan },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scan', async (req, res) => {
  const { address, chain = 'ETH', email } = req.body;
  if (!address || address.length < 10) return res.status(400).json({ error: 'Invalid address' });
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) return res.status(400).json({ error: 'Unsupported chain' });
  try {
    const [gp, hp, dx] = await Promise.allSettled([
      fetchGoPlus(address, chainCfg.goplusId),
      fetchHoneypot(address, chainCfg.goplusId),
      fetchDexScreener(address),
    ]);
    const goplusData = gp.status === 'fulfilled' ? gp.value : null;
    const honeypotData = hp.status === 'fulfilled' ? hp.value : null;
    const dexData = dx.status === 'fulfilled' ? dx.value : null;
    const { score, risk, flags, safe } = calculateScore(goplusData, honeypotData, dexData, null);
    res.json({
      address, chain, chainName: chainCfg.name, score, risk, flags, safe,
      tokenInfo: { name: goplusData?.token_name || dexData?.baseToken?.name || 'Unknown', symbol: goplusData?.token_symbol || dexData?.baseToken?.symbol || '???', holders: parseInt(goplusData?.holder_count || 0) },
      marketData: dexData ? { priceUSD: parseFloat(dexData.priceUsd || 0), liquidityUSD: parseFloat(dexData.liquidity?.usd || 0), volume24h: parseFloat(dexData.volume?.h24 || 0), priceChange24h: parseFloat(dexData.priceChange?.h24 || 0) } : null,
      sources: { goplus: !!goplusData, honeypot: !!honeypotData, dexscreener: !!dexData, etherscan: false },
      scannedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: 'Scan failed' }); }
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
    const plan = session.metadata?.plan;
    if (email && plan) {
      supabase.from('users').upsert({ email, plan, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription }, { onConflict: 'email' })
        .then(() => console.log(`✅ Upgraded ${email} to ${plan}`));
    }
  }
  res.json({ received: true });
});
app.listen(PORT, () => console.log(`RugRadar running on port ${PORT}`));