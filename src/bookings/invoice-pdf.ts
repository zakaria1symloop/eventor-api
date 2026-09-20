import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { InvoiceDto } from './dto/bookings.dto.js';

/**
 * Bundled Noto Naskh Arabic (SIL OFL, `assets/fonts/OFL.txt`) for Arabic names
 * and titles; Latin text uses the built-in Helvetica. Resolved from this file so
 * it works from both `src/bookings` (tsx, vitest) and `dist/bookings`.
 */
const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const ARABIC_REGULAR = `${FONT_DIR}NotoNaskhArabic-Regular.ttf`;
const ARABIC_BOLD = `${FONT_DIR}NotoNaskhArabic-Bold.ttf`;

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

const EVENT_TYPES: Record<string, string> = {
  wedding: 'Wedding',
  engagement: 'Engagement',
  henna: 'Henna night',
  birthday: 'Birthday',
  circumcision: 'Circumcision',
  graduation: 'Graduation',
  corporate: 'Corporate event',
  conference: 'Conference',
  academic: 'Academic event',
  other: 'Event',
};

/** `45000.00` → `45 000.00 DZD`. */
export function formatDzd(amount: string): string {
  const [int = '0', dec = '00'] = amount.replace('-', '').split('.');
  return `${amount.startsWith('-') ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${dec.padEnd(2, '0')} DZD`;
}

/**
 * Draws the invoice (A4, English layout). Arabic strings are set in the Arabic
 * font; fontkit shapes and orders pure-Arabic runs right to left, but a single
 * string mixing Arabic and Latin words is not bidi-reordered (limitation).
 */
export function renderInvoicePdf(invoice: InvoiceDto): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${invoice.number}`, Author: invoice.issuer.name || 'Eventor' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hasArabicFont = existsSync(ARABIC_REGULAR);
    if (hasArabicFont) {
      doc.registerFont('ar', ARABIC_REGULAR);
      doc.registerFont('ar-bold', existsSync(ARABIC_BOLD) ? ARABIC_BOLD : ARABIC_REGULAR);
    }
    const font = (value: string, bold = false) => {
      if (hasArabicFont && ARABIC.test(value)) doc.font(bold ? 'ar-bold' : 'ar');
      else doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    };
    const write = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { bold?: boolean; size?: number; color?: string } = {}) => {
      font(value, options.bold);
      doc.fontSize(options.size ?? 10).fillColor(options.color ?? '#1d1d1f').text(value, x, y, options);
    };

    const left = 50;
    const right = 545;
    const width = right - left;

    // Header
    write(invoice.issuer.name || 'Eventor', left, 50, { bold: true, size: 20 });
    const issuerLines = [invoice.issuer.address, invoice.issuer.nif && `NIF ${invoice.issuer.nif}`, invoice.issuer.rc && `RC ${invoice.issuer.rc}`, invoice.issuer.email, invoice.issuer.phone].filter(Boolean) as string[];
    issuerLines.forEach((line, i) => write(line, left, 78 + i * 13, { size: 9, color: '#555' }));
    write('INVOICE', 350, 50, { bold: true, size: 20, width: 195, align: 'right' });
    write(invoice.number, 350, 76, { size: 11, width: 195, align: 'right' });
    write(`Version ${invoice.version}`, 350, 91, { size: 9, color: '#555', width: 195, align: 'right' });
    write(`Issued ${invoice.issuedAt.slice(0, 10)}`, 350, 104, { size: 9, color: '#555', width: 195, align: 'right' });
    write(`Booking ${invoice.bookingReference}`, 350, 117, { size: 9, color: '#555', width: 195, align: 'right' });

    // Parties
    let y = 160;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e5ea').stroke();
    y += 12;
    const party = (title: string, p: InvoiceDto['client'], x: number) => {
      write(title, x, y, { bold: true, size: 9, color: '#86868b' });
      write(p.name, x, y + 14, { bold: true, size: 11, width: 230 });
      let line = y + 32;
      for (const value of [p.businessName, p.email, p.phone]) {
        if (!value) continue;
        write(value, x, line, { size: 9, color: '#555', width: 230 });
        line += 13;
      }
    };
    party('BILLED TO (CLIENT)', invoice.client, left);
    party('SERVICE PROVIDER', invoice.provider, 300);

    // Event
    y += 90;
    write('EVENT', left, y, { bold: true, size: 9, color: '#86868b' });
    write(invoice.titleEn, left, y + 14, { bold: true, size: 11, width });
    if (invoice.titleAr) write(invoice.titleAr, left, y + 30, { size: 11, width, align: 'right' });
    write(`${EVENT_TYPES[invoice.eventType] ?? 'Event'} · ${invoice.eventDate}`, left, y + 50, { size: 9, color: '#555' });

    // Lines
    y += 80;
    doc.rect(left, y, width, 20).fill('#f5f5f7');
    const cols = { label: left + 8, qty: 330, unit: 380, amount: 465 };
    write('Description', cols.label, y + 6, { bold: true, size: 9 });
    write('Qty', cols.qty, y + 6, { bold: true, size: 9, width: 40, align: 'right' });
    write('Unit price', cols.unit, y + 6, { bold: true, size: 9, width: 80, align: 'right' });
    write('Amount', cols.amount, y + 6, { bold: true, size: 9, width: 72, align: 'right' });
    y += 26;
    for (const line of invoice.lines) {
      write(line.label, cols.label, y, { size: 9, width: 270 });
      write(String(line.quantity), cols.qty, y, { size: 9, width: 40, align: 'right' });
      write(formatDzd(line.unitAmount), cols.unit, y, { size: 9, width: 80, align: 'right' });
      write(formatDzd(line.amount), cols.amount, y, { size: 9, width: 72, align: 'right' });
      y += 18;
      if (y > 700) {
        doc.addPage();
        y = 60;
      }
    }

    // Totals
    y += 6;
    doc.moveTo(330, y).lineTo(right, y).strokeColor('#e5e5ea').stroke();
    y += 8;
    const total = (label: string, value: string, bold = false) => {
      write(label, 330, y, { size: bold ? 11 : 9, bold, width: 120 });
      write(value, 440, y, { size: bold ? 11 : 9, bold, width: 105, align: 'right' });
      y += bold ? 20 : 15;
    };
    total('Subtotal', formatDzd(invoice.subtotal));
    if (invoice.discountTotal !== '0.00') total('Discounts', formatDzd(`-${invoice.discountTotal}`));
    total('Total', formatDzd(invoice.total), true);
    total(`Eventor fee (${Number(invoice.feePercent)}%)`, formatDzd(invoice.feeAmount));
    total('Provider amount', formatDzd(invoice.providerAmount));

    y += 20;
    write('Payment is made in cash directly to the provider. Amounts are informational; this invoice is issued by Eventor as a record of the booking.', left, y, {
      size: 8,
      color: '#86868b',
      width,
    });
    doc.end();
  });
}
