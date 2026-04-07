# Supabase Setup — Step by Step
# Takes about 15 minutes. Free forever for your usage level.

## Step 1: Create your Supabase account
Go to https://supabase.com and click "Start for free"
Sign up with GitHub (easiest) or email

## Step 2: Create a new project
1. Click "New Project"
2. Name it: rugradar
3. Set a strong database password (save it somewhere)
4. Pick a region closest to you (US East, EU West, etc.)
5. Click "Create new project"
6. Wait ~2 minutes for it to set up

## Step 3: Create your database tables
1. In your Supabase project, click "SQL Editor" in the left sidebar
2. Click "New query"
3. Open the file: supabase_schema.sql
4. Copy ALL the contents
5. Paste into the SQL editor
6. Click the green "Run" button
7. You should see "Success. No rows returned"

That just created all your tables:
- users (stores every account)
- scans (stores every scan history)
- watchlist (saved tokens)

## Step 4: Get your API keys
1. Click "Project Settings" (gear icon, bottom left)
2. Click "API" in the settings menu
3. You need TWO things:

   PROJECT URL:
   Looks like: https://abcdefghijkl.supabase.co
   → Copy this → paste as SUPABASE_URL in your .env

   SERVICE ROLE KEY (NOT the anon key):
   Looks like: eyJhbGciOiJIUzI1NiIsInR5cCI6...
   → Copy this → paste as SUPABASE_SERVICE_KEY in your .env
   ⚠️ IMPORTANT: Use the SERVICE ROLE key, not the anon key
   ⚠️ NEVER put this key in your frontend code

## Step 5: Create your .env file
Create a file called .env in the rugradar folder:

```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...your-service-role-key

STRIPE_SECRET_KEY=sk_test_your_stripe_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
STRIPE_PRICE_PRO=price_your_pro_price_id
STRIPE_PRICE_WHALE=price_your_whale_price_id

ETHERSCAN_KEY=your_etherscan_api_key
FRONTEND_URL=http://localhost:5500
PORT=3001
```

## Step 6: Install and run
```bash
npm install
npm start
```

You should see:
🛡  RugRadar running on http://localhost:3001
   Database: Supabase (persistent)

## Step 7: Test it works
Open your browser and go to:
http://localhost:3001/api/health

You should see: {"status":"ok","db":"supabase"}

## What Supabase gives you FREE
- 500MB database storage
- 50,000 monthly active users
- Unlimited API requests
- Built-in dashboard to see your users and data
- Automatic backups

## Viewing your data
Any time you want to see your users, go to:
Supabase Dashboard → Table Editor → users table

You'll see every signup, their plan, scan count, everything.

## When you deploy to Railway
Add these environment variables in Railway:
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- (+ all your other env vars)

Supabase is cloud-hosted so it works from anywhere automatically.
