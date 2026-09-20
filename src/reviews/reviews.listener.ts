import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ReportStatus, ReportTargetType } from '../common/enums/moderation.enums.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ReportsService } from './reports.service.js';
import { REVIEW_EVENTS, type ReplyModeratedEvent, type ReportCreatedEvent, type ReportsClosedEvent, type ReviewCreatedEvent, type ReviewModeratedEvent } from './reviews.events.js';

const REASONS: Record<string, { en: string; ar: string }> = {
  inappropriate: { en: 'inappropriate content', ar: 'محتوى غير لائق' },
  spam: { en: 'spam', ar: 'رسائل مزعجة' },
  contact_outside: { en: 'contact details outside Eventor', ar: 'معلومات اتصال خارج Eventor' },
  harassment: { en: 'harassment', ar: 'تحرش' },
  fake: { en: 'fake', ar: 'مزيف' },
  other: { en: 'other', ar: 'أخرى' },
};

const TARGETS: Record<ReportTargetType, { type: string; en: string; ar: string }> = {
  review: { type: 'review.reported', en: 'Review reported', ar: 'تم الإبلاغ عن تقييم' },
  review_reply: { type: 'review.reported', en: 'Review reply reported', ar: 'تم الإبلاغ عن رد على تقييم' },
  message: { type: 'message.reported', en: 'Message reported', ar: 'تم الإبلاغ عن رسالة' },
  service: { type: 'report.new', en: 'Service reported', ar: 'تم الإبلاغ عن خدمة' },
  pack: { type: 'report.new', en: 'Pack reported', ar: 'تم الإبلاغ عن باقة' },
  user: { type: 'report.new', en: 'User reported', ar: 'تم الإبلاغ عن مستخدم' },
};

const MODERATION_TEXT = {
  hide: { en: ['Your review was hidden', 'Your review no longer appears publicly because it does not follow the review rules.'], ar: ['تم إخفاء تقييمك', 'لم يعد تقييمك ظاهرًا لأنه لا يتوافق مع قواعد التقييمات.'] },
  show: { en: ['Your review is visible again', 'Your review appears publicly again.'], ar: ['تقييمك ظاهر من جديد', 'أصبح تقييمك ظاهرًا للجميع من جديد.'] },
  redact: { en: ['Your review was edited', 'Part of your review (such as contact details) was removed before publishing.'], ar: ['تم تعديل تقييمك', 'تمت إزالة جزء من تقييمك (مثل معلومات الاتصال) قبل نشره.'] },
} as const;

