/**
 * Demo reviews, replies, reports and admin notifications (modules 12–13),
 * called by `demo-seed.ts` inside its transaction after the bookings,
 * disputes and academic requests.
 *
 * - Reviews for ~85% of the completed bookings older than 24 h (not while a
 *   dispute is open): ratings mostly 4–5 with some 3 and a few 1–2, comments
 *   in FR / EN / AR. Written through `insertReview`, so the flag scan runs:
 *   comments with a phone number, email or insult get an automatic open report.
 *   A few reviews are hidden or redacted by an admin (their reports resolved).
 * - Provider replies on ~40% of them (a few hidden).
 * - User reports on reviews, a reply, services, a pack and users in every
 *   status, one resolved by conversion to dispute DSP-000025.
 * - Admin notifications (mixed read / unread) in each admin's language.
 *
 * Idempotent: reviews, reports and notifications are skipped when reviews
 * already exist / admins already have notifications. `stats_daily` is
 * backfilled by `demo-seed.ts` after COMMIT.
 */
import type { EntityManager } from 'typeorm';
import { ReportReason, ReportStatus, ReportTargetType, ReviewReplyStatus } from '../../common/enums/moderation.enums.js';
import { closeOpenReports, insertReport, insertReview, insertReviewReply } from '../../reviews/reviews.writes.js';

