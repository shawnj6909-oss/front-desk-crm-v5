# Front Desk CRM v5 — Production Deployment Guide

Get the system live in production. Takes ~30 minutes.

---

## Prerequisites

✅ You have:
- Supabase account (test database already created)
- Twilio account (logged in)
- Stripe account (test mode)
- Telegram bot token (create one: @BotFather)
- LiveKit account
- GitHub repo access

---

## Phase 1: Supabase Setup (5 min)

### 1.1 Create Production Project

Go to https://app.supabase.com and create a new project:
- **Name:** `front-desk-crm-prod`
- **Region:** us-east-1 (or closest to you)
- **Password:** Save it

### 1.2 Link Production Project

```bash
cd /Users/seanjing/front-desk-crm
supabase link --project-ref <your-prod-project-id>
```

### 1.3 Apply Migrations

```bash
supabase db push
```

This applies:
- 001_base_schema.sql (core tables)
- 004_home_services_extension.sql (v5 features)

### 1.4 Get Production Credentials

Go to **Settings → API** and copy:
- `SUPABASE_URL` (Project URL)
- `SUPABASE_ANON_KEY` (anon public)
- `SUPABASE_SERVICE_ROLE_KEY` (service_role)

Save these for `.env.production` later.

---

## Phase 2: Twilio Setup (10 min)

### 2.1 Create New Phone Number

**Option A: Via CLI (Recommended)**

```bash
# Install Twilio CLI
npm install -g twilio-cli

# Authenticate
twilio login

# Create a new phone number
twilio phone-numbers:buy:local \
  --country-code US \
  --area-code 855 \
  --friendly-name "Ownly Front Desk demo 2"
```

**Option B: Via Web Console**

Go to: https://console.twilio.com/us1/develop/phone-numbers/manage/incoming

1. Click "Buy a Number"
2. Area code: 855 (or any)
3. Type: Toll-Free
4. Name: "Ownly Front Desk demo 2"
5. Buy

### 2.2 Configure Voice Routing

Go to your phone number settings and set:
- **Voice → A Call Comes In:** Send to SIP Trunk
- **SIP Trunk:** Your LiveKit SIP trunk (created below)

### 2.3 Configure SMS Routing

Go to SMS settings:
- **Incoming Messages → Webhook URL:** 
  ```
  https://<your-supabase-project-id>.supabase.co/functions/v1/api
  ```
- **Webhook Method:** POST
- **Add Auth:** `Authorization: Bearer <TWILIO_WEBHOOK_SECRET>`

### 2.4 Get Twilio Credentials

Go to **Account → API Keys & Tokens**:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER` (the number you just created)

---

## Phase 3: LiveKit Setup (5 min)

### 3.1 Create LiveKit Project

Go to https://cloud.livekit.io and create a new project:
- **Name:** front-desk-crm-prod
- **Region:** us-east-1

### 3.2 Create SIP Trunk

In LiveKit Cloud:
1. Go to **SIP Trunks**
2. Click "Create Trunk"
3. Set:
   - **Name:** front-desk-prod
   - **Inbound Address:** Your Twilio SIP endpoint (or wildcard)

### 3.3 Get LiveKit Credentials

From your project:
- `LIVEKIT_URL` (WebRTC endpoint)
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

---

## Phase 4: Telegram Setup (3 min)

### 4.1 Create Owner Bot

Message @BotFather on Telegram:
```
/newbot
Name: Ownly Front Desk Owner
Username: ownly_front_desk_bot
```

Copy the token: `TELEGRAM_OWNER_BOT_TOKEN`

### 4.2 Create Client Bot

Repeat for client-facing:
```
/newbot
Name: Ownly Front Desk Client
Username: ownly_front_desk_client_bot
```

Copy: `TELEGRAM_CLIENT_BOT_TOKEN`

### 4.3 Set Webhooks

For each bot, set webhook to:
```bash
curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-supabase-project-id>.supabase.co/functions/v1/api",
    "secret_token": "<random-secret>"
  }'
```

---

## Phase 5: Stripe Setup (2 min)

### 5.1 Get Stripe Keys

Go to https://dashboard.stripe.com/apikeys:
- `STRIPE_PUBLIC_KEY` (publishable)
- `STRIPE_SECRET_KEY` (secret)
- `STRIPE_WEBHOOK_SECRET` (create endpoint for `/api` webhook)

### 5.2 Create Webhook Endpoint

In Stripe Dashboard:
1. **Developers → Webhooks**
2. **Add endpoint**
3. **URL:** `https://<your-supabase-project-id>.supabase.co/functions/v1/api`
4. **Events:** `charge.succeeded`, `charge.failed`, `setup_intent.succeeded`

---

## Phase 6: Supabase Edge Function Deployment (5 min)

### 6.1 Create `.env.production`

In repo root:
```bash
cat > .env.production << 'EOF'
# Supabase
SUPABASE_URL=https://<your-prod-project-id>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>

# Twilio
TWILIO_ACCOUNT_SID=<your-account-sid>
TWILIO_AUTH_TOKEN=<your-auth-token>
TWILIO_PHONE_NUMBER=<your-new-number>
TWILIO_WEBHOOK_SECRET=<random-secret>

# LiveKit
LIVEKIT_URL=https://<your-livekit-url>
LIVEKIT_API_KEY=<your-api-key>
LIVEKIT_API_SECRET=<your-api-secret>

# Telegram
TELEGRAM_OWNER_BOT_TOKEN=<owner-bot-token>
TELEGRAM_CLIENT_BOT_TOKEN=<client-bot-token>
TELEGRAM_WEBHOOK_SECRET=<random-secret>

# Stripe
STRIPE_PUBLIC_KEY=<your-public-key>
STRIPE_SECRET_KEY=<your-secret-key>
STRIPE_WEBHOOK_SECRET=<your-webhook-secret>

# Encryption
ENCRYPTION_KEY=<generate-32-byte-key>

# Environment
ENVIRONMENT=production
EOF
```

