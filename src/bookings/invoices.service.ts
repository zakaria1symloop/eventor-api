import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { FilePurpose } from '../common/enums/file.enums.js';
import type { EventType } from '../common/enums/catalog.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { StoredFile } from '../files/entities/stored-file.entity.js';
import { FilesService } from '../files/files.service.js';
import { JOBS } from '../queue/jobs.js';
import { QueueService } from '../queue/queue.service.js';
import { SequencesService } from '../sequences/sequences.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { computeFee } from './bookings.policy.js';
import { BOOKING_EVENTS, type InvoiceEvent, type InvoiceSentEvent } from './bookings.events.js';
import type { InvoiceDto, InvoiceSummaryDto } from './dto/bookings.dto.js';
import { Booking } from './entities/booking.entity.js';
import { Invoice } from './entities/invoice.entity.js';
import { renderInvoicePdf } from './invoice-pdf.js';

const dateOnly = (value: Date | string): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

interface InvoiceSnapshot {
  bookingReference: string;
  eventDate: string;
  eventType: EventType;
  titleEn: string;
  titleAr: string;
  client: InvoiceDto['client'];
  provider: InvoiceDto['provider'];
  lines: InvoiceDto['lines'];
}

/** BKG-07: invoices issued by Eventor (immutable snapshots, versioned on price changes). */
@Injectable()
export class InvoicesService implements OnModuleInit {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly sequences: SequencesService,
    private readonly files: FilesService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler<{ invoiceId: string }>(JOBS.renderInvoicePdf, async ({ invoiceId }) => void (await this.renderJob(invoiceId)));
  }

  /** Soft-deletes (voids) every live invoice version of the booking; returns how many. */
  async voidAll(em: EntityManager, bookingId: string): Promise<number> {
    const result = await em.getRepository(Invoice).softDelete({ bookingId, deletedAt: IsNull() });
    return Number(result.affected ?? 0);
  }

  /**
   * Issues version n+1 from the booking's current lines and parties (voiding the
   * live version first) and queues the PDF render after COMMIT.
   */
  async issue(em: EntityManager, afterCommit: AfterCommit, bookingId: string, notify: boolean): Promise<Invoice> {
    const booking = await em.getRepository(Booking).findOneOrFail({ where: { id: bookingId } });
    await this.voidAll(em, bookingId);
    const [{ v }] = await em.query('SELECT COALESCE(MAX(version), 0) AS v FROM invoices WHERE booking_id = ?', [bookingId]);
    const [parties] = await em.query(
      `SELECT cu.id AS client_id, cu.full_name AS client_name, cu.email AS client_email, cu.phone AS client_phone,
              pu.id AS provider_id, pu.full_name AS provider_name, pu.email AS provider_email, pu.phone AS provider_phone, pp.business_name,
              COALESCE(s.title_en, p.name_en) AS title_en, COALESCE(s.title_ar, p.name_ar) AS title_ar
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.provider_id
       LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id LEFT JOIN services s ON s.id = b.service_id LEFT JOIN packs p ON p.id = b.pack_id
       WHERE b.id = ?`,
      [bookingId],
    );
    const lines: any[] = await em.query('SELECT kind, label, quantity, unit_amount, amount FROM booking_lines WHERE booking_id = ? AND deleted_at IS NULL ORDER BY position', [bookingId]);
    const issuer = await this.settings.get('invoice_issuer');
    const currency = await this.settings.get('currency');
    const snapshot: InvoiceSnapshot = {
      bookingReference: booking.reference,
      eventDate: dateOnly(booking.eventDate),
      eventType: booking.eventType,
      titleEn: parties.title_en ?? '',
      titleAr: parties.title_ar ?? '',
      client: { id: parties.client_id, name: parties.client_name, businessName: null, email: parties.client_email, phone: parties.client_phone },
      provider: { id: parties.provider_id, name: parties.provider_name, businessName: parties.business_name ?? null, email: parties.provider_email, phone: parties.provider_phone },
      lines: lines.map((l) => ({ kind: l.kind, label: l.label, quantity: Number(l.quantity), unitAmount: String(l.unit_amount), amount: String(l.amount) })),
    };
    const fee = computeFee(booking.total, booking.feePercent);
    const repository = em.getRepository(Invoice);
    const invoice = await repository.save(
      repository.create({
        bookingId,
        version: Number(v) + 1,
        number: await this.sequences.next('invoice', em),
        issuedAt: new Date(),
        currency: currency || 'DZD',
        subtotal: booking.subtotal,
        discountTotal: booking.discountTotal,
        total: booking.total,
        feePercent: booking.feePercent,
        feeAmount: fee.feeAmount,
        providerAmount: fee.providerAmount,
        issuer: { ...issuer },
        snapshot: snapshot as unknown as Record<string, unknown>,
        pdfFileId: null,
        sentToClientAt: null,
      }),
    );
    afterCommit(() => this.queue.add(JOBS.renderInvoicePdf, { invoiceId: invoice.id }, { jobId: `invoice-pdf-${invoice.id}` }));
    this.events.emitAfterCommit<InvoiceEvent>(afterCommit, BOOKING_EVENTS.invoiceIssued, {
      bookingId,
      reference: booking.reference,
      clientId: booking.clientId,
      providerId: booking.providerId,
      notify,
      invoiceId: invoice.id,
      number: invoice.number,
      version: invoice.version,
    });
    return invoice;
  }

  private async latestEntity(bookingId: string, em: EntityManager = this.dataSource.manager): Promise<Invoice> {
    const booking = await em.getRepository(Booking).findOne({ where: { id: bookingId }, select: { id: true } });
    if (!booking) throw AppException.of('BOOKING_NOT_FOUND');
    const invoice = await em.getRepository(Invoice).findOne({ where: { bookingId }, order: { version: 'DESC' } });
    if (!invoice) throw AppException.of('INVOICE_NOT_FOUND');
    return invoice;
  }

  toDto(invoice: Invoice, versions: number[]): InvoiceDto {
    const s = invoice.snapshot as unknown as InvoiceSnapshot;
    const issuer = invoice.issuer as Record<string, string>;
    return {
      id: invoice.id,
      bookingId: invoice.bookingId,
      bookingReference: s.bookingReference,
      number: invoice.number,
      version: invoice.version,
      issuedAt: new Date(invoice.issuedAt).toISOString(),
      currency: invoice.currency,
      issuer: { name: issuer.name ?? '', address: issuer.address ?? '', nif: issuer.nif ?? '', rc: issuer.rc ?? '', email: issuer.email ?? '', phone: issuer.phone ?? '' },
      client: s.client,
      provider: s.provider,
      titleEn: s.titleEn,
      titleAr: s.titleAr,
      eventDate: s.eventDate,
      eventType: s.eventType,
      lines: s.lines,
      subtotal: String(invoice.subtotal),
      discountTotal: String(invoice.discountTotal),
      total: String(invoice.total),
      feePercent: String(invoice.feePercent),
      feeAmount: String(invoice.feeAmount),
      providerAmount: String(invoice.providerAmount),
      pdfReady: invoice.pdfFileId !== null,
      sentToClientAt: invoice.sentToClientAt ? new Date(invoice.sentToClientAt).toISOString() : null,
      versions,
    };
  }

  async summary(bookingId: string, em: EntityManager = this.dataSource.manager): Promise<InvoiceSummaryDto | null> {
    const invoice = await em.getRepository(Invoice).findOne({ where: { bookingId }, order: { version: 'DESC' } });
    if (!invoice) return null;
    return {
      id: invoice.id,
      number: invoice.number,
      version: invoice.version,
      issuedAt: new Date(invoice.issuedAt).toISOString(),
      total: String(invoice.total),
      pdfReady: invoice.pdfFileId !== null,
      sentToClientAt: invoice.sentToClientAt ? new Date(invoice.sentToClientAt).toISOString() : null,
    };
  }

  async latest(bookingId: string): Promise<InvoiceDto> {
    const invoice = await this.latestEntity(bookingId);
    const versions: { version: number }[] = await this.dataSource.query('SELECT version FROM invoices WHERE booking_id = ? ORDER BY version', [bookingId]);
    return this.toDto(invoice, versions.map((r) => Number(r.version)));
  }

  /** Renders and stores the PDF of an invoice once (job handler; idempotent). */
  async renderJob(invoiceId: string): Promise<string | null> {
    const invoice = await this.dataSource.getRepository(Invoice).findOne({ where: { id: invoiceId }, withDeleted: true });
    if (!invoice) return null;
    if (invoice.pdfFileId) return invoice.pdfFileId;
    const buffer = await renderInvoicePdf(this.toDto(invoice, [invoice.version]));
    const stored = await this.files.store({ buffer, originalName: `${invoice.number}.pdf`, purpose: FilePurpose.Invoice, mimeType: 'application/pdf', ownerId: null });
    const result = await this.dataSource.query('UPDATE invoices SET pdf_file_id = ? WHERE id = ? AND pdf_file_id IS NULL', [stored.id, invoiceId]);
    if (Number(result?.affectedRows ?? 0) === 0) {
      this.logger.warn(`Invoice ${invoice.number} PDF was rendered twice; keeping the first file`);
      const fresh = await this.dataSource.getRepository(Invoice).findOne({ where: { id: invoiceId }, withDeleted: true });
      return fresh?.pdfFileId ?? stored.id;
    }
    return stored.id;
  }

  private async pdfPath(invoice: Invoice): Promise<string> {
    const fileId = invoice.pdfFileId ?? (await this.renderJob(invoice.id));
    const file = fileId ? await this.dataSource.getRepository(StoredFile).findOne({ where: { id: fileId } }) : null;
    if (!file) throw AppException.of('FILE_NOT_FOUND');
    return resolve(this.files.root, file.storagePath);
  }

  /** The latest version's PDF (rendered now if the job has not run yet). */
  async pdf(bookingId: string): Promise<{ buffer: Buffer; fileName: string }> {
    const invoice = await this.latestEntity(bookingId);
    const path = await this.pdfPath(invoice);
    return { buffer: await readFile(path), fileName: `${invoice.number}.pdf` };
  }

  async send(auth: AuthUser, bookingId: string): Promise<InvoiceDto> {
    const invoice = await this.latestEntity(bookingId);
    const path = await this.pdfPath(invoice);
    const [client] = await this.dataSource.query('SELECT u.email, u.full_name, u.language FROM bookings b JOIN users u ON u.id = b.client_id WHERE b.id = ?', [bookingId]);
    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const now = new Date();
      await em.getRepository(Invoice).update(invoice.id, { sentToClientAt: now });
      const snapshot = invoice.snapshot as unknown as InvoiceSnapshot;
      await this.audit.log(
        { action: 'invoice.sent', objectType: 'booking', objectId: bookingId, objectLabel: snapshot.bookingReference, level: AuditLevel.Normal, changes: { invoiceId: invoice.id, number: invoice.number, version: invoice.version, to: client?.email ?? null } },
        em,
      );
      this.events.emitAfterCommit<InvoiceSentEvent>(afterCommit, BOOKING_EVENTS.invoiceSent, {
        bookingId,
        invoiceId: invoice.id,
        number: invoice.number,
        reference: snapshot.bookingReference,
        total: String(invoice.total),
        pdfPath: path,
        client: client ? { email: client.email, name: client.full_name, lang: client.language === "ar" ? "ar" : "en" } : null,
        actorId: auth.id,
      });
    });
    return this.latest(bookingId);
  }
}
