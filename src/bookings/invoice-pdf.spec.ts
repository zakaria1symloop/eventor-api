import { BookingLineKind } from '../common/enums/booking.enums.js';
import { EventType } from '../common/enums/catalog.enums.js';
import { formatDzd, renderInvoicePdf } from './invoice-pdf.js';

describe('invoice PDF', () => {
  it('formats DZD amounts', () => {
    expect(formatDzd('45000.00')).toBe('45 000.00 DZD');
    expect(formatDzd('-1234567.5')).toBe('-1 234 567.50 DZD');
  });

  it('renders a PDF with the bundled Arabic font for Arabic text', async () => {
    const pdf = await renderInvoicePdf({
      id: 'i',
      bookingId: 'b',
      bookingReference: 'EVT-002041',
      number: 'INV-2026-0318',
      version: 2,
      issuedAt: '2026-09-16T10:00:00.000Z',
      currency: 'DZD',
      issuer: { name: 'Eventor', address: 'Alger', nif: '1', rc: '2', email: 'billing@eventor.dz', phone: '' },
      client: { id: 'c', name: 'أمينة بن علي', businessName: null, email: 'amina.benali@gmail.com', phone: '+213555204101' },
      provider: { id: 'p', name: 'Karim Belkacem', businessName: 'Studio Lumière', email: null, phone: null },
      titleEn: 'Wedding photo & video coverage',
      titleAr: 'تغطية زفاف بالصورة والفيديو',
      eventDate: '2026-10-18',
      eventType: EventType.Wedding,
      lines: [
        { kind: BookingLineKind.Service, label: 'Wedding photo & video coverage', quantity: 1, unitAmount: '120000.00', amount: '120000.00' },
        { kind: BookingLineKind.Discount, label: 'Loyalty', quantity: 1, unitAmount: '5000.00', amount: '-5000.00' },
      ],
      subtotal: '120000.00',
      discountTotal: '5000.00',
      total: '115000.00',
      feePercent: '10.00',
      feeAmount: '11500.00',
      providerAmount: '103500.00',
      pdfReady: false,
      sentToClientAt: null,
      versions: [1, 2],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/NotoNaskhArabic/);
  });
});
