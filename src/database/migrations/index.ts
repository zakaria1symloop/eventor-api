import type { DataSourceOptions } from 'typeorm';
import { SchemaV11789552455516 } from './1789552455516-SchemaV1.js';
import { SeedV11789552455600 } from './1789552455600-SeedV1.js';
import { MessagesFulltext1789561217020 } from './1789561217020-MessagesFulltext.js';
import { ParticipantsReadPrecision1789561926399 } from './1789561926399-ParticipantsReadPrecision.js';
import { ReportsSystemReporter1789600000000 } from './1789600000000-ReportsSystemReporter.js';
import { AdminListIndexes1789700000000 } from './1789700000000-AdminListIndexes.js';
import { SessionsRevokedReason1789800000000 } from './1789800000000-SessionsRevokedReason.js';
import { ServiceScheduling1791277544612 } from './1791277544612-ServiceScheduling.js';
import { BookingEndDate1791278976405 } from './1791278976405-BookingEndDate.js';
import { OneBookingPerDay1791360000000 } from './1791360000000-OneBookingPerDay.js';
import { AllowSimultaneous1791380000000 } from './1791380000000-AllowSimultaneous.js';
import { UserBlocks1791500000000 } from './1791500000000-UserBlocks.js';
import { LegalSettings1791500000001 } from './1791500000001-LegalSettings.js';
import { AccountDeletionCode1791500000002 } from './1791500000002-AccountDeletionCode.js';
import { BookingAutoExpireSetting1791600000000 } from './1791600000000-BookingAutoExpireSetting.js';
import { RescheduleTotals1791700000000 } from './1791700000000-RescheduleTotals.js';
import { AvailabilityBlockSource1791800000000 } from './1791800000000-AvailabilityBlockSource.js';
import { SystemMessageEvents1791900000000 } from './1791900000000-SystemMessageEvents.js';
import { CancelledBySystem1792000000000 } from './1792000000000-CancelledBySystem.js';
import { BookingLineLabelAr1792100000000 } from './1792100000000-BookingLineLabelAr.js';
import { CancelledByBackfill1792200000000 } from './1792200000000-CancelledByBackfill.js';

/**
 * Ordered migration registry, explicit for the same reason as the entity
 * registry. After `pnpm migration:generate src/database/migrations/<Name>`,
 * import the generated class and append it here.
 */
export const migrations: NonNullable<DataSourceOptions['migrations']> = [
  SchemaV11789552455516,
  SeedV11789552455600,
  MessagesFulltext1789561217020,
  ParticipantsReadPrecision1789561926399,
  ReportsSystemReporter1789600000000,
  AdminListIndexes1789700000000,
  SessionsRevokedReason1789800000000,
  ServiceScheduling1791277544612,
  BookingEndDate1791278976405,
  OneBookingPerDay1791360000000,
  AllowSimultaneous1791380000000,
  UserBlocks1791500000000,
  LegalSettings1791500000001,
  AccountDeletionCode1791500000002,
  BookingAutoExpireSetting1791600000000,
  RescheduleTotals1791700000000,
  AvailabilityBlockSource1791800000000,
  SystemMessageEvents1791900000000,
  CancelledBySystem1792000000000,
  BookingLineLabelAr1792100000000,
  CancelledByBackfill1792200000000,
];