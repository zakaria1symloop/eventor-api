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
];