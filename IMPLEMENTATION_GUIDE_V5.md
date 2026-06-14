# V5 Home-Services Implementation Guide

This guide covers the implementation of the four critical features missing from the rev 6 architecture:

1. **Crews** — capacity as people, not just time
2. **Properties** — customer addresses with secure access profiles
3. **Recurring series** — standing appointments with card-on-file auto-charge
4. **Reschedule/cancel** — customer self-service with deterministic fee policy

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Changes](#architecture-changes)
- [Database Migrations](#database-migrations)
- [Tool Implementations](#tool-implementations)
- [Cron Jobs](#cron-jobs)
- [Tests](#tests)
- [Integration Checklist](#integration-checklist)

---

## Quick Start

### 1. Apply Database Migrations

```bash
supabase migration list
supabase migration up
# applies: supabase/migrations/004_home_services_extension.sql
```

This migration:
- Creates `crews`, `crew_shifts`, `crew_time_off`, `booking_assignments` (with EXCLUDE constraint)
- Creates `properties` with encrypted `entry_secret_enc`
- Creates `recurring_series`, `payment_methods`, `cancellation_policies`
- Creates `zip_drive_minutes` for travel-time buffering
- Extends `bookings` table with crew/series/property references

### 2. Import Drizzle Schema (Optional, if using ORM)

See [src/db/schema-v5-types.ts](src/db/schema-v5-types.ts) for Drizzle table definitions.

### 3. Wire Up Tools

In your `engine/index.ts` or tool dispatcher:

```typescript
import * as toolsV5 from './tools-v5';

const toolRegistry = {
  // existing tools...
  check_availability: checkAvailabilityV5, // REPLACES old version, now crew-aware
  quote_change: toolsV5.quoteChange,
  get_or_create_property: toolsV5.getOrCreateProperty,
  start_recurring_series: toolsV5.startRecurringSeries,
  skip_next_visit: toolsV5.skipNextVisit,
  pause_series: toolsV5.pauseSeries,
  resume_series: toolsV5.resumeSeries,
  cancel_series: toolsV5.cancelSeries,
  reschedule_booking: toolsV5.rescheduleBooking,
  cancel_booking: toolsV5.cancelBooking,
  save_card_on_file: toolsV5.saveCardOnFile,
  change_series_cadence: toolsV5.changeSeriesCadence,
};
```

### 4. Wire Up Cron Jobs

In your cron dispatcher (e.g., `functions/cron-dispatcher.ts`):

```typescript
import { seriesMaterializer } from '../src/cron/series-materializer';
import { noShowSweep } from '../src/cron/no-show-sweep';

// pg_cron → HTTP callback → your dispatcher
const crons = {
  // existing: reminders, deposit_expiry, outbox_sweep, etc.
  
  series_materializer: {
    schedule: '0 15 * * *', // daily 15:00 UTC
    handler: (db, tenantId) => seriesMaterializer(db, { tenantId, leadWindowDays: 7 }),
  },
  
  no_show_sweep: {
    schedule: '*/30 * * * *', // every 30 minutes
    handler: (db, tenantId) => noShowSweep(db, tenantId),
    optional: true, // can skip if not charging for no-shows
  },
};
```

### 5. Backfill Existing Tenants

For tenants on v4, you need:

```sql
-- Per tenant, after migration:
-- 1. Create a default crew (single-operator tenants)
insert into crews (tenant_id, name, home_base_zip, active)
  values ($1, 'Owner', (select service_area_zips limit 1), true);

-- 2. Create properties from existing bookings
insert into properties (tenant_id, client_id, zip, beds, baths, entry_method)
  select distinct
    tenant_id, client_id, zip, beds, baths, 'home'
  from bookings
  where tenant_id = $1
  on conflict do nothing;

-- 3. Assign all confirmed bookings to the default crew
insert into booking_assignments (booking_id, crew_id, starts_at, ends_at)
  select b.id, c.id, b.start_at, b.end_at
  from bookings b
  join crews c on c.tenant_id = b.tenant_id
  where b.tenant_id = $1 and b.status in ('confirmed', 'completed')
  on conflict do nothing;

-- 4. Create default cancellation policy
insert into cancellation_policies (tenant_id)
  values ($1)
  on conflict do nothing;
```

---

## Architecture Changes

### Core Invariants (Unchanged from Rev 6, Extended)

1. **Prices are code** — LLM never computes a price; `get_quote` returns integer cents
2. **Slots are real** — LLM never invents availability; `check_availability` queries the database
3. **Money is idempotent** — Stripe webhooks use signed verification + idempotency keys
4. **Every door is locked** — All inbound endpoints authenticate (HMAC, bearer token, signatures)

### New Invariants (Rev 5)

5. **Capacity is people** — LLM never picks a crew; `check_availability` returns crew-aware slots
6. **Access codes are secret** — `entry_secret_enc` is encrypted, never enters LLM context, surfaced only to assigned crew on job day
7. **Fees are deterministic** — `quote_change` computes cancellation fees from `cancellation_policy` basis points, never the LLM
8. **Recurring is idempotent** — `series_materializer` uses `(series_id, next_run_date)` as idempotency key
9. **Reschedule is atomic** — crew slot release + new slot lock + fee confirmation in one transaction

---

## Database Migrations

### Tables Added

**`crews`** — A crew is the unit of capacity (one person or one team that occupies one job at a time).

```sql
crews (
  id, tenant_id, name, home_base_zip, active, created_at
)
unique(tenant_id, name)
```

**`crew_shifts`** — Recurring weekly shift windows per crew.

```sql
crew_shifts (
  id, crew_id, weekday (0-6), start_min, end_min
)
```

**`crew_time_off`** — One-off unavailability (sick, vacation).

```sql
crew_time_off (
  id, crew_id, starts_at, ends_at, reason
)
```

**`booking_assignments`** — **This is the crew capacity lock**. One row per booking, enforced by `EXCLUDE USING gist` so a crew cannot hold overlapping jobs.

```sql
booking_assignments (
  booking_id (PK, FK), crew_id (FK), starts_at, ends_at
)
exclude using gist (crew_id with =, tstzrange(starts_at, ends_at) with &&)
```

**`properties`** — Customer properties (addresses, entry methods, pets, parking).

```sql
properties (
  id, tenant_id, client_id, label, zip, beds, baths, sqft,
  entry_method (enum: home, key_hidden, lockbox, garage_code, smart_lock, front_desk, other),
  entry_secret_enc (encrypted), pets, special_instructions, parking_notes,
  created_at, updated_at
)
```

**`recurring_series`** — Standing-appointment blueprints.

```sql
recurring_series (
  id, tenant_id, client_id, property_id, frequency_id,
  interval_weeks, anchor_weekday, anchor_start_min,
  preferred_crew_id, price_cents, payment_method_id, service_minutes,
  status (active|paused|cancelled), next_run_date, paused_until,
  created_at, updated_at
)
```

**`payment_methods`** — Card on file (from Stripe SetupIntent).

```sql
payment_methods (
  id, tenant_id, client_id,
  stripe_customer_id, stripe_pm_id, brand, last4,
  status (active|removed),
  created_at
)
unique(tenant_id, stripe_pm_id)
```

**`cancellation_policies`** — Determines free cancel window and fee basis points.

```sql
cancellation_policies (
  id, tenant_id,
  free_cancel_hours (default 24),
  late_cancel_bps (default 5000 = 50%),
  no_show_fee_bps (default 10000 = 100%),
  active, created_at
)
unique(tenant_id)
```

**`zip_drive_minutes`** — Travel time between zip codes (seeded per tenant).

```sql
zip_drive_minutes (
  id, tenant_id, from_zip, to_zip, minutes
)
unique(tenant_id, from_zip, to_zip)
```

### Tables Extended

**`bookings`** adds:
- `property_id` — which address
- `series_id` — if part of a recurring series
- `sequence_no` — 1st, 2nd, ... occurrence in the series
- `service_minutes` — duration (from rate card)
- `cancelled_at` — timestamp when cancelled
- `cancel_fee_cents` — fee charged on cancellation
- `rescheduled_from` — if rescheduled, points to the old booking

**`rate_card_entries`** adds:
- `service_minutes` — default 120 (2 hours) if not overridden

---

## Tool Implementations

All tools follow the rev 6 principle: **the LLM picks the tool, deterministic code executes.**

### Availability Queries

**`check_availability`** (REPLACES rev 6 version, now crew-aware)

**Inputs:**
```typescript
{
  zip: string,
  beds: number,
  baths: number,
  frequency: 'once' | 'weekly' | 'biweekly' | 'monthly',
  startDate: string (ISO),
  endDate: string (ISO),
}
```

**Output:**
```typescript
[
  {
    crewId: string,
    crewName: string,
    startTime: string (ISO datetime),
    endTime: string,
    price: number (cents),
  }
]
```

**Constraints:**
- Crew must have shift hours (from `crew_shifts`) for that weekday
- Crew must not be in `crew_time_off`
- Crew must not have overlapping `booking_assignments`
- Travel time from crew's previous job (or home base) to this zip must be available
- Service duration comes from rate card + `service_minutes`
- Prices come from rate card

### Property Management

**`get_or_create_property`**

Creates or fetches a property by client + zip.

**Inputs:**
```typescript
{
  clientId: string,
  zip: string,
  beds?: number,
  baths?: number,
  label?: string,
  entryMethod?: 'home' | 'key_hidden' | 'lockbox' | 'garage_code' | 'smart_lock' | 'front_desk' | 'other',
  pets?: string,
  parkingNotes?: string,
  specialInstructions?: string,
  // entrySecret encrypted at app layer, not passed as plaintext
}
```

**Output:**
```typescript
{
  propertyId: string,
  label: string,
  address: string (zip),
}
```

**Security Note:** `entry_secret` is never returned. It is encrypted at the app layer (using a rotation-safe key stored in `ENCRYPTION_KEY` env var, e.g., AES-256-GCM) and decrypted only when dispatching a crew to a job.

### Quoting & Fees

**`quote_change`**

For an existing booking, returns the current slot details, the cancellation fee *for right now*, and available reschedule options.

**Inputs:**
```typescript
{
  bookingId: string (UUID),
}
```

**Output:**
```typescript
{
  currentSlot: {
    startTime: string (ISO),
    endTime: string (ISO),
    priceCents: number,
  },
  cancellationFee: {
    cents: number, // computed from policy, never the LLM
    reason: 'free' | 'late_cancel',
  },
  rescheduleOptions: AvailableSlot[],
}
```

**Fee Computation Logic:**
```
hours_until_start = (booking.start_at - now).hours
if hours_until_start >= policy.free_cancel_hours:
  fee_cents = 0
else:
  fee_cents = round(booking.price_cents * policy.late_cancel_bps / 10000)
```

Example:
- Booking: $200 (20000 cents), starts in 12 hours
- Policy: 24-hour free window, 50% late fee (5000 bps)
- Fee: 20000 × 5000 / 10000 = 10000 cents = $100

### Reschedule & Cancel

**`reschedule_booking`**

Atomically releases the old crew slot, locks a new one, and flags fee if applicable.

**Inputs:**
```typescript
{
  bookingId: string,
  newSlotCrewId: string,
  newStartTime: string (ISO),
}
```

**Output:**
```typescript
{
  newBookingId: string,
  feeCents: number,
}
```

**Process:**
1. Delete old `booking_assignments` row (release crew slot)
2. Insert new `booking_assignments` row (lock new crew slot) — EXCLUDE constraint prevents collisions
3. If fee > 0, write to `owner_confirmations` with action='reschedule_fee', status='pending'
4. Money only moves after owner confirms

**`cancel_booking`**

**Inputs:**
```typescript
{
  bookingId: string,
}
```

**Output:**
```typescript
{
  fee: number (cents),
  refund: number (cents),
}
```

**Process:**
1. Compute fee via `quote_change`
2. Delete `booking_assignments` row (release crew slot)
3. Update booking: status='cancelled', cancelled_at=now, cancel_fee_cents=fee
4. If fee > 0, write to `owner_confirmations` with action='cancel_fee', status='pending'
5. If refund > 0, trigger Stripe refund

### Recurring Series

**`start_recurring_series`**

**Inputs:**
```typescript
{
  clientId: string,
  propertyId: string,
  frequencyId: string (from rate_card_frequencies),
  intervalWeeks: 1 | 2 | 4,
  anchorWeekday: 0-6 (0=Sunday),
  anchorStartMin: 0-1439 (minutes from midnight),
  priceCents: number,
  paymentMethodId?: string (from payment_methods),
  preferredCrewId?: string,
}
```

**Output:**
```typescript
{
  seriesId: string,
  nextRunDate: string (ISO date),
}
```

**Process:**
1. Create `recurring_series` row
2. Compute next_run_date = next occurrence of anchor_weekday from today
3. Write to `owner_confirmations` with action='start_recurring_series', status='pending' (money-touching)
4. Series only becomes active after owner confirms

**`skip_next_visit`** — Advance `next_run_date` by `interval_weeks` without creating a booking.

**`pause_series`** — Set `paused_until` date; materializer skips until that date.

**`resume_series`** — Clear `paused_until`, set status='active'.

**`cancel_series`** — Set status='cancelled', write to `owner_confirmations` (money-touching).

**`change_series_cadence`** — Re-quote based on new frequency/interval. If price delta > $5, require owner confirmation.

### Payment Methods

**`save_card_on_file`**

Called after Stripe SetupIntent succeeds (no charge yet, just authorization).

**Inputs:**
```typescript
{
  clientId: string,
  stripeCustomerId: string,
  stripePmId: string,
  brand?: string,
  last4?: string,
}
```

**Output:**
```typescript
{
  paymentMethodId: string,
}
```

---

## Cron Jobs

### `series_materializer` — Daily 15:00 UTC

Books the next job for each active recurring series and auto-charges the card.

**Pseudocode:**
```
for each active recurring_series with next_run_date <= today + 7:
  1. Create booking row (status=pending_deposit)
  2. Compute next crew (prefer preferred_crew_id, else any free crew)
  3. Lock crew slot via booking_assignments (EXCLUDE prevents double-book)
  4. If payment_method_id:
       charge card on file via Stripe (use series_id:next_run_date as idempotency key)
       if success: mark booking as confirmed (deposit paid)
       if fail: send deposit link instead
     else:
       send deposit link
  5. Advance next_run_date by interval_weeks
  6. Write cron_heartbeat (for dead-man check)
```

**Error Handling:**
- Crew unavailable → skip, leave booking unassigned (owner sees in Telegram)
- Stripe charge fails → send deposit link instead, retry next run
- Crew time-off starts during materialization → release slot, send owner alert

### `no_show_sweep` — Every 30 Minutes (Optional)

Flags probable no-shows for owner confirmation before charging fee.

**Criteria:**
- Booking status = 'confirmed'
- Booking.end_at < now
- No existing owner_confirmation for action='no_show_fee'

**Process:**
1. Create `owner_confirmations` row with action='no_show_fee'
2. Alert owner on Telegram with fee amount
3. Owner confirms → charge card; deny → release (no fee)

---

## Tests

See [src/tests/v5-home-services.spec.ts](src/tests/v5-home-services.spec.ts).

**Test Suites:**

1. **Crew double-book prevention** — EXCLUDE constraint blocks overlapping assignments
2. **Travel-time constraints** — Slots that require impossible back-to-back driving not offered
3. **Cancellation fee math** — Exact integer cents, deterministic for same inputs
4. **Access code security** — Encrypted, never in LLM context, excluded from tool results
5. **Recurring series idempotency** — Materializer runs twice → one booking, one charge
6. **Reschedule atomicity** — Old slot released, new slot locked in one transaction
7. **No-show fee confirmation** — Requires owner approval before charging

**Run tests:**
```bash
npm test src/tests/v5-home-services.spec.ts
```

---

## Integration Checklist

- [ ] Run migrations (`supabase migration up`)
- [ ] Import/reference Drizzle schema in your ORM config
- [ ] Implement app-layer encryption for `entry_secret` (AES-256-GCM recommended)
- [ ] Register v5 tools in tool dispatcher
- [ ] Wire up `series_materializer` cron (daily 15:00 UTC)
- [ ] Wire up `no_show_sweep` cron (every 30 min, optional)
- [ ] Backfill existing tenants (default crew + properties + assignments)
- [ ] Add owner_confirmations UI (approve/deny reschedule/cancel fees, series changes)
- [ ] Add day-of crew dispatch (send access code + ETA window to crew, not customer)
- [ ] Implement Stripe SetupIntent flow (card capture for recurring)
- [ ] Update LLM system prompt to mention new tools + constraints
- [ ] Run full test suite
- [ ] Deploy with schema version 5 gate

---

## Open Decisions

1. **Travel time source** — Start with flat `zip_drive_minutes` buffer (no API deps) or integrate Google Maps / Mapbox routing?
   - Recommended: start flat, upgrade only if crews report bad routing

2. **Day-of communications** — Should the system send crew an ETA window + access code, or require crew to call/text?
   - Recommended: crew gets code + window via SMS/in-app 2 hours before shift

3. **Recurring series approval** — Require owner to approve starting a series, or auto-start with card setup?
   - Recommended: auto-start after card setup succeeds; owner can pause/cancel after

4. **No-show policy** — Always charge 100%, or have tiered policy (first no-show: warning, second: charge)?
   - Recommended: first occurrence → owner decides; repeat customers → auto-charge

---

## Deployment

### Dev/Staging
```bash
# Test migrations locally
supabase migration up

# Run tests
npm test

# Deploy edge functions
supabase functions deploy
```

### Production
1. Backup production database
2. Apply migration in off-hours
3. Backfill existing tenants (script provided)
4. Deploy code with v5 tools
5. Notify customers of new self-service reschedule feature
6. Monitor cron heartbeats on `/health`

---

**Questions?** Refer to the design record: `docs/plans/front-desk-home-services-extension.md`
