/**
 * Drizzle schema definitions for v5: home-services extension
 * Crews, recurring series, properties, payment methods, cancellation policy
 */

import {
  pgTable,
  uuid,
  text,
  smallint,
  integer,
  boolean,
  timestamp,
  date,
  bytea,
  unique,
  check,
  primaryKey,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============ CREWS & CAPACITY ============

export const crews = pgTable(
  'crews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    homeBaseZip: text('home_base_zip').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameIdx: unique('crews_tenant_id_name_idx').on(t.tenantId, t.name),
  })
);

export const crewShifts = pgTable(
  'crew_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crewId: uuid('crew_id')
      .notNull()
      .references(() => crews.id, { onDelete: 'cascade' }),
    weekday: smallint('weekday').notNull(),
    startMin: smallint('start_min').notNull(),
    endMin: smallint('end_min').notNull(),
  },
  (t) => ({
    crewWeekdayIdx: unique('crew_shifts_crew_id_weekday_idx').on(t.crewId, t.weekday),
  })
);

export const crewTimeOff = pgTable(
  'crew_time_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crewId: uuid('crew_id')
      .notNull()
      .references(() => crews.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
  }
);

export const zipDriveMinutes = pgTable(
  'zip_drive_minutes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    fromZip: text('from_zip').notNull(),
    toZip: text('to_zip').notNull(),
    minutes: smallint('minutes').notNull(),
  },
  (t) => ({
    tenantZipsIdx: unique('zip_drive_minutes_tenant_id_from_zip_to_zip_idx').on(
      t.tenantId,
      t.fromZip,
      t.toZip
    ),
  })
);

// ============ PROPERTIES & ACCESS ============

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id').notNull(),
    label: text('label'),
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    zip: text('zip').notNull(),
    beds: smallint('beds'),
    baths: smallint('baths'),
    sqft: integer('sqft'),
    parkingNotes: text('parking_notes'),
    pets: text('pets'),
    specialInstructions: text('special_instructions'),
    entryMethod: text('entry_method').notNull().default('home'),
    entrySecretEnc: bytea('entry_secret_enc'), // encrypted; never to LLM
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdIdx: index('properties_client_id_idx').on(t.tenantId, t.clientId),
    zipIdx: index('properties_zip_idx').on(t.tenantId, t.zip),
  })
);

// ============ BOOKING ASSIGNMENTS ============

export const bookingAssignments = pgTable(
  'booking_assignments',
  {
    bookingId: uuid('booking_id')
      .primaryKey()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    crewId: uuid('crew_id').notNull().references(() => crews.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    crewIdIdx: index('booking_assignments_crew_id_idx').on(
      t.crewId,
      t.startsAt,
      t.endsAt
    ),
  })
);

// ============ RECURRING SERIES ============

export const recursiveSeries = pgTable(
  'recurring_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id').notNull(),
    propertyId: uuid('property_id').notNull().references(() => properties.id),
    frequencyId: uuid('frequency_id').notNull(),
    intervalWeeks: smallint('interval_weeks').notNull(),
    anchorWeekday: smallint('anchor_weekday').notNull(),
    anchorStartMin: smallint('anchor_start_min').notNull(),
    preferredCrewId: uuid('preferred_crew_id').references(() => crews.id),
    priceCents: integer('price_cents').notNull(),
    paymentMethodId: uuid('payment_method_id').references(() => paymentMethods.id),
    status: text('status').notNull().default('active'),
    nextRunDate: date('next_run_date'),
    pausedUntil: date('paused_until'),
    serviceMinutes: smallint('service_minutes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('recurring_series_tenant_id_idx').on(t.tenantId),
    clientIdx: index('recurring_series_client_id_idx').on(t.tenantId, t.clientId),
    nextRunIdx: index('recurring_series_next_run_idx')
      .on(t.tenantId, t.nextRunDate)
      .where(t.status.eq('active')),
  })
);

// ============ PAYMENT METHODS (CARD ON FILE) ============

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripePmId: text('stripe_pm_id').notNull(),
    brand: text('brand'),
    last4: text('last4'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdIdx: index('payment_methods_client_id_idx').on(t.tenantId, t.clientId),
    stripePmIdx: unique('payment_methods_stripe_pm_idx').on(t.tenantId, t.stripePmId),
  })
);

// ============ CANCELLATION POLICY ============

export const cancellationPolicies = pgTable(
  'cancellation_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().unique(),
    freeCancelHours: smallint('free_cancel_hours').notNull().default(24),
    lateCancelBps: integer('late_cancel_bps').notNull().default(5000), // 50% = 5000 bps
    noShowFeeBps: integer('no_show_fee_bps').notNull().default(10000), // 100% = 10000 bps
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  }
);

// ============ EXTEND EXISTING BOOKINGS TABLE ============

export const bookings = pgTable('bookings', {
  // existing columns would be here (id, tenant_id, client_id, etc.)
  propertyId: uuid('property_id').references(() => properties.id),
  seriesId: uuid('series_id').references(() => recursiveSeries.id),
  sequenceNo: integer('sequence_no'),
  serviceMinutes: smallint('service_minutes'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelFeeCents: integer('cancel_fee_cents'),
  rescheduledFrom: uuid('rescheduled_from').references(() => bookings.id),
  // status: pending_deposit | confirmed | completed | rescheduled | cancelled | no_show
});

// ============ RELATIONS ============

export const crewsRelations = relations(crews, ({ many, one }) => ({
  shifts: many(crewShifts),
  timeOff: many(crewTimeOff),
  assignments: many(bookingAssignments),
  recurringSeriesAsPreferred: many(recursiveSeries),
}));

export const bookingAssignmentsRelations = relations(bookingAssignments, ({ one }) => ({
  crew: one(crews, {
    fields: [bookingAssignments.crewId],
    references: [crews.id],
  }),
}));

export const propertiesRelations = relations(properties, ({ one, many }) => ({
  recurringSeriesEntries: many(recursiveSeries),
}));

export const recursiveSeriesRelations = relations(recursiveSeries, ({ one, many }) => ({
  property: one(properties, {
    fields: [recursiveSeries.propertyId],
    references: [properties.id],
  }),
  preferredCrew: one(crews, {
    fields: [recursiveSeries.preferredCrewId],
    references: [crews.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [recursiveSeries.paymentMethodId],
    references: [paymentMethods.id],
  }),
  bookings: many(bookings),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one, many }) => ({
  recurringSeriesEntries: many(recursiveSeries),
}));
