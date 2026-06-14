-- Schema v4 → v5: Home-services operations extension
-- Adds crews, recurring series, property profiles, and deterministic fee policy

-- ============ CREWS & CAPACITY ============

create table if not exists crews (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  name          text not null,
  home_base_zip text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique(tenant_id, name)
);

create table if not exists crew_shifts (
  id          uuid primary key default gen_random_uuid(),
  crew_id     uuid not null references crews(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_min   smallint not null,
  end_min     smallint not null,
  check (end_min > start_min),
  unique(crew_id, weekday)
);

create table if not exists crew_time_off (
  id        uuid primary key default gen_random_uuid(),
  crew_id   uuid not null references crews(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  reason    text,
  check (ends_at > starts_at)
);

create index if not exists idx_crew_time_off_crew_id_range
  on crew_time_off (crew_id, starts_at, ends_at);

-- Drive time matrix between zip codes (seeded per tenant, v1 is flat buffer)
create table if not exists zip_drive_minutes (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  from_zip  text not null,
  to_zip    text not null,
  minutes   smallint not null,
  check (minutes >= 0),
  unique(tenant_id, from_zip, to_zip)
);

-- ============ PROPERTIES & ACCESS ============

create table if not exists properties (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  client_id           uuid not null references clients(id),
  label               text,
  address_line1       text not null,
  address_line2       text,
  zip                 text not null,
  beds                smallint,
  baths               smallint,
  sqft                integer,
  parking_notes       text,
  pets                text,
  special_instructions text,
  entry_method        text not null default 'home'
    check (entry_method in ('home','key_hidden','lockbox','garage_code','smart_lock','front_desk','other')),
  entry_secret_enc    bytea,  -- encrypted; never returned to LLM
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_properties_client_id on properties(tenant_id, client_id);
create index if not exists idx_properties_zip on properties(tenant_id, zip);

-- ============ BOOKING ASSIGNMENTS & CREW CAPACITY ============

-- One row per booking, one crew per booking, one crew per time window
-- Double-booking is prevented by a trigger check
create table if not exists booking_assignments (
  booking_id uuid primary key references bookings(id) on delete cascade,
  crew_id    uuid not null references crews(id),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  check (ends_at > starts_at)
);

-- Trigger to prevent crew double-booking
create or replace function check_crew_no_double_book()
returns trigger as $$
begin
  if exists (
    select 1 from booking_assignments
    where crew_id = NEW.crew_id
    and booking_id != NEW.booking_id
    and starts_at < NEW.ends_at
    and ends_at > NEW.starts_at
  ) then
    raise exception 'Crew % is already booked for the overlapping time slot', NEW.crew_id;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger prevent_crew_double_book
before insert or update on booking_assignments
for each row execute function check_crew_no_double_book();

create index if not exists idx_booking_assignments_crew_id
  on booking_assignments(crew_id, starts_at, ends_at);

-- ============ PAYMENT METHODS (CARD ON FILE) ============

create table if not exists payment_methods (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  client_id          uuid not null references clients(id),
  stripe_customer_id text not null,
  stripe_pm_id       text not null,
  brand              text,
  last4              text,
  status             text not null default 'active'
    check (status in ('active','removed')),
  created_at         timestamptz not null default now()
);

create index if not exists idx_payment_methods_client_id
  on payment_methods(tenant_id, client_id);
create unique index if not exists idx_payment_methods_stripe_pm
  on payment_methods(tenant_id, stripe_pm_id);

-- ============ RECURRING SERIES ============

create table if not exists recurring_series (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  client_id          uuid not null references clients(id),
  property_id        uuid not null references properties(id),
  frequency_id       uuid not null references rate_card_frequencies(id),
  interval_weeks     smallint not null check (interval_weeks > 0),
  anchor_weekday     smallint not null check (anchor_weekday between 0 and 6),
  anchor_start_min   smallint not null check (anchor_start_min >= 0 and anchor_start_min < 1440),
  preferred_crew_id  uuid references crews(id),
  price_cents        integer not null check (price_cents >= 0),
  payment_method_id  uuid references payment_methods(id),
  status             text not null default 'active'
    check (status in ('active','paused','cancelled')),
  next_run_date      date,
  paused_until       date,
  service_minutes    smallint not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_recurring_series_tenant_id on recurring_series(tenant_id);
create index if not exists idx_recurring_series_client_id on recurring_series(tenant_id, client_id);
create index if not exists idx_recurring_series_next_run on recurring_series(tenant_id, next_run_date) where status = 'active';

-- ============ CANCELLATION POLICY ============

create table if not exists cancellation_policies (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  free_cancel_hours   smallint not null default 24,
  late_cancel_bps     integer not null default 5000,
  no_show_fee_bps     integer not null default 10000,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  unique(tenant_id)
);

-- ============ EXTEND EXISTING TABLES ============

-- Add crew assignment to bookings
alter table if exists bookings
  add column if not exists property_id uuid references properties(id),
  add column if not exists series_id uuid references recurring_series(id),
  add column if not exists sequence_no integer,
  add column if not exists service_minutes smallint,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_fee_cents integer,
  add column if not exists rescheduled_from uuid references bookings(id);

-- Service duration in rate card
alter table if exists rate_card_entries
  add column if not exists service_minutes smallint not null default 120;

-- Booking status enum should include: 'pending_deposit','confirmed','completed','rescheduled','cancelled','no_show'
-- (if using a string field, validation is in code; if using enum type, add values here)

-- ============ OWNER CONFIRMATIONS (EXISTING FROM REV 6) ============
-- Reuse existing owner_confirmations table for reschedule/cancel/series fees

-- ============ CRON HEARTBEATS (EXISTING FROM REV 6) ============
-- Reuse existing cron_heartbeats table

-- ============ INDEXES FOR PERFORMANCE ============

create index if not exists idx_bookings_property_id on bookings(tenant_id, property_id);
create index if not exists idx_bookings_series_id on bookings(tenant_id, series_id);

-- ============ SCHEMA VERSION ============

insert into schema_migrations (tenant_id, version)
  select id, 5 from tenants
  on conflict do nothing;