export interface ReviewSeedContext {
  em: EntityManager;
  admin: { id: string; fullName: string } | null;
  rand: () => number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const COMMENTS: Record<'high' | 'mid' | 'low', string[]> = {
  high: [
    'Photos magnifiques, équipe très professionnelle et ponctuelle. Merci pour tout !',
    'Service impeccable, nos invités ont adoré. Je recommande vivement.',
    'Great team, everything was ready before the guests arrived. Highly recommended.',
    'The DJ read the room perfectly, the dance floor was full all night.',
    'خدمة ممتازة وتنظيم رائع، شكرًا جزيلًا على كل شيء.',
    'أطباق شهية وتقديم أنيق، الضيوف كانوا سعداء جدًا.',
    'Très bon rapport qualité-prix, décoration exactement comme sur les photos.',
    'Friendly, on time and very flexible when we changed the schedule.',
    'Salle propre et spacieuse, le personnel était aux petits soins.',
    'التصوير كان رائعًا والصور وصلت في الموعد المحدد.',
  ],
  mid: [
    'Bien dans l’ensemble, mais un peu de retard au début de la soirée.',
    'Good service, although the setup took longer than announced.',
    'الخدمة جيدة لكن التواصل قبل الحفل كان بطيئًا بعض الشيء.',
    'Correct, sans plus. Les gâteaux étaient bons mais la livraison tardive.',
  ],
  low: [
    'Très déçue : retard de deux heures et matériel incomplet.',
    'The photos were delivered three weeks late and half of them were blurry.',
    'تأخروا كثيرًا ولم يلتزموا بما اتفقنا عليه.',
  ],
};

/** Flagged comments: contact details or insults (automatic reports). */
const FLAGGED = [
  'Super prestation ! Pour un meilleur prix appelez-moi directement au 0661 20 41 02.',
  'Very good, but contact me at studio.contact.dz@gmail.com for the full album cheaper.',
  'Une vraie arnaque, ce prestataire est un escroc. À éviter.',
  'ممتاز، تواصلوا معي على الرقم 0770 45 12 98 للحجز بدون عمولة.',
];

const REPLIES = [
  'Merci beaucoup pour votre confiance, ce fut un plaisir !',
  'Thank you for your kind words, we hope to see you again soon.',
  'شكرًا جزيلًا، سعدنا بخدمتكم ونتمنى لكم السعادة.',
  'Désolé pour le retard, nous avons revu notre organisation depuis.',
  'Thanks for the feedback, we have contacted you to make it right.',
];

const REPLY_HIDDEN = 'Ce client ment, il n’a jamais payé le supplément. Appelez-moi au 0555 12 34 56 si vous voulez la vérité.';

function pickRating(rand: () => number): number {
  const x = rand();
  if (x < 0.5) return 5;
  if (x < 0.78) return 4;
  if (x < 0.9) return 3;
  if (x < 0.96) return 2;
  return 1;
}

export async function seedReviews(ctx: ReviewSeedContext): Promise<{ reviews: number; reviewReplies: number; reports: number; autoReports: number }> {
  const { em, admin, rand } = ctx;
  const summary = { reviews: 0, reviewReplies: 0, reports: 0, autoReports: 0 };
  const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM reviews');
  if (!admin) return summary;
  if (Number(n) > 0) {
    summary.reports += await seedConvertedReport(em, admin);
    return summary;
  }

  const now = Date.now();
  const bookings: any[] = await em.query(
    `SELECT b.id, b.reference, b.completed_at, b.client_id, b.provider_id, b.service_id FROM bookings b
     WHERE b.status = 'completed' AND b.deleted_at IS NULL AND b.dispute_status <> 'open' AND b.completed_at IS NOT NULL AND b.completed_at <= ?
     ORDER BY b.completed_at ASC, b.reference ASC`,
    [new Date(now - DAY)],
  );

  const reviewed: { id: string; rating: number; flagged: boolean; createdAt: Date; reference: string }[] = [];
  let flaggedIndex = 0;
  for (const [index, booking] of bookings.entries()) {
    if (index % 7 === 3) continue; // ~15% of clients never review
    const completedAt = new Date(booking.completed_at).getTime();
    const createdAt = new Date(Math.min(now - HOUR, completedAt + DAY + Math.floor(rand() * 4 * DAY)));
    const flagged = index % 11 === 5 && flaggedIndex < FLAGGED.length;
    let rating = pickRating(rand);
    let comment: string;
    if (flagged) {
      comment = FLAGGED[flaggedIndex]!;
      rating = comment.includes('arnaque') ? 1 : 5;
      flaggedIndex += 1;
    } else {
      const pool = rating >= 4 ? COMMENTS.high : rating === 3 ? COMMENTS.mid : COMMENTS.low;
      comment = pool[Math.floor(rand() * pool.length)]!;
    }
    const inserted = await insertReview(em, { bookingId: booking.id, rating, comment, createdAt });
    if (inserted.reportId) summary.autoReports += 1;
    reviewed.push({ id: inserted.id, rating, flagged: inserted.flags.length > 0, createdAt, reference: booking.reference });
    summary.reviews += 1;
  }

  // Admin moderation: redact the contact-detail reviews except the latest one (kept reported), hide the insult and two low ratings.
  const flaggedReviews = reviewed.filter((r) => r.flagged);
  for (const [i, review] of flaggedReviews.entries()) {
    if (i === flaggedReviews.length - 1) continue;
    const [row] = await em.query('SELECT comment, detected_flags FROM reviews WHERE id = ?', [review.id]);
    const insult = String(row.detected_flags).includes('insult');
    const at = new Date(review.createdAt.getTime() + 6 * HOUR);
    if (insult) {
      await em.query("UPDATE reviews SET status = 'hidden', moderated_by_id = ?, moderated_at = ?, moderation_note = ? WHERE id = ?", [admin.id, at, 'Insulting review, no facts given.', review.id]);
    } else {
      const redacted = String(row.comment)
        .replace(/0[\d\s٠-٩]{9,13}\d/g, '[phone hidden]')
        .replace(/\S+@\S+\.\w+/g, '[email hidden]');
      await em.query("UPDATE reviews SET status = 'redacted', redacted_comment = ?, moderated_by_id = ?, moderated_at = ?, moderation_note = ? WHERE id = ?", [
        redacted,
        admin.id,
        at,
        'Contact details removed, rest of the review kept.',
        review.id,
      ]);
    }
    await closeOpenReports(em, { type: ReportTargetType.Review, id: review.id }, { status: ReportStatus.Resolved, adminId: admin.id, note: insult ? 'Review hidden.' : 'Review redacted.', at });
  }
  const lowRatings = reviewed.filter((r) => r.rating <= 2 && !r.flagged).slice(0, 2);
  for (const review of lowRatings) {
    await em.query("UPDATE reviews SET status = 'hidden', moderated_by_id = ?, moderated_at = ?, moderation_note = ? WHERE id = ?", [
      admin.id,
      new Date(review.createdAt.getTime() + 12 * HOUR),
      'Hidden while the booking is checked with the provider.',
      review.id,
    ]);
  }

  // Provider replies (~40%), two hidden.
  const replyIds: string[] = [];
  for (const [i, review] of reviewed.entries()) {
    if (i % 5 !== 1 && i % 5 !== 3) continue;
    const hidden = replyIds.length === 3;
    const body = hidden ? REPLY_HIDDEN : REPLIES[Math.floor(rand() * REPLIES.length)]!;
    const createdAt = new Date(Math.min(now - HOUR / 2, review.createdAt.getTime() + (2 + Math.floor(rand() * 30)) * HOUR));
    const reply = await insertReviewReply(em, { reviewId: review.id, body, createdAt, status: hidden || replyIds.length === 9 ? ReviewReplyStatus.Hidden : ReviewReplyStatus.Published });
    if (reply.reportId) {
      summary.autoReports += 1;
      if (hidden) await closeOpenReports(em, { type: ReportTargetType.ReviewReply, id: reply.id }, { status: ReportStatus.Resolved, adminId: admin.id, note: 'Reply hidden: insults and phone number.', at: new Date(createdAt.getTime() + 3 * HOUR) });
    }
    if (hidden || replyIds.length === 9) await em.query('UPDATE review_replies SET moderated_by_id = ? WHERE id = ?', [admin.id, reply.id]);
    replyIds.push(reply.id);
    summary.reviewReplies += 1;
  }

  // User reports in every status.
  const clients: { id: string }[] = await em.query("SELECT id FROM users WHERE role = 'client' AND status = 'active' AND deleted_at IS NULL ORDER BY email LIMIT 12");
  const providers: { id: string }[] = await em.query("SELECT u.id FROM users u WHERE u.role = 'provider' AND u.deleted_at IS NULL ORDER BY u.email LIMIT 6");
  const services: { id: string; provider_id: string }[] = await em.query("SELECT id, provider_id FROM services WHERE status = 'published' AND deleted_at IS NULL ORDER BY title_en LIMIT 3");
  const [pack] = await em.query("SELECT id FROM packs WHERE deleted_at IS NULL ORDER BY name_en LIMIT 1");
  const reporter = (i: number) => clients[i % Math.max(1, clients.length)]?.id ?? null;
  const decide = async (id: string, status: ReportStatus, note: string, daysAgo: number, disputeId: string | null = null) => {
    const at = new Date(now - daysAgo * DAY);
    await em.query('UPDATE reports SET status = ?, resolved_by_id = ?, resolved_at = ?, resolution_note = ?, dispute_id = ?, updated_at = ? WHERE id = ?', [status, admin.id, at, note, disputeId, at, id]);
  };
  const report = async (input: Parameters<typeof insertReport>[1]) => {
    const created = await insertReport(em, input);
    if (created.created) summary.reports += 1;
    return created.id;
  };

  const lowOpen = reviewed.filter((r) => r.rating <= 3 && !r.flagged && !lowRatings.includes(r));
  if (lowOpen[0] && reporter(0)) {
    await report({ reporterId: providers[0]?.id ?? reporter(0), targetType: ReportTargetType.Review, targetId: lowOpen[0].id, reason: ReportReason.Fake, note: 'This client never showed up at the venue, the review is not honest.', createdAt: new Date(now - 2 * DAY) });
  }
  if (lowOpen[1] && reporter(1)) {
    const id = await report({ reporterId: reporter(1), targetType: ReportTargetType.Review, targetId: lowOpen[1].id, reason: ReportReason.Inappropriate, note: 'Rude review.', createdAt: new Date(now - 9 * DAY) });
    await decide(id, ReportStatus.Dismissed, 'Negative but honest opinion; nothing to remove.', 8);
  }
  if (lowOpen[2] && reporter(2)) {
    const id = await report({ reporterId: reporter(2), targetType: ReportTargetType.Review, targetId: lowOpen[2].id, reason: ReportReason.Harassment, note: 'Mentions my family by name.', createdAt: new Date(now - 14 * DAY) });
    await decide(id, ReportStatus.Resolved, 'Family name removed from the text.', 13);
  }
  if (replyIds[0] && reporter(3)) {
    await report({ reporterId: reporter(3), targetType: ReportTargetType.ReviewReply, targetId: replyIds[0], reason: ReportReason.Inappropriate, note: 'The provider reply is aggressive.', createdAt: new Date(now - DAY) });
  }
  if (services[0] && reporter(4)) {
    await report({ reporterId: reporter(4), targetType: ReportTargetType.Service, targetId: services[0].id, reason: ReportReason.Fake, note: 'The photos are taken from another hall on Instagram.', createdAt: new Date(now - 3 * DAY) });
  }
  if (services[1] && reporter(5)) {
    const id = await report({ reporterId: reporter(5), targetType: ReportTargetType.Service, targetId: services[1].id, reason: ReportReason.Spam, note: 'Same service posted twice.', createdAt: new Date(now - 20 * DAY) });
    await decide(id, ReportStatus.Dismissed, 'Two different offers (day and evening), not a duplicate.', 19);
  }
  if (pack && reporter(6)) {
    await report({ reporterId: reporter(6), targetType: ReportTargetType.Pack, targetId: pack.id, reason: ReportReason.Other, note: 'The pack price does not match the services listed.', createdAt: new Date(now - 4 * DAY) });
  }
  if (providers[1] && reporter(7)) {
    await report({ reporterId: reporter(7), targetType: ReportTargetType.User, targetId: providers[1].id, reason: ReportReason.ContactOutside, note: 'Asked me to pay a deposit by BaridiMob outside the app.', createdAt: new Date(now - 5 * HOUR) });
  }
  if (clients[8] && providers[2]) {
    const id = await report({ reporterId: providers[2].id, targetType: ReportTargetType.User, targetId: clients[8].id, reason: ReportReason.Harassment, note: 'Insulting messages after I declined the booking.', createdAt: new Date(now - 30 * DAY) });
    await decide(id, ReportStatus.Resolved, 'Client warned by support; conversation closed.', 29);
  }

  summary.reports += await seedConvertedReport(em, admin);
  return summary;
}

/**
 * A report on the review of the DSP-000025 booking, resolved by conversion to
 * that dispute (the review is written first when the booking has none).
 * Idempotent: skipped when a report already carries a dispute.
 */
async function seedConvertedReport(em: EntityManager, admin: { id: string }): Promise<number> {
  const [done] = await em.query('SELECT id FROM reports WHERE dispute_id IS NOT NULL LIMIT 1');
  if (done) return 0;
  const [dispute] = await em.query("SELECT d.id, d.reference, d.created_at, d.booking_id, b.client_id, b.completed_at FROM disputes d JOIN bookings b ON b.id = d.booking_id WHERE d.reference = 'DSP-000025' AND b.status = 'completed'");
  if (!dispute) return 0;
  let [review] = await em.query('SELECT id FROM reviews WHERE booking_id = ?', [dispute.booking_id]);
  if (!review) {
    const createdAt = new Date(new Date(dispute.created_at).getTime() - 6 * HOUR);
    review = { id: (await insertReview(em, { bookingId: dispute.booking_id, rating: 2, comment: 'Le service ne correspondait pas à ce qui était prévu, plusieurs plats manquaient.', createdAt })).id };
  }
  const at = new Date(dispute.created_at);
  const { id } = await insertReport(em, {
    reporterId: dispute.client_id,
    targetType: ReportTargetType.Review,
    targetId: review.id,
    reason: ReportReason.Other,
    note: 'I want to add that the service was not delivered as agreed.',
    createdAt: new Date(at.getTime() - 2 * HOUR),
  });
  await em.query("UPDATE reports SET status = 'resolved', resolved_by_id = ?, resolved_at = ?, resolution_note = ?, dispute_id = ?, updated_at = ? WHERE id = ?", [
    admin.id,
    at,
    `Converted to dispute ${dispute.reference}.`,
    dispute.id,
    at,
    id,
  ]);
  return 1;
}

/** SHL-02 demo: a dozen notifications per active admin (in their language), about half read, pointing at real records. */
export async function seedAdminNotifications(em: EntityManager): Promise<{ adminNotifications: number }> {
  const admins: { id: string; language: string }[] = await em.query("SELECT id, language FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL");
  if (!admins.length) return { adminNotifications: 0 };
  const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id IN (?)', [admins.map((a) => a.id)]);
  if (Number(n) > 0) return { adminNotifications: 0 };

  const now = Date.now();
  const one = async (sql: string) => ((await em.query(sql)) as any[])[0] ?? null;
  const provider = await one("SELECT u.id, u.full_name, pp.business_name FROM users u JOIN provider_profiles pp ON pp.user_id = u.id JOIN user_documents d ON d.user_id = u.id AND d.status = 'pending' AND d.is_current = 1 WHERE u.role = 'provider' LIMIT 1");
  const noReply = await one("SELECT id, reference FROM bookings WHERE status = 'pending' ORDER BY created_at LIMIT 1");
  const dispute = await one("SELECT id, reference FROM disputes WHERE status = 'open' ORDER BY created_at DESC LIMIT 1");
  const request = await one("SELECT id, reference, title FROM academic_requests WHERE status = 'pending' ORDER BY submitted_at DESC LIMIT 1");
  const reported = await one("SELECT rp.id AS report_id, r.id AS review_id, r.rating FROM reports rp JOIN reviews r ON r.id = rp.target_id WHERE rp.target_type = 'review' AND rp.status = 'open' ORDER BY rp.created_at DESC LIMIT 1");
  const message = await one("SELECT rp.id AS report_id, m.id AS message_id, m.conversation_id FROM reports rp JOIN messages m ON m.id = rp.target_id WHERE rp.target_type = 'message' AND rp.status = 'open' LIMIT 1");
  const pack = await one('SELECT id, name_en, name_ar FROM packs WHERE needs_attention = 1 LIMIT 1');

  type Item = { type: string; en: [string, string]; ar: [string, string]; data: Record<string, unknown>; hoursAgo: number };
  const items: Item[] = [];
  if (reported)
    items.push({ type: 'review.reported', en: ['Review reported', `★${reported.rating} review contains contact details (detected automatically).`], ar: ['تم الإبلاغ عن تقييم', `تقييم ★${reported.rating} يحتوي على معلومات اتصال (اكتُشف تلقائيًا).`], data: { href: `/reviews/${reported.review_id}`, reviewId: reported.review_id, reportId: reported.report_id }, hoursAgo: 1 });
  if (provider)
    items.push({ type: 'verification.resubmitted', en: ['Documents resubmitted', `${provider.full_name} (${provider.business_name}) sent a new national id for verification.`], ar: ['إعادة إرسال الوثائق', `أرسل ${provider.full_name} (${provider.business_name}) وثيقة جديدة للتحقق.`], data: { href: `/verifications/${provider.id}`, userId: provider.id }, hoursAgo: 3 });
  if (noReply)
    items.push({ type: 'booking.no_reply', en: [`No reply on ${noReply.reference}`, 'The provider has not answered the request for 48 h.'], ar: [`لا رد على ${noReply.reference}`, 'لم يرد مقدم الخدمة على الطلب منذ 48 ساعة.'], data: { href: `/bookings/${noReply.id}`, bookingId: noReply.id, reference: noReply.reference }, hoursAgo: 5 });
  if (dispute)
    items.push({ type: 'dispute.opened', en: [`New dispute ${dispute.reference}`, 'A client opened a dispute on a completed booking.'], ar: [`نزاع جديد ${dispute.reference}`, 'فتح عميل نزاعًا على حجز مكتمل.'], data: { href: `/disputes/${dispute.id}`, disputeId: dispute.id, reference: dispute.reference }, hoursAgo: 9 });
  if (request)
    items.push({ type: 'academic_request.new', en: [`New academic request ${request.reference}`, request.title], ar: [`طلب أكاديمي جديد ${request.reference}`, request.title], data: { href: `/academic-requests/${request.id}`, academicRequestId: request.id, reference: request.reference }, hoursAgo: 20 });
  if (message)
    items.push({ type: 'message.reported', en: ['Message reported', 'A message shares contact details before the booking is confirmed.'], ar: ['تم الإبلاغ عن رسالة', 'رسالة تشارك معلومات اتصال قبل تأكيد الحجز.'], data: { href: `/messages/${message.conversation_id}?message=${message.message_id}`, reportId: message.report_id, conversationId: message.conversation_id }, hoursAgo: 30 });
  if (pack)
    items.push({ type: 'pack.needs_attention', en: ['Pack needs attention', `"${pack.name_en}": an item is no longer available.`], ar: ['باقة تحتاج إلى مراجعة', `«${pack.name_ar || pack.name_en}»: أحد العناصر لم يعد متاحًا.`], data: { href: `/packs/${pack.id}`, packId: pack.id }, hoursAgo: 48 });
  items.push({ type: 'export.ready', en: ['Export ready', 'Your bookings export (5,214 rows) is ready to download.'], ar: ['التصدير جاهز', 'تصدير الحجوزات (5214 سطرًا) جاهز للتنزيل.'], data: { href: '/bookings', resource: 'bookings' }, hoursAgo: 72 });
  if (provider)
    items.push({ type: 'verification.submitted', en: ['New verification document', `${provider.full_name} submitted a trade register for verification.`], ar: ['وثيقة تحقق جديدة', `أرسل ${provider.full_name} سجلًا تجاريًا للتحقق.`], data: { href: `/verifications/${provider.id}`, userId: provider.id }, hoursAgo: 96 });

  let written = 0;
  for (const admin of admins) {
    for (const [i, item] of items.entries()) {
      const at = new Date(now - item.hoursAgo * HOUR);
      const [title, body] = admin.language === 'ar' ? item.ar : item.en;
      // The newest three stay unread.
      const readAt = i < 3 ? null : new Date(at.getTime() + HOUR);
      await em.query('INSERT INTO notifications (id, created_at, updated_at, user_id, type, title, body, data, read_at) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)', [
        at,
        at,
        admin.id,
        item.type,
        title,
        body,
        JSON.stringify(item.data),
        readAt,
      ]);
      written += 1;
    }
  }
  return { adminNotifications: written };
}