/** Review and report notifications (status-rules §8–§9). */
@Injectable()
export class ReviewsListener {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly reports: ReportsService,
  ) {}

  private async languages(userIds: string[]): Promise<Map<string, 'en' | 'ar'>> {
    if (!userIds.length) return new Map();
    const rows: { id: string; language: string }[] = await this.dataSource.query('SELECT id, language FROM users WHERE id IN (?) AND deleted_at IS NULL', [userIds]);
    return new Map(rows.map((r) => [r.id, r.language === 'ar' ? 'ar' : 'en']));
  }

  /** status-rules §8: a new review tells the provider (🔔📱). */
  @OnEvent(REVIEW_EVENTS.created)
  async onReviewCreated(event: ReviewCreatedEvent): Promise<void> {
    const lang = (await this.languages([event.providerId])).get(event.providerId) ?? 'en';
    const stars = '★'.repeat(event.rating);
    await this.notifications.notify(
      [event.providerId],
      {
        type: 'review.new',
        title: lang === 'ar' ? 'تقييم جديد' : 'New review',
        body:
          lang === 'ar'
            ? `تلقيت تقييمًا جديدًا (${event.rating}/5) على الحجز ${event.bookingReference}.`
            : `You received a new review (${event.rating}/5, ${stars}) on booking ${event.bookingReference}.`,
        data: { reviewId: event.reviewId, bookingId: event.bookingId, rating: event.rating },
      },
      { push: true },
    );
  }

  @OnEvent(REVIEW_EVENTS.reportCreated)
  async onReportCreated(event: ReportCreatedEvent): Promise<void> {
    const target = (await this.reports.targetSummaries([{ type: event.targetType, id: event.targetId }])).get(`${event.targetType}:${event.targetId}`)!;
    const kind = TARGETS[event.targetType];
    const reason = REASONS[event.reason] ?? REASONS.other!;
    await this.notifications.notifyAdmins({
      type: kind.type,
      en: { title: kind.en, body: `${target.label} · ${reason.en}${event.automatic ? ' (detected automatically)' : ''}.` },
      ar: { title: kind.ar, body: `${target.label} · ${reason.ar}${event.automatic ? ' (اكتُشف تلقائيًا)' : ''}.` },
      data: {
        href: target.href ?? '/reviews?tab=reported',
        reportId: event.reportId,
        targetType: event.targetType,
        targetId: event.targetId,
        reviewId: target.reviewId,
        conversationId: target.conversationId,
      },
    });
  }

  @OnEvent(REVIEW_EVENTS.moderated)
  async onModerated(event: ReviewModeratedEvent): Promise<void> {
    if (!event.notifyAuthor) return;
    const lang = (await this.languages([event.authorId])).get(event.authorId);
    if (!lang) return;
    const [title, body] = MODERATION_TEXT[event.action][lang];
    await this.notifications.notify([event.authorId], { type: `review.${event.action === 'show' ? 'shown' : event.action === 'hide' ? 'hidden' : 'redacted'}`, title, body, data: { reviewId: event.reviewId } });
  }

  @OnEvent(REVIEW_EVENTS.replyModerated)
  async onReplyModerated(event: ReplyModeratedEvent): Promise<void> {
    const lang = (await this.languages([event.providerId])).get(event.providerId);
    if (!lang) return;
    const hidden = event.action === 'hide';
    const text = hidden
      ? { en: ['Your reply was hidden', 'Your public reply to a review no longer appears.'], ar: ['تم إخفاء ردك', 'لم يعد ردك العام على التقييم ظاهرًا.'] }
      : { en: ['Your reply is visible again', 'Your public reply to a review appears again.'], ar: ['ردك ظاهر من جديد', 'أصبح ردك على التقييم ظاهرًا من جديد.'] };
    const [title, body] = text[lang];
    await this.notifications.notify([event.providerId], { type: hidden ? 'review_reply.hidden' : 'review_reply.shown', title: title!, body: body!, data: { reviewId: event.reviewId, replyId: event.replyId } });
  }

  /** 🔔 each reporter with the outcome (automatic reports have none). */
  @OnEvent(REVIEW_EVENTS.reportsClosed)
  async onReportsClosed(event: ReportsClosedEvent): Promise<void> {
    const reporters = [...new Set(event.reports.map((r) => r.reporterId).filter((id): id is string => !!id))];
    if (!reporters.length) return;
    const langs = await this.languages(reporters);
    const resolved = event.status === ReportStatus.Resolved;
    for (const userId of reporters) {
      const lang = langs.get(userId);
      if (!lang) continue;
      const report = event.reports.find((r) => r.reporterId === userId)!;
      const en = resolved
        ? ['Thanks for your report', event.disputeReference ? `We opened dispute ${event.disputeReference} to look into it.` : 'We reviewed it and took action.']
        : ['Your report was reviewed', 'We reviewed it and found no rule was broken.'];
      const ar = resolved
        ? ['شكرًا على بلاغك', event.disputeReference ? `فتحنا النزاع ${event.disputeReference} لمتابعته.` : 'راجعنا البلاغ واتخذنا الإجراء اللازم.']
        : ['تمت مراجعة بلاغك', 'راجعنا البلاغ ولم نجد مخالفة للقواعد.'];
      const [title, body] = lang === 'ar' ? ar : en;
      await this.notifications.notify([userId], { type: resolved ? 'report.resolved' : 'report.dismissed', title: title!, body: body!, data: { reportId: report.id, targetType: event.targetType } });
    }
  }
}
