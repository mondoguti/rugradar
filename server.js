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
app.listen(PORT, () => console.log(`RugRadar running on port ${PORT}`));