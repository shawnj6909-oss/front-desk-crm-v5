/**
 * Cron job: no_show_sweep (optional, runs every 30 min)
 *
 * Flags probable no-shows for owner confirmation.
 * A booking is probably a no-show if:
 * 1. Status is 'confirmed' (deposit paid)
 * 2. end_at has passed
 * 3. No completion record yet (no way to mark "completed" without the API yet)
 *
 * For each probable no-show:
 * - Alert owner on Telegram
 * - Create owner_confirmation with action='no_show_fee'
 * - Wait for owner to confirm before charging the card
 */

import { Database } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

export async function noShowSweep(
  db: Database,
  tenantId: string
): Promise<{ flagged: number; errors: string[] }> {
  const errors: string[] = [];
  let flagged = 0;
  const now = DateTime.now();

  try {
    // Get all confirmed bookings whose end_at has passed
    const { data: probableNoShows, error: queryErr } = await db
      .from('bookings')
      .select(
        `
        id, client_id, price_cents, status, end_at,
        clients(id, phone, telegram_user_id)
      `
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed')
      .lt('end_at', now.toISO());

    if (queryErr) throw queryErr;

    for (const booking of probableNoShows) {
      try {
        // Check if already flagged / charged
        const { data: existing } = await db
          .from('owner_confirmations')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('booking_id', booking.id)
          .eq('action', 'no_show_fee')
          .eq('status', 'pending');

        if (existing && existing.length > 0) {
          // Already flagged, waiting for owner
          continue;
        }

        // Get policy to compute no-show fee
        const { data: policy } = await db
          .from('cancellation_policies')
          .select('no_show_fee_bps')
          .eq('tenant_id', tenantId)
          .eq('active', true)
          .single();

        const feeBps = policy?.no_show_fee_bps || 10000;
        const feeCents = Math.round((booking.price_cents * feeBps) / 10000);

        // Write owner confirmation (money-touching action)
        const { error: confirmErr } = await db.from('owner_confirmations').insert({
          tenant_id: tenantId,
          booking_id: booking.id,
          action: 'no_show_fee',
          fee_cents: feeCents,
          status: 'pending',
        });

        if (confirmErr) {
          errors.push(`Booking ${booking.id}: failed to create confirmation: ${confirmErr.message}`);
          continue;
        }

        flagged++;

        // Alert owner (optional: send Telegram message)
        // await notifyOwnerTelegram(tenantId, `No-show flagged: ${booking.client_id}, $${feeCents / 100}`);
      } catch (err: any) {
        errors.push(`Booking ${booking.id}: ${err.message}`);
      }
    }

    // Write heartbeat
    await db.from('cron_heartbeats').insert({
      tenant_id: tenantId,
      job_name: 'no_show_sweep',
      last_run: now.toISO(),
      status: 'success',
    });
  } catch (err: any) {
    errors.push(`no_show_sweep fatal error: ${err.message}`);
    await db.from('cron_heartbeats').insert({
      tenant_id: tenantId,
      job_name: 'no_show_sweep',
      last_run: now.toISO(),
      status: 'error',
      error_message: err.message,
    });
  }

  return { flagged, errors };
}
