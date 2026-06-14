-- Base schema for Front Desk CRM
-- Core tables for v1-v4, extended by v5

create extension if not exists "uuid-ossp";

-- ============ PLATFORM SCHEMA (SHARED) ============

create table if not exists tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  stripe_account_id text,
  locale        text default 'en',
  created_at    timestamptz not null default now(),
  unique(name)
);

create table if not exists clients (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  phone         text,
  email         text,
  telegram_user_id text,
  name          text,
  created_at    timestamptz not null default now()
);

create index idx_clients_tenant_id on clients(tenant_id);
create index idx_clients_phone on clients(tenant_id, phone);

-- ============ RATE CARDS ============

create table if not exists rate_card_frequencies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  name          text not null, -- 'once', 'weekly', 'biweekly', 'monthly'
  created_at    timestamptz not null default now(),
  unique(tenant_id, name)
);

create table if not exists rate_card_entries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  beds          smallint not null,
  baths         smallint not null,
  frequency_id  uuid not null references rate_card_frequencies(id),
  price_cents   integer not null,
  service_minutes smallint not null default 120,
  created_at    timestamptz not null default now(),
  unique(tenant_id, beds, baths, frequency_id)
);

create index idx_rate_card_entries_tenant on rate_card_entries(tenant_id);

-- ============ BOOKINGS ============

create table if not exists bookings (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  client_id            uuid not null references clients(id),
  status               text not null default 'pending_deposit',
  price_cents          integer not null,
  deposit_paid_at      timestamptz,
  balance_paid_at      timestamptz,
  start_at             timestamptz,
  end_at               timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index idx_bookings_tenant_client on bookings(tenant_id, client_id);
create index idx_bookings_status on bookings(tenant_id, status);
create index idx_bookings_start_at on bookings(tenant_id, start_at);

-- ============ SERVICE AREAS ============

create table if not exists service_area_zips (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  zip           text not null,
  created_at    timestamptz not null default now(),
  unique(tenant_id, zip)
);

create index idx_service_area_zips_tenant on service_area_zips(tenant_id);

-- ============ BUSINESS HOURS ============

create table if not exists business_hours (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  weekday       smallint not null check (weekday between 0 and 6),
  start_min     smallint not null,
  end_min       smallint not null,
  check (end_min > start_min),
  unique(tenant_id, weekday)
);

-- ============ PAYMENTS ============

create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  booking_id    uuid not null references bookings(id),
  amount_cents  integer not null,
  type          text not null, -- 'deposit', 'balance'
  stripe_session_id text,
  stripe_payment_intent_id text,
  status        text not null default 'pending',
  created_at    timestamptz not null default now(),
  unique(tenant_id, stripe_session_id)
);

create index idx_payments_booking on payments(tenant_id, booking_id);

-- ============ MESSAGING & OUTBOX ============

create table if not exists conversations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  client_id     uuid not null references clients(id),
  channel       text not null, -- 'sms', 'telegram', 'whatsapp', 'voice'
  created_at    timestamptz not null default now()
);

create index idx_conversations_client on conversations(tenant_id, client_id);

create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  direction     text not null, -- 'inbound', 'outbound'
  content       text,
  created_at    timestamptz not null default now()
);

create table if not exists outbound_messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  client_id     uuid not null references clients(id),
  phone         text,
  content       text not null,
  channel       text not null,
  status        text not null default 'pending',
  error_message text,
  attempts      integer default 0,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

create index idx_outbound_messages_tenant_status on outbound_messages(tenant_id, status);

-- ============ EVENTS & EXCEPTIONS ============

create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  booking_id    uuid references bookings(id),
  event_type    text not null,
  status        text not null default 'pending',
  attempts      integer default 0,
  created_at    timestamptz not null default now()
);

create table if not exists exceptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  booking_id    uuid references bookings(id),
  description   text not null,
  status        text not null default 'open',
  created_at    timestamptz not null default now()
);

-- ============ OWNER CONFIRMATIONS ============

create table if not exists owner_confirmations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  booking_id    uuid references bookings(id),
  series_id     uuid,
  action        text not null,
  fee_cents     integer,
  old_price_cents integer,
  new_price_cents integer,
  status        text not null default 'pending',
  created_at    timestamptz not null default now()
);

create index idx_owner_confirmations_status on owner_confirmations(tenant_id, status);

-- ============ WEBHOOK EVENTS ============

create table if not exists webhook_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  source        text not null, -- 'twilio', 'stripe', 'telegram'
  event_id      text not null,
  event_type    text not null,
  payload       jsonb,
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique(tenant_id, source, event_id)
);

create index idx_webhook_events_processed on webhook_events(tenant_id, processed_at);

-- ============ VOICE CALLS ============

create table if not exists voice_calls (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  client_id     uuid references clients(id),
  room_id       text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_secs integer
);

-- ============ CRON & MONITORING ============

create table if not exists cron_heartbeats (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  job_name      text not null,
  last_run      timestamptz,
  status        text default 'ok',
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_cron_heartbeats_job on cron_heartbeats(tenant_id, job_name);

-- ============ SCHEMA MIGRATIONS ============

create table if not exists schema_migrations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id),
  version       integer not null,
  applied_at    timestamptz not null default now(),
  unique(tenant_id, version)
);