### 6.2 Generate Encryption Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output to `ENCRYPTION_KEY` in `.env.production`

### 6.3 Deploy Edge Functions

```bash
# Set environment
export SUPABASE_ACCESS_TOKEN=<your-access-token>

# Deploy
supabase functions deploy api --env-file .env.production
```

---

## Phase 7: LiveKit Voice Agent Deployment (5 min)

### 7.1 Build Voice Agent

```bash
cd src/voice-agent
pip install -r requirements.txt
```

### 7.2 Deploy to LiveKit

```bash
lk app deploy ownly-crm-voice-agent-prod \
  --image ownly-crm-voice-agent:latest \
  --env SUPABASE_URL=https://<project-id>.supabase.co \
  --env SUPABASE_KEY=<anon-key> \
  --env ANTHROPIC_API_KEY=<your-api-key> \
  --env LIVEKIT_URL=https://<livekit-url> \
  --env LIVEKIT_API_KEY=<api-key> \
  --env LIVEKIT_API_SECRET=<api-secret>
```

---

## Phase 8: Tenant Onboarding (5 min)

### 8.1 Create First Tenant

```bash
# Connect to prod database
psql postgresql://<user>:<password>@<host>/postgres

-- Create tenant
insert into tenants (name, stripe_account_id, locale)
  values ('Demo Company', 'acct_xxx', 'en');

-- Get tenant ID
select id from tenants where name = 'Demo Company';
```

### 8.2 Create Service Area & Hours

```sql
-- Service area (zip codes)
insert into service_area_zips (tenant_id, zip)
  select '<tenant-id>', zip
  from (values ('78704'), ('78701'), ('75214')) as t(zip);

-- Business hours (9am-5pm, Mon-Fri)
insert into business_hours (tenant_id, weekday, start_min, end_min)
  select '<tenant-id>', dow, 540, 1020
  from (values (1), (2), (3), (4), (5)) as t(dow);

-- Rate card frequencies
insert into rate_card_frequencies (tenant_id, name)
  select '<tenant-id>', freq
  from (values ('once'), ('weekly'), ('biweekly')) as t(freq);

-- Sample rates
insert into rate_card_entries (tenant_id, beds, baths, frequency_id, price_cents, service_minutes)
  select '<tenant-id>', 2, 1, f.id, 18000, 120
  from rate_card_frequencies f
  where f.tenant_id = '<tenant-id>' and f.name = 'once';
```

### 8.3 Create Default Crew

```sql
-- Default crew for single-operator
insert into crews (tenant_id, name, home_base_zip)
  values ('<tenant-id>', 'Owner', '78704');

-- Crew shifts (9am-5pm, Mon-Fri)
insert into crew_shifts (crew_id, weekday, start_min, end_min)
  select c.id, dow, 540, 1020
  from crews c, (values (1), (2), (3), (4), (5)) as t(dow)
  where c.tenant_id = '<tenant-id>';
```

---

## Phase 9: Verification (5 min)

### 9.1 Test Inbound Call

From your phone, call the new Twilio number:
- Should hear greeting (LiveKit agent)
- Agent asks for property details
- Agent quotes price
- Agent offers available slots

Check logs:
```bash
supabase functions logs api --tail --env production
```

### 9.2 Test SMS

Send SMS to your Twilio number:
- "2 bed 1 bath, once, 78704"
- Should get back a quote + booking link

### 9.3 Test Telegram

As owner, message your owner bot:
- "what's the schedule?"
- Should get back bookings for today

---

## Post-Deployment Checklist

- [ ] Phone number created
- [ ] Voice routing configured
- [ ] SMS webhook configured
- [ ] Telegram webhooks set
- [ ] Stripe webhook configured
- [ ] Edge Functions deployed
- [ ] Voice agent deployed
- [ ] Tenant created
- [ ] Service area configured
- [ ] Rate cards seeded
- [ ] Test call received
- [ ] Test SMS received
- [ ] Test Telegram message received
- [ ] Database backups enabled (Supabase dashboard)
- [ ] Monitoring alerts set up (errors, timeouts)

---

## Monitoring

### Health Check

```bash
curl https://<your-supabase-project-id>.supabase.co/functions/v1/api/health
```

Should return:
```json
{
  "status": "ok",
  "crons": {
    "reminders": "ok",
    "deposit_expiry": "ok",
    "series_materializer": "ok"
  }
}
```

### Logs

```bash
# Stream live logs
supabase functions logs api --tail --env production

# Search for errors
supabase functions logs api --tail --env production | grep ERROR
```

### Metrics

In Supabase dashboard:
- **Database → Metrics** — query performance
- **Edge Functions → Metrics** — function execution time
- **Logs → Function Logs** — errors & warnings

---

## Rollback

If something goes wrong:

```bash
# Revert to test database
supabase link --project-ref <test-project-id>

# Or deploy previous version
supabase functions deploy api --version previous
```

---

## Support

If you hit issues:

1. Check Edge Function logs: `supabase functions logs api --tail`
2. Check database migrations: `supabase migration list`
3. Verify Twilio/Telegram webhooks are being called
4. Check Stripe test mode vs live mode

---

**Timeline:** ~30 minutes total  
**Cost:** ~$0-5/month on free tiers + Stripe processing fees

Ready? Start with **Phase 1: Supabase Setup** ✅
