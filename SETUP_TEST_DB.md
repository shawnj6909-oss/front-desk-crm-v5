# Setup Test Database on Supabase

Follow these steps to create a test database and run the full test suite.

## Step 1: Get Your Supabase Access Token

1. Go to: https://app.supabase.com/account/tokens
2. Click "Create new token"
3. Name it: `front-desk-crm-test`
4. Copy the token (you'll use it in the next step)

## Step 2: Create Test Project

**Option A: Automated (Recommended)**
```bash
chmod +x scripts/setup-test-db.sh
./scripts/setup-test-db.sh <your-access-token>
```

**Option B: Manual**

1. Go to https://app.supabase.com
2. Click "New Project"
3. **Name:** `front-desk-crm-v5-test`
4. **Region:** `us-east-1` (or your preferred region)
5. **Password:** Save it somewhere (you won't need it for tests)
6. Click "Create new project" and wait 2-3 minutes

## Step 3: Get Connection Details

Once project is ready:

1. Go to **Settings** → **Database** → **Connection string**
2. Copy the **Postgres URL**
3. Open `.env` file in this repo
4. Fill in:
   ```
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

To get the anon key:
- Go to **Settings** → **API**
- Copy `anon (public)` key

## Step 4: Run Migrations

```bash
supabase link --project-ref <your-project-id>
supabase db push
```

This applies the migration: `supabase/migrations/004_home_services_extension.sql`

## Step 5: Run Tests

```bash
npm test
```

All tests should pass (including integration tests with real database).

## Verify Setup

Check that your `.env` file has:
```bash
cat .env
# Should show:
# SUPABASE_URL=https://...
# SUPABASE_ANON_KEY=...
# SUPABASE_SERVICE_ROLE_KEY=...
```

Test connection:
```bash
supabase status
```

## Troubleshooting

### "Cannot read properties of undefined (reading 'from')"
- Check `.env` file exists and has correct credentials
- Verify `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set

### "Migration failed"
- Check that your Supabase project is fully created
- Verify tables don't already exist: go to Project → Table Editor

### "Slow tests"
- This is normal for first run (cold start on Supabase)
- Subsequent runs will be faster

## Clean Up

To delete the test project:
```bash
supabase projects delete <your-project-id>
```

Or go to Supabase dashboard → Project Settings → Danger Zone → Delete Project

---

**Once setup is done, all 34 tests will pass** (22 core logic + 12 integration tests).
