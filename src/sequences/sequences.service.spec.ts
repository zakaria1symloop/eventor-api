import type { DataSource, EntityManager } from 'typeorm';
import { formatReference, SequencesService, sequenceRowName } from './sequences.service.js';

describe('formatReference', () => {
  it.each([
    ['booking', 123, 'EVT-000123'],
    ['academic_request', 142, 'ACR-000142'],
    ['dispute', 31, 'DSP-000031'],
    ['invoice', 318, 'INV-2026-0318'],
    ['booking', 1234567, 'EVT-1234567'],
  ] as const)('%s #%d → %s', (name, value, expected) => {
    expect(formatReference(name, value, 2026)).toBe(expected);
  });

  it('keeps one invoice counter per year', () => {
    expect(sequenceRowName('invoice', 2027)).toBe('invoice_2027');
    expect(sequenceRowName('booking', 2027)).toBe('booking');
  });
});

describe('SequencesService.next', () => {
  function fakeManager(rows: Record<string, number>) {
    const calls: string[] = [];
    const em = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push(sql);
        const name = String(params.at(-1));
        if (sql.startsWith('SELECT')) {
          return name in rows ? [{ value: String(rows[name]) }] : [];
        }
        if (sql.startsWith('INSERT IGNORE')) {
          rows[name] ??= 0;
        }
        if (sql.startsWith('UPDATE')) {
          rows[name] = Number(params[0]);
        }
        return [];
      }),
    } as unknown as EntityManager;
    return { em, calls, rows };
  }

  const service = new SequencesService({} as DataSource);

  it('locks the row FOR UPDATE, increments and formats', async () => {
    const { em, calls, rows } = fakeManager({ booking: 122 });
    await expect(service.next('booking', em)).resolves.toBe('EVT-000123');
    expect(calls[0]).toMatch(/^SELECT .* FOR UPDATE$/);
    expect(calls[1]).toMatch(/^UPDATE/);
    expect(calls.some((sql) => sql.startsWith('INSERT'))).toBe(false);
    expect(rows.booking).toBe(123);
  });

  it('creates a new year row for invoices, then locks it before updating', async () => {
    const { em, calls } = fakeManager({ invoice_2026: 317 });
    await expect(service.next('invoice', em, new Date('2027-01-01T00:00:00Z'))).resolves.toBe('INV-2027-0001');
    expect(calls.map((sql) => sql.split(' ')[0])).toEqual(['SELECT', 'INSERT', 'SELECT', 'UPDATE']);
    expect(calls[2]).toContain('FOR UPDATE');
  });

  it('opens its own transaction when no EntityManager is given', async () => {
    const { em } = fakeManager({ dispute: 0 });
    const dataSource = { transaction: vi.fn((work: (tx: EntityManager) => unknown) => work(em)) };
    const own = new SequencesService(dataSource as unknown as DataSource);
    await expect(own.next('dispute')).resolves.toBe('DSP-000001');
    expect(dataSource.transaction).toHaveBeenCalledOnce();
  });
});
