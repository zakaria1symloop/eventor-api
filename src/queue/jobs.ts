/** Job names, one place so producers and handlers cannot drift apart. */
export const JOBS = {
  processImage: 'files.process-image',
  sendMail: 'mail.send',
  sendPush: 'push.send',
  generateExport: 'exports.generate',
  autoUnblockUsers: 'users.auto-unblock',
  anonymiseDeletedUsers: 'users.anonymise-deleted',
  renderInvoicePdf: 'invoices.render-pdf',
  bookingReplyReminders: 'bookings.reply-reminders',
  bookingAutoComplete: 'bookings.auto-complete',
  bookingReviewRequests: 'bookings.review-requests',
  disputeCloseConversations: 'disputes.close-conversations',
  academicRequestsComplete: 'academic-requests.complete',
  bookingNoReplyAlerts: 'notifications.booking-no-reply',
  statsRollup: 'stats.rollup',
} as const;
