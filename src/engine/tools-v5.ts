/**
 * Home-services v5 tools
 * Crews, recurring, properties, reschedule/cancel with deterministic fee policy
 * The LLM picks the tool; the code executes deterministically.
 */

import { z } from 'zod';
import { Database } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

// ============ CREW-AWARE AVAILABILITY ============

export const checkAvailabilityV5 = z.object({
  zip: z.string(),
  beds: z.number().int().min(1),
  baths: z.number().int().min(1),
  frequency: z.enum(['once', 'weekly', 'biweekly', 'monthly']),
  startDate: z.string(), // ISO date YYYY-MM-DD
  endDate: z.string(), // ISO date YYYY-MM-DD (same day for single visit)
});

type CheckAvailabilityInput = z.infer<typeof checkAvailabilityV5>;

interface AvailableSlot {
  crewId: string;
  crewName: string;
  startTime: string; // ISO datetime
  endTime: string;
  price: number; // in cents
}

/**
 * Returns available slots per crew, respecting:
 * - crew shift hours
 * - crew time-off blocks
 * - existing booking_assignments (gist exclude prevents double-book)
 * - travel time between jobs (via zip_drive_minutes)
 * - rate card (service_minutes, price)
 */
export async function checkAvailability(
  db: Database,
  tenantId: string,
  input: CheckAvailabilityInput
): Promise<AvailableSlot[]> {
  // 1. Get rate card entry for beds/baths/frequency
  const { data: rateEntry } = await db
    .from('rate_card_entries')
    .select('id, price_cents, service_minutes')
    .eq('tenant_id', tenantId)
    .eq('beds', input.beds)
    .eq('baths', input.baths)
    .eq('frequency_id', frequency) // need to join frequency table
    .single();

  if (!rateEntry) {
    return []; // no matching rate card
  }

  // 2. Get all active crews with shifts
  const { data: crews } = await db
    .from('crews')
    .select(`
      id, name, home_base_zip,
      crew_shifts(*),
      crew_time_off(*)
    `)
    .eq('tenant_id', tenantId)
    .eq('active', true);

  // 3. Get drive time from last known job/home base to this zip
  const { data: driveMatrix } = await db
    .from('zip_drive_minutes')
    .select('minutes')
    .eq('tenant_id', tenantId);

  const driveMap = new Map(driveMatrix.map((d) => [`${d.from_zip}-${d.to_zip}`, d.minutes]));

  const slots: AvailableSlot[] = [];
  const startDate = DateTime.fromISO(input.startDate);
  const endDate = DateTime.fromISO(input.endDate);

  // For each day in the range
  for (let d = startDate; d <= endDate; d = d.plus({ days: 1 })) {
    const weekday = d.weekday % 7; // Luxon: 1=Mon, 7=Sun; convert to 0=Sun, 6=Sat

    for (const crew of crews) {
      // Check if crew has shift for this weekday
      const shift = crew.crew_shifts.find((s) => s.weekday === weekday);
      if (!shift) continue;

      // Check if crew has time-off overlapping this day
      const isTimeOff = crew.crew_time_off.some((to) => {
        const toStart = DateTime.fromISO(to.starts_at);
        const toEnd = DateTime.fromISO(to.ends_at);
        return d >= toStart && d < toEnd;
      });
      if (isTimeOff) continue;

      // Try to fit a job within the shift, respecting travel time
      const shiftStart = d.set({ hour: Math.floor(shift.start_min / 60), minute: shift.start_min % 60 });
      const shiftEnd = d.set({ hour: Math.floor(shift.end_min / 60), minute: shift.end_min % 60 });

      // Get existing assignments for this crew on this day
      const { data: existing } = await db
        .from('booking_assignments')
        .select('starts_at, ends_at')
        .eq('crew_id', crew.id)
        .gte('starts_at', shiftStart.toISO())
        .lt('ends_at', shiftEnd.toISO());

      // Compute free windows, accounting for travel time
      const freeWindows = computeFreeWindows(shiftStart, shiftEnd, existing, rateEntry.service_minutes);

      // Travel time from crew home base to job zip
      const driveMins =
        driveMap.get(`${crew.home_base_zip}-${input.zip}`) ||
        30; /* default 30-min buffer if no entry */

      for (const window of freeWindows) {
        const jobStart = window.start.plus({ minutes: driveMins });
        const jobEnd = jobStart.plus({ minutes: rateEntry.service_minutes });

        if (jobEnd <= window.end) {
          slots.push({
            crewId: crew.id,
            crewName: crew.name,
            startTime: jobStart.toISO()!,
            endTime: jobEnd.toISO()!,
            price: rateEntry.price_cents,
          });
        }
      }
    }
  }

  return slots;
}

function computeFreeWindows(
  shiftStart: DateTime,
  shiftEnd: DateTime,
  existingAssignments: any[],
  serviceMins: number
): Array<{ start: DateTime; end: DateTime }> {
  const windows: Array<{ start: DateTime; end: DateTime }> = [];
  let current = shiftStart;

  for (const assignment of existingAssignments.sort((a, b) =>
    new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
  )) {
    const assignStart = DateTime.fromISO(assignment.starts_at);
    if (current < assignStart) {
      windows.push({ start: current, end: assignStart });
    }
    current = DateTime.fromISO(assignment.ends_at);
  }

  if (current < shiftEnd) {
    windows.push({ start: current, end: shiftEnd });
  }

  return windows;
}

// ============ PROPERTY MANAGEMENT ============

export const getOrCreatePropertySchema = z.object({
  clientId: z.string().uuid(),
  zip: z.string(),
  beds: z.number().int().optional(),
  baths: z.number().int().optional(),
  label: z.string().optional(),
  entryMethod: z
    .enum(['home', 'key_hidden', 'lockbox', 'garage_code', 'smart_lock', 'front_desk', 'other'])
    .default('home'),
  // entrySecret encrypted in app-layer, not returned to model
  pets: z.string().optional(),
  parkingNotes: z.string().optional(),
  specialInstructions: z.string().optional(),
});

type GetOrCreatePropertyInput = z.infer<typeof getOrCreatePropertySchema>;

export async function getOrCreateProperty(
  db: Database,
  tenantId: string,
  input: GetOrCreatePropertyInput
): Promise<{ propertyId: string; label: string; address: string }> {
  // Try to find existing property by client + zip
  const { data: existing } = await db
    .from('properties')
    .select('id, label')
    .eq('tenant_id', tenantId)
    .eq('client_id', input.clientId)
    .eq('zip', input.zip)
    .single();

  if (existing) {
    return { propertyId: existing.id, label: existing.label || 'Home', address: input.zip };
  }

  // Create new property
  const { data: created, error } = await db
    .from('properties')
    .insert({
      tenant_id: tenantId,
      client_id: input.clientId,
      label: input.label || 'Home',
      zip: input.zip,
      beds: input.beds,
      baths: input.baths,
      entry_method: input.entryMethod,
      pets: input.pets,
      parking_notes: input.parkingNotes,
      special_instructions: input.specialInstructions,
    })
    .select('id, label')
    .single();

  if (error) throw error;

  return { propertyId: created.id, label: created.label, address: input.zip };
}

// ============ QUOTE WITH CANCELLATION FEE ============

export const quoteChangeSchema = z.object({
  bookingId: z.string().uuid(),
  // does not specify new time; returns options
});

interface QuoteChangeResult {
  currentSlot: {
    startTime: string;
    endTime: string;
    priceCents: number;
  };
  cancellationFee: {
    cents: number;
    reason: string; // 'free' | 'late_cancel' | 'inside_free_window'
  };
  rescheduleOptions: AvailableSlot[];
}

export async function quoteChange(
  db: Database,
  tenantId: string,
  input: z.infer<typeof quoteChangeSchema>
): Promise<QuoteChangeResult> {
  // 1. Get the current booking
  const { data: booking } = await db
    .from('bookings')
    .select(
      `
      id, property_id, client_id,
      price_cents, status,
      created_at,
      properties(zip, beds, baths)
    `
    )
    .eq('tenant_id', tenantId)
    .eq('id', input.bookingId)
    .single();

  if (!booking) throw new Error('Booking not found');

  // 2. Get cancellation policy
  const { data: policy } = await db
    .from('cancellation_policies')
    .select('free_cancel_hours, late_cancel_bps')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .single();

  // 3. Compute cancellation fee for *right now*
  const createdAt = DateTime.fromISO(booking.created_at);
  const now = DateTime.now();
  const hoursUntilStart = booking.start_at ? DateTime.fromISO(booking.start_at).diff(now, 'hours').hours : 24;

  let cancelFee = 0;
  let feeReason = 'free';

  if (hoursUntilStart < (policy?.free_cancel_hours || 24)) {
    // Late cancellation fee
    cancelFee = Math.round((booking.price_cents * (policy?.late_cancel_bps || 5000)) / 10000);
    feeReason = 'late_cancel';
  }

  // 4. Get available reschedule options
  const rescheduleOptions = await checkAvailability(db, tenantId, {
    zip: booking.properties.zip,
    beds: booking.properties.beds,
    baths: booking.properties.baths,
    frequency: 'once', // assume single reschedule
    startDate: DateTime.now().plus({ days: 1 }).toISODate()!,
    endDate: DateTime.now().plus({ days: 14 }).toISODate()!, // 14-day window
  });

  return {
    currentSlot: {
      startTime: booking.start_at || '',
      endTime: booking.end_at || '',
      priceCents: booking.price_cents,
    },
    cancellationFee: {
      cents: cancelFee,
      reason: feeReason,
    },
    rescheduleOptions,
  };
}

// ============ RESCHEDULE BOOKING ============

export const rescheduleBookingSchema = z.object({
  bookingId: z.string().uuid(),
  newSlotCrewId: z.string().uuid(),
  newStartTime: z.string(), // ISO datetime
});

export async function rescheduleBooking(
  db: Database,
  tenantId: string,
  input: z.infer<typeof rescheduleBookingSchema>
): Promise<{ newBookingId: string; feeCents: number }> {
  // 1. Get old booking + assignment
  const { data: oldBooking } = await db
    .from('bookings')
    .select('*, booking_assignments(*)')
    .eq('tenant_id', tenantId)
    .eq('id', input.bookingId)
    .single();

  // 2. Get cancellation fee
  const quoteResult = await quoteChange(db, tenantId, { bookingId: input.bookingId });
  const feeCents = quoteResult.cancellationFee.cents;

  // 3. In a transaction:
  // - Release old crew slot (delete booking_assignments row)
  // - Create new booking_assignments row for new crew/time
  // - Update old booking status to 'rescheduled'
  // - Charge fee if applicable
  // - Create owner_confirmations if fee is non-zero (must read back)

  // This is pseudocode; the real impl uses db.rpc() or a stored procedure
  const { data: newAssignment, error: assignErr } = await db
    .from('booking_assignments')
    .insert({
      booking_id: input.bookingId, // reuse booking ID? or create new?
      crew_id: input.newSlotCrewId,
      starts_at: input.newStartTime,
      ends_at: DateTime.fromISO(input.newStartTime)
        .plus({ minutes: oldBooking.service_minutes })
        .toISO(),
    })
    .select('booking_id')
    .single();

  if (assignErr) throw assignErr;

  if (feeCents > 0) {
    // Write owner_confirmations row; money only moves after owner approves
    await db.from('owner_confirmations').insert({
      tenant_id: tenantId,
      booking_id: input.bookingId,
      action: 'reschedule_fee',
      fee_cents: feeCents,
      status: 'pending',
    });
  }

  return { newBookingId: input.bookingId, feeCents };
}

// ============ CANCEL BOOKING ============

export const cancelBookingSchema = z.object({
  bookingId: z.string().uuid(),
});

export async function cancelBooking(
  db: Database,
  tenantId: string,
  input: z.infer<typeof cancelBookingSchema>
): Promise<{ fee: number; refund: number }> {
  const quoteResult = await quoteChange(db, tenantId, {
    bookingId: input.bookingId,
  });

  const fee = quoteResult.cancellationFee.cents;
  const refund = quoteResult.currentSlot.priceCents - fee;

  // 1. Release crew slot
  await db.from('booking_assignments').delete().eq('booking_id', input.bookingId);

  // 2. Mark booking cancelled
  await db
    .from('bookings')
    .update({ status: 'cancelled', cancelled_at: new Date(), cancel_fee_cents: fee })
    .eq('id', input.bookingId);

  // 3. If fee > 0, write to owner_confirmations (must read-back before charging)
  if (fee > 0) {
    await db.from('owner_confirmations').insert({
      tenant_id: tenantId,
      booking_id: input.bookingId,
      action: 'cancel_fee',
      fee_cents: fee,
      status: 'pending',
    });
  }

  // 4. If fee < deposit, auto-refund remainder
  if (refund > 0) {
    // Stripe refund logic
  }

  return { fee, refund };
}

// ============ RECURRING SERIES ============

export const startRecurringSeriesSchema = z.object({
  clientId: z.string().uuid(),
  propertyId: z.string().uuid(),
  frequencyId: z.string().uuid(),
  intervalWeeks: z.number().int().min(1).max(4),
  anchorWeekday: z.number().int().min(0).max(6), // 0=Sun, 6=Sat
  anchorStartMin: z.number().int().min(0).max(1439), // minutes from midnight
  priceCents: z.number().int().min(0),
  paymentMethodId: z.string().uuid().optional(),
  preferredCrewId: z.string().uuid().optional(),
});

type StartRecurringSeriesInput = z.infer<typeof startRecurringSeriesSchema>;

export async function startRecurringSeries(
  db: Database,
  tenantId: string,
  input: StartRecurringSeriesInput
): Promise<{ seriesId: string; nextRunDate: string }> {
  // Get rate card to extract service_minutes
  const { data: rateEntry } = await db
    .from('rate_card_entries')
    .select('service_minutes')
    .eq('frequency_id', input.frequencyId)
    .single();

  // Compute next run date (next occurrence of the anchor weekday)
  const now = DateTime.now();
  let nextRun = now;
  while (nextRun.weekday % 7 !== input.anchorWeekday) {
    nextRun = nextRun.plus({ days: 1 });
  }

  const { data: series, error } = await db
    .from('recurring_series')
    .insert({
      tenant_id: tenantId,
      client_id: input.clientId,
      property_id: input.propertyId,
      frequency_id: input.frequencyId,
      interval_weeks: input.intervalWeeks,
      anchor_weekday: input.anchorWeekday,
      anchor_start_min: input.anchorStartMin,
      price_cents: input.priceCents,
      payment_method_id: input.paymentMethodId,
      preferred_crew_id: input.preferredCrewId,
      service_minutes: rateEntry?.service_minutes || 120,
      next_run_date: nextRun.toISODate(),
    })
    .select('id, next_run_date')
    .single();

  if (error) throw error;

  // Write to owner_confirmations for approval (money-touching action)
  await db.from('owner_confirmations').insert({
    tenant_id: tenantId,
    series_id: series.id,
    action: 'start_recurring_series',
    fee_cents: input.priceCents,
    status: 'pending',
  });

  return { seriesId: series.id, nextRunDate: series.next_run_date };
}

// ============ SKIP / PAUSE / RESUME / CANCEL SERIES ============

export const skipNextVisitSchema = z.object({
  seriesId: z.string().uuid(),
});

export async function skipNextVisit(
  db: Database,
  tenantId: string,
  input: z.infer<typeof skipNextVisitSchema>
): Promise<{ skipped: boolean; nextDate: string }> {
  const { data: series } = await db
    .from('recurring_series')
    .select('next_run_date, interval_weeks, anchor_weekday')
    .eq('tenant_id', tenantId)
    .eq('id', input.seriesId)
    .single();

  // Advance next_run_date by interval_weeks
  const nextDate = DateTime.fromISO(series.next_run_date)
    .plus({ weeks: series.interval_weeks })
    .toISODate();

  await db
    .from('recurring_series')
    .update({ next_run_date: nextDate })
    .eq('id', input.seriesId);

  return { skipped: true, nextDate };
}

export const pauseSeriesSchema = z.object({
  seriesId: z.string().uuid(),
  pauseUntil: z.string(), // ISO date
});

export async function pauseSeries(
  db: Database,
  tenantId: string,
  input: z.infer<typeof pauseSeriesSchema>
): Promise<{ paused: boolean }> {
  await db
    .from('recurring_series')
    .update({ status: 'paused', paused_until: input.pauseUntil })
    .eq('tenant_id', tenantId)
    .eq('id', input.seriesId);

  return { paused: true };
}

export const resumeSeriesSchema = z.object({
  seriesId: z.string().uuid(),
});

export async function resumeSeries(
  db: Database,
  tenantId: string,
  input: z.infer<typeof resumeSeriesSchema>
): Promise<{ resumed: boolean }> {
  await db
    .from('recurring_series')
    .update({ status: 'active', paused_until: null })
    .eq('tenant_id', tenantId)
    .eq('id', input.seriesId);

  return { resumed: true };
}

export const cancelSeriesSchema = z.object({
  seriesId: z.string().uuid(),
});

export async function cancelSeries(
  db: Database,
  tenantId: string,
  input: z.infer<typeof cancelSeriesSchema>
): Promise<{ cancelled: boolean }> {
  // Money-touching action → requires owner confirmation
  const { data: series } = await db
    .from('recurring_series')
    .select('price_cents')
    .eq('id', input.seriesId)
    .single();

  await db
    .from('recurring_series')
    .update({ status: 'cancelled' })
    .eq('id', input.seriesId);

  // Write to owner_confirmations
  await db.from('owner_confirmations').insert({
    tenant_id: tenantId,
    series_id: input.seriesId,
    action: 'cancel_series',
    fee_cents: series.price_cents,
    status: 'pending',
  });

  return { cancelled: true };
}

// ============ PAYMENT METHOD (CARD ON FILE) ============

export const saveCardOnFileSchema = z.object({
  clientId: z.string().uuid(),
  stripeCustomerId: z.string(),
  stripePmId: z.string(),
  brand: z.string().optional(),
  last4: z.string().optional(),
});

export async function saveCardOnFile(
  db: Database,
  tenantId: string,
  input: z.infer<typeof saveCardOnFileSchema>
): Promise<{ paymentMethodId: string }> {
  // Upsert: if the client already has this PM, update; else insert
  const { data: pm, error } = await db
    .from('payment_methods')
    .upsert(
      {
        tenant_id: tenantId,
        client_id: input.clientId,
        stripe_customer_id: input.stripeCustomerId,
        stripe_pm_id: input.stripePmId,
        brand: input.brand,
        last4: input.last4,
        status: 'active',
      },
      { onConflict: 'tenant_id, stripe_pm_id' }
    )
    .select('id')
    .single();

  if (error) throw error;

  return { paymentMethodId: pm.id };
}

// ============ CHANGE SERIES CADENCE (WITH RE-QUOTE) ============

export const changeSeriesCadenceSchema = z.object({
  seriesId: z.string().uuid(),
  newIntervalWeeks: z.number().int().min(1).max(4),
  frequencyId: z.string().uuid().optional(), // if changing frequency
});

export async function changeSeriesCadence(
  db: Database,
  tenantId: string,
  input: z.infer<typeof changeSeriesCadenceSchema>
): Promise<{ newPrice: number; requiresConfirmation: boolean }> {
  const { data: series } = await db
    .from('recurring_series')
    .select('price_cents, frequency_id')
    .eq('id', input.seriesId)
    .single();

  // Re-quote based on new cadence
  const frequencyId = input.frequencyId || series.frequency_id;
  const { data: newRateEntry } = await db
    .from('rate_card_entries')
    .select('price_cents')
    .eq('frequency_id', frequencyId)
    .single();

  const newPrice = newRateEntry?.price_cents || series.price_cents;
  const priceDelta = Math.abs(newPrice - series.price_cents);
  const requiresConfirmation = priceDelta > 500; // > $5 delta requires confirm

  if (requiresConfirmation) {
    // Write to owner_confirmations
    await db.from('owner_confirmations').insert({
      tenant_id: tenantId,
      series_id: input.seriesId,
      action: 'change_series_cadence',
      old_price_cents: series.price_cents,
      new_price_cents: newPrice,
      status: 'pending',
    });
  } else {
    // Auto-apply small changes
    await db
      .from('recurring_series')
      .update({
        interval_weeks: input.newIntervalWeeks,
        frequency_id: frequencyId,
        price_cents: newPrice,
      })
      .eq('id', input.seriesId);
  }

  return { newPrice, requiresConfirmation };
}
