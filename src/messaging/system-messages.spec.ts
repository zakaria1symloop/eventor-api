import { describe, expect, it } from 'vitest';
import { humanDate, readSystemPart, renderSystemMessage, type SystemMessageData } from './system-messages.js';

const data = (params: Partial<SystemMessageData['params']> = {}): SystemMessageData => ({
  bookingId: 'b-1',
  bookingRef: 'EVT-000123',
  params: { date: '2026-12-03', startTime: '18:00', endTime: '22:00', titleEn: 'Wedding DJ', titleAr: 'دي جي للأعراس', ...params },
});

describe('booking system messages (BUG-G2)', () => {
  it('writes event dates as words, never ISO, in both languages', () => {
    expect(humanDate('2026-12-03', 'en')).toBe('3 December 2026');
    expect(humanDate('2026-12-03', 'ar')).toBe('3 ديسمبر 2026');
    const en = renderSystemMessage('booking_requested', data(), 'en');
    const ar = renderSystemMessage('booking_requested', data(), 'ar');
    expect(en).toBe('Booking EVT-000123 requested for 3 December 2026 (18:00–22:00): Wedding DJ.');
    expect(ar).toBe('تم طلب الحجز EVT-000123 بتاريخ 3 ديسمبر 2026 (18:00–22:00): دي جي للأعراس.');
    expect(`${en}${ar}`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('names who acted: the client, the provider or Eventor', () => {
    expect(renderSystemMessage('booking_cancelled', data({ actor: 'client' }), 'en')).toBe('The client cancelled booking EVT-000123.');
    expect(renderSystemMessage('booking_declined', data({ actor: 'provider' }), 'ar')).toBe('رفض مقدم الخدمة الحجز EVT-000123.');
    expect(renderSystemMessage('booking_cancelled', data({ actor: 'admin' }), 'en')).toBe('Eventor cancelled booking EVT-000123.');
  });

  it('describes reschedules with the new day, hours and total', () => {
    const moved = data({ actor: 'client', oldDate: '2026-12-03', newDate: '2026-12-10', newStartTime: '18:00', newEndTime: '23:00', oldTotal: '24000.00', newTotal: '30000.00' });
    expect(renderSystemMessage('reschedule_proposed', moved, 'en')).toBe(
      'The client proposed to move booking EVT-000123 to 10 December 2026 (18:00–23:00). New total: 30000.00 DZD (was 24000.00 DZD).',
    );
    expect(renderSystemMessage('reschedule_declined', moved, 'en')).toBe(
      'The new date for booking EVT-000123 (10 December 2026) was declined. The booking stays on 3 December 2026.',
    );
  });

  it('reads the stored part back, and ignores rows without one', () => {
    expect(readSystemPart({ system_event: 'booking_accepted', system_data: JSON.stringify(data()) })?.data.bookingId).toBe('b-1');
    expect(readSystemPart({ system_event: null, system_data: null })).toBeNull();
    expect(readSystemPart({ system_event: 'something_else', system_data: data() })).toBeNull();
  });
});
