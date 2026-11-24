import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG-H4 / BUG-M3 follow-up (24 Nov 2026): before #18, a provider deleting their
 * own service or pack, or a user deleting their account, cancelled the pending
 * bookings as `admin`. The status history keeps who really did it, so only those
 * rows are corrected: `cancelled_by = 'admin'` whose cancellation actor is the
 * booking's own client or provider. A real admin cancellation (actor = an admin,
 * even "on behalf of" a party) is never touched.
 *
 * Read-only preview of what changes, to run before on live:
 *   SELECT b.reference, IF(sc.actor_id = b.client_id, 'client', 'provider') AS becomes, b.cancel_reason
 *   FROM bookings b JOIN booking_status_changes sc ON sc.booking_id = b.id AND sc.to_status = 'cancelled'
 *   WHERE b.status = 'cancelled' AND b.cancelled_by = 'admin' AND sc.actor_id IN (b.client_id, b.provider_id);
 */
export class CancelledByBackfill1792200000000 implements MigrationInterface {
  name = 'CancelledByBackfill1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE bookings b
       JOIN booking_status_changes sc ON sc.booking_id = b.id AND sc.to_status = 'cancelled'
       SET b.cancelled_by = IF(sc.actor_id = b.client_id, 'client', 'provider')
       WHERE b.status = 'cancelled' AND b.cancelled_by = 'admin' AND sc.actor_id IN (b.client_id, b.provider_id)`,
    );
  }

  public async down(): Promise<void> {
    // A data correction: the wrong values are not restored.
  }
}
