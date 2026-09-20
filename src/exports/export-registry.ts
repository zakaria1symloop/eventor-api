import { Injectable, type Type } from '@nestjs/common';

export type ExportCell = string | number | boolean | Date | null;

export interface ExportColumn<R> {
  /** Stable key clients send in `columns`. */
  key: string;
  /** Header written in the file (English). */
  header: string;
  value: (row: R) => ExportCell;
}

/**
 * One exportable resource (STA-05). Modules register theirs in `onModuleInit`:
 *
 *   this.exports.register({ resource: 'bookings', filters: BookingFiltersDto, columns, count, fetch });
 *
 * `filters` is a class-validator DTO (usually the list endpoint's filters without
 * pagination), so an export applies exactly the filters the list screen uses.
 */
export interface ExportDefinition<F extends object = any, R = any> {
  resource: string;
  /** Screen code(s) the export serves, for Swagger. */
  screens: string;
  filters: Type<F>;
  columns: ExportColumn<R>[];
  /** Used when the request has no `columns`; defaults to every column. */
  defaultColumns?: string[];
  /** Number of rows the filters match (decides sync vs queued). */
  count(filters: F): Promise<number>;
  /** One page of rows in a stable order. */
  fetch(filters: F, page: { offset: number; limit: number }): Promise<R[]>;
}

/** Pluggable list of exportable resources, filled by the owning modules. */
@Injectable()
export class ExportRegistry {
  private readonly definitions = new Map<string, ExportDefinition>();

  register<F extends object, R>(definition: ExportDefinition<F, R>): void {
    if (this.definitions.has(definition.resource)) {
      throw new Error(`An export for "${definition.resource}" is already registered`);
    }
    const keys = definition.columns.map((c) => c.key);
    if (new Set(keys).size !== keys.length) {
      throw new Error(`Export "${definition.resource}" has duplicate column keys`);
    }
    this.definitions.set(definition.resource, definition as ExportDefinition);
  }

  get(resource: string): ExportDefinition | undefined {
    return this.definitions.get(resource);
  }

  list(): ExportDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  }
}
