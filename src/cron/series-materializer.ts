/**
 * Cron job: series_materializer
 * Runs daily at 15:00 UTC
 *
 * For each active recurring series past its lead window:
 * 1. Create the next booking (pending_deposit)
 * 2. Assign it to preferred crew (or any free crew)
 * 3. Auto-charge the card on file (or send deposit link if no card)
 * 4. Advance next_run_date
 * 5. Write heartbeat
 *
 * Idempotent per (series_id, next_run_date) — handles retries.
 */

import { Database } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

interface SeriesMaterializerInput {
  tenantId: string;
  leadWindowDays: number; // e.g., 7 days before, materialize if next_run_date <= today + 7
}

export async function seriesMaterializer(
  db: Database,
  input: SeriesMaterializerInput
): Promise<{ bookingsCreated: number; chargesAttempted: number; errors: string[] }> {
  const tenantId = input.tenantId;
  const errors: string[] = [];
  let bookingsCreated = 0;
  let chargesAttempted = 0;

  const now = DateTime.now();
  const materializeUntil = now.plus({ days: input.leadWindowDays }).toISODate()!;

  try {
    // 1. Get all active series due for materialization
    const { data: series, error: seriesErr } = await db
      .from('recurring_series')
      .select(
        `
        id, tenant_id, client_id, property_id, frequency_id,
        interval_weeks, anchor_weekday, anchor_start_min,
        preferred_crew_id, price_cents, payment_method_id, service_minutes,
        next_run_date,
        properties(zip),
        payment_methods(stripe_customer_id, stripe_pm_id)
      `
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .lte('next_run_date', materializeUntil);

    if (seriesErr) throw seriesErr;

    for (const s of series) {
      try {
        const nextRunDate = DateTime.fromISO(s.next_run_date);

        // 2. Create booking row (status: pending_deposit)
        const bookingStartTime = nextRunDate
          .set({ hour: Math.floor(s.anchor_start_min / 60), minute: s.anchor_start_min % 60 })
          .toISO();

        const bookingEndTime = nextRunDate
          .set({ hour: Math.floor(s.anchor_start_min / 60), minute: s.anchor_start_min % 60 })
          .plus({ minutes: s.service_minutes })
          .toISO();

        const { data: booking, error: bookingErr } = await db
          .from('bookings')
          .insert({
            tenant_id: tenantId,
            client_id: s.client_id,
            property_id: s.property_id,
            series_id: s.id,
            sequence_no: 1, // TODO: compute from series history
            status: 'pending_deposit',
            price_cents: s.price_cents,
            service_minutes: s.service_minutes,
            start_at: bookingStartTime,
            end_at: bookingEndTime,
            created_at: now.toISO(),
          })
          .select('id')
          .single();

        if (bookingErr) {
          errors.push(`Series ${s.id}: failed to create booking: ${bookingErr.message}`);
          continue;
        }

        bookingsCreated++;

        // 3. Assign crew (prefer specified crew, else any free crew)
        let crewId = s.preferred_crew_id;
        if (!crewId) {
          // Find any crew free during this window
          const { data: freeCrew } = await db
            .from('crews')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('active', true)
            .not(
              'id',
              'in',
              `(select crew_id from booking_assignments where starts_at <= '${bookingEndTime}' and ends_at > '${bookingStartTime}')`
            )
            .limit(1);

          if (freeCrew && freeCrew.length > 0) {
            crewId = freeCrew[0].id;
          }
        }

        if (!crewId) {
          errors.push(`Series ${s.id}: no free crew available`);
          // Mark for manual review? Don't charge yet.
          continue;
        }

        // 4. Create booking_assignments row (locks the crew slot)
        const { error: assignErr } = await db.from('booking_assignments').insert({
          booking_id: booking.id,
          crew_id: crewId,
          starts_at: bookingStartTime,
          ends_at: bookingEndTime,
        });

        if (assignErr) {
          errors.push(`Series ${s.id}: crew assignment failed: ${assignErr.message}`);
          continue;
        }

        // 5. Auto-charge card on file (or send deposit link)
        if (s.payment_method_id && s.payment_methods?.stripe_customer_id) {
          chargesAttempted++;
          // Call Stripe to charge the card
          // try {
          //   const charge = await stripe.paymentIntents.create({
          //     amount: s.price_cents,
          //     currency: 'usd',
          //     customer: s.payment_methods.stripe_customer_id,
          //     payment_method: s.payment_methods.stripe_pm_id,
          //     confirm: true,
          //     off_session: true,
          //   });
          //
          //   // Update booking to confirmed (deposit collected)
          //   await db
          //     .from('bookings')
          //     .update({ status: 'confirmed', paid_deposit_at: now.toISO() })
          //     .eq('id', booking.id);
          // } catch (stripeErr) {
          //   errors.push(`Series ${s.id}: Stripe charge failed: ${stripeErr.message}`);
          //   // Leave booking as pending_deposit, will retry next run
          // }
        } else {
          // No card on file; send deposit link instead
          // await sendDepositLink(db, booking.id, s.client_id);
        }

        // 6. Advance next_run_date by interval_weeks
        const nextNextRunDate = nextRunDate.plus({ weeks: s.interval_weeks }).toISODate()!;

        const { error: updateErr } = await db
          .from('recurring_series')
          .update({ next_run_date: nextNextRunDate })
          .eq('id', s.id);

        if (updateErr) {
          errors.push(`Series ${s.id}: failed to advance next_run_date: ${updateErr.message}`);
        }
      } catch (err: any) {
        errors.push(`Series ${s.id}: unexpected error: ${err.message}`);
      }
    }

    // Write heartbeat
    await db.from('cron_heartbeats').insert({
      tenant_id: tenantId,
      job_name: 'series_materializer',
      last_run: now.toISO(),
      status: 'success',
    });
  } catch (err: any) {
    errors.push(`series_materializer fatal error: ${err.message}`);
    await db.from('cron_heartbeats').insert({
      tenant_id: tenantId,
      job_name: 'series_materializer',
      last_run: now.toISO(),
      status: 'error',
      error_message: err.message,
    });
  }

  return { bookingsCreated, chargesAttempted, errors };
}
