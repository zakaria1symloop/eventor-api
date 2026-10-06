import { HttpStatus } from '@nestjs/common';

export interface ErrorDefinition {
  /** Default HTTP status for the code (AppException can still override). */
  status: HttpStatus;
  en: string;
  ar: string;
}

/**
 * Every error `code` the API returns, grouped by module. Clients switch on the
 * code; `message` is translated with `Accept-Language`. `{placeholders}` are
 * filled from the exception's `details` object.
 *
 * Add codes per module as endpoints are built; never rename a published code.
 */
export const ERROR_CODES = {
  // ── common ────────────────────────────────────────────────
  VALIDATION_FAILED: {
    status: HttpStatus.BAD_REQUEST,
    en: 'Some fields are invalid.',
    ar: 'بعض الحقول غير صالحة.',
  },
  BAD_REQUEST: {
    status: HttpStatus.BAD_REQUEST,
    en: 'The request is malformed.',
    ar: 'الطلب غير صحيح.',
  },
  SORT_FIELD_NOT_ALLOWED: {
    status: HttpStatus.BAD_REQUEST,
    en: 'Cannot sort by "{field}".',
    ar: 'لا يمكن الترتيب حسب "{field}".',
  },
  NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The requested resource was not found.',
    ar: 'المورد المطلوب غير موجود.',
  },
  ROUTE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This route does not exist.',
    ar: 'هذا المسار غير موجود.',
  },
  METHOD_NOT_ALLOWED: {
    status: HttpStatus.METHOD_NOT_ALLOWED,
    en: 'This method is not allowed on this route.',
    ar: 'هذه الطريقة غير مسموح بها على هذا المسار.',
  },
  CONFLICT: {
    status: HttpStatus.CONFLICT,
    en: 'The request conflicts with the current state.',
    ar: 'الطلب يتعارض مع الحالة الحالية.',
  },
  STALE_UPDATE: {
    status: HttpStatus.CONFLICT,
    en: 'This item was changed by someone else. Reload and try again.',
    ar: 'تم تعديل هذا العنصر من قبل شخص آخر. أعد التحميل وحاول مجددًا.',
  },
  UNPROCESSABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The request could not be processed.',
    ar: 'تعذر معالجة الطلب.',
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    en: 'Too many requests. Please try again later.',
    ar: 'طلبات كثيرة جدًا. يرجى المحاولة لاحقًا.',
  },
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    en: 'Something went wrong on our side.',
    ar: 'حدث خطأ من جهتنا.',
  },
  SERVICE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    en: 'The service is temporarily unavailable.',
    ar: 'الخدمة غير متاحة مؤقتًا.',
  },

  // ── auth ──────────────────────────────────────────────────
  AUTH_TOKEN_MISSING: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'Authentication is required.',
    ar: 'يلزم تسجيل الدخول.',
  },
  AUTH_TOKEN_INVALID: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'The access token is invalid.',
    ar: 'رمز الدخول غير صالح.',
  },
  AUTH_TOKEN_EXPIRED: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'The access token has expired.',
    ar: 'انتهت صلاحية رمز الدخول.',
  },
  FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    en: 'You are not allowed to do this.',
    ar: 'غير مسموح لك بالقيام بهذا.',
  },
  FORBIDDEN_ROLE: {
    status: HttpStatus.FORBIDDEN,
    en: 'Your account role cannot access this.',
    ar: 'دور حسابك لا يسمح بالوصول إلى هذا.',
  },
  NOT_OWNER: {
    status: HttpStatus.FORBIDDEN,
    en: 'You do not own this item.',
    ar: 'هذا العنصر ليس ملكك.',
  },
  ACCOUNT_BLOCKED: {
    status: HttpStatus.FORBIDDEN,
    en: 'This account is blocked.',
    ar: 'هذا الحساب محظور.',
  },
  AUTH_SESSION_REVOKED: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'Your session has ended. Please sign in again.',
    ar: 'انتهت جلستك. يرجى تسجيل الدخول مجددًا.',
  },
  AUTH_SESSION_REPLACED: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'You were signed out because this account signed in on another computer.',
    ar: 'تم تسجيل خروجك لأن هذا الحساب سجّل الدخول من جهاز آخر.',
  },
  AUTH_REFRESH_INVALID: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'Your session is no longer valid. Please sign in again.',
    ar: 'جلستك لم تعد صالحة. يرجى تسجيل الدخول مجددًا.',
  },
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    en: 'The email or password is incorrect.',
    ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  },
  ACCOUNT_LOCKED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    en: 'Too many failed attempts. Try again in {retryAfterSeconds} seconds.',
    ar: 'محاولات فاشلة كثيرة. حاول مجددًا بعد {retryAfterSeconds} ثانية.',
  },
  PASSWORD_WEAK: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The password must have at least 10 characters, including a letter and a digit, and must not be a common password.',
    ar: 'يجب أن تتكون كلمة المرور من 10 أحرف على الأقل، منها حرف ورقم، وألا تكون كلمة مرور شائعة.',
  },
  RESET_TOKEN_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    en: 'This password reset link is invalid or has already been used.',
    ar: 'رابط إعادة تعيين كلمة المرور غير صالح أو تم استخدامه.',
  },
  RESET_TOKEN_EXPIRED: {
    status: HttpStatus.GONE,
    en: 'This password reset link has expired.',
    ar: 'انتهت صلاحية رابط إعادة تعيين كلمة المرور.',
  },
  INVITATION_INVALID: {
    status: HttpStatus.NOT_FOUND,
    en: 'This invitation is invalid or has already been used.',
    ar: 'هذه الدعوة غير صالحة أو تم استخدامها.',
  },
  INVITATION_EXPIRED: {
    status: HttpStatus.GONE,
    en: 'This invitation has expired.',
    ar: 'انتهت صلاحية هذه الدعوة.',
  },
  INVITATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The invitation was not found.',
    ar: 'الدعوة غير موجودة.',
  },
  INVITATION_EXISTS: {
    status: HttpStatus.CONFLICT,
    en: 'A pending invitation already exists for this email.',
    ar: 'توجد دعوة معلقة لهذا البريد الإلكتروني.',
  },
  EMAIL_TAKEN: {
    status: HttpStatus.CONFLICT,
    en: 'This email is already used by another account.',
    ar: 'هذا البريد الإلكتروني مستخدم في حساب آخر.',
  },
  CURRENT_PASSWORD_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The current password is incorrect.',
    ar: 'كلمة المرور الحالية غير صحيحة.',
  },
  SESSION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The session was not found.',
    ar: 'الجلسة غير موجودة.',
  },
  ADMIN_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The admin was not found.',
    ar: 'المسؤول غير موجود.',
  },
  CANNOT_REMOVE_SELF: {
    status: HttpStatus.CONFLICT,
    en: 'You cannot remove your own account.',
    ar: 'لا يمكنك حذف حسابك الخاص.',
  },
  LAST_ADMIN: {
    status: HttpStatus.CONFLICT,
    en: 'The last admin cannot be removed.',
    ar: 'لا يمكن حذف آخر مسؤول.',
  },

  // ── settings / sequences ──────────────────────────────────
  SETTING_UNKNOWN: {
    status: HttpStatus.BAD_REQUEST,
    en: 'Unknown setting "{key}".',
    ar: 'إعداد غير معروف "{key}".',
  },
  SETTINGS_CONFIRM_REQUIRED: {
    status: HttpStatus.CONFLICT,
    en: 'Some of these settings are sensitive. Review the changes and confirm.',
    ar: 'بعض هذه الإعدادات حساسة. راجع التغييرات ثم أكّد.',
  },

  // ── activity log, exports, saved views ────────────────────
  AUDIT_LOG_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The activity log entry was not found.',
    ar: 'سجل النشاط غير موجود.',
  },
  EXPORT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The export was not found.',
    ar: 'ملف التصدير غير موجود.',
  },
  SAVED_VIEW_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The saved view was not found.',
    ar: 'العرض المحفوظ غير موجود.',
  },
  SAVED_VIEW_NAME_TAKEN: {
    status: HttpStatus.CONFLICT,
    en: 'You already have a saved view with this name.',
    ar: 'لديك بالفعل عرض محفوظ بهذا الاسم.',
  },

  // ── catalogue ─────────────────────────────────────────────
  CATEGORY_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The category was not found.',
    ar: 'الفئة غير موجودة.',
  },
  SLUG_TAKEN: {
    status: HttpStatus.CONFLICT,
    en: 'This slug is already used.',
    ar: 'هذا المعرّف مستخدم بالفعل.',
  },
  CATEGORY_HAS_SERVICES: {
    status: HttpStatus.CONFLICT,
    en: 'This category still has {servicesCount} services and {providersCount} providers. Choose a category to move them to.',
    ar: 'لا تزال هذه الفئة تضم {servicesCount} خدمة و{providersCount} مقدم خدمة. اختر فئة لنقلهم إليها.',
  },
  CATEGORY_MOVE_TARGET_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Services must be moved to another existing category.',
    ar: 'يجب نقل الخدمات إلى فئة أخرى موجودة.',
  },
  WILAYA_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The wilaya was not found.',
    ar: 'الولاية غير موجودة.',
  },
  WILAYA_CLOSE_CONFIRM_REQUIRED: {
    status: HttpStatus.CONFLICT,
    en: 'Closing this wilaya hides {servicesCount} services and {providersCount} providers there. Confirm to continue.',
    ar: 'إغلاق هذه الولاية يخفي {servicesCount} خدمة و{providersCount} مقدم خدمة فيها. أكّد للمتابعة.',
  },
  COMMUNE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The commune was not found.',
    ar: 'البلدية غير موجودة.',
  },
  COMMUNE_EXISTS: {
    status: HttpStatus.CONFLICT,
    en: 'A commune with this name already exists in this wilaya.',
    ar: 'توجد بلدية بهذا الاسم في هذه الولاية.',
  },
  COMMUNE_IN_USE: {
    status: HttpStatus.CONFLICT,
    en: 'This commune is used by {bookingsCount} bookings and cannot be deleted.',
    ar: 'هذه البلدية مستخدمة في {bookingsCount} حجز ولا يمكن حذفها.',
  },
  CSV_HEADER_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The CSV header must be: {expected}.',
    ar: 'يجب أن يكون رأس ملف CSV: {expected}.',
  },
  CSV_TOO_MANY_ROWS: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The CSV file has more than {maxRows} rows.',
    ar: 'يحتوي ملف CSV على أكثر من {maxRows} سطر.',
  },

  // ── users ─────────────────────────────────────────────────
  USER_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The user was not found.',
    ar: 'المستخدم غير موجود.',
  },
  PHONE_TAKEN: {
    status: HttpStatus.CONFLICT,
    en: 'This phone number is already used by another account.',
    ar: 'رقم الهاتف هذا مستخدم في حساب آخر.',
  },
  ROLE_IMMUTABLE: {
    status: HttpStatus.BAD_REQUEST,
    en: 'The role of an account cannot be changed.',
    ar: 'لا يمكن تغيير دور الحساب.',
  },
  NOT_A_PROVIDER: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This action is only available for provider accounts.',
    ar: 'هذا الإجراء متاح لحسابات مقدمي الخدمات فقط.',
  },
  USER_ALREADY_BLOCKED: {
    status: HttpStatus.CONFLICT,
    en: 'This account is already blocked.',
    ar: 'هذا الحساب محظور بالفعل.',
  },
  USER_NOT_BLOCKED: {
    status: HttpStatus.CONFLICT,
    en: 'This account is not blocked.',
    ar: 'هذا الحساب غير محظور.',
  },
  ACCOUNT_HAS_ACTIVE_ITEMS: {
    status: HttpStatus.CONFLICT,
    en: 'This account has {upcomingBookings} accepted upcoming bookings and {openDisputes} open disputes. Resolve them first.',
    ar: 'لدى هذا الحساب {upcomingBookings} حجز مقبول قادم و{openDisputes} نزاع مفتوح. قم بمعالجتها أولًا.',
  },
  TYPED_NAME_MISMATCH: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The typed name does not match the account name.',
    ar: 'الاسم المكتوب لا يطابق اسم الحساب.',
  },
  BULK_ACTION_REFUSED: {
    status: HttpStatus.CONFLICT,
    en: 'Nothing was changed: {refusedCount} of the selected accounts cannot be processed.',
    ar: 'لم يتم تغيير أي شيء: لا يمكن معالجة {refusedCount} من الحسابات المحددة.',
  },
  NOTE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The note was not found.',
    ar: 'الملاحظة غير موجودة.',
  },

  // ── provider verification ─────────────────────────────────
  DOCUMENT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The document was not found.',
    ar: 'المستند غير موجود.',
  },
  DOCUMENT_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This document cannot move from "{from}" to "{to}".',
    ar: 'لا يمكن نقل هذا المستند من "{from}" إلى "{to}".',
  },

  // ── files ─────────────────────────────────────────────────
  FILE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The file was not found.',
    ar: 'الملف غير موجود.',
  },
  FILE_URL_INVALID: {
    status: HttpStatus.FORBIDDEN,
    en: 'This file link is invalid.',
    ar: 'رابط الملف غير صالح.',
  },
  FILE_URL_EXPIRED: {
    status: HttpStatus.FORBIDDEN,
    en: 'This file link has expired.',
    ar: 'انتهت صلاحية رابط الملف.',
  },
  FILE_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    en: 'The file is larger than {maxMb} MB.',
    ar: 'حجم الملف أكبر من {maxMb} ميغابايت.',
  },
  FILE_TYPE_NOT_ALLOWED: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    en: 'This file type is not allowed.',
    ar: 'نوع الملف غير مسموح به.',
  },
  FILE_NOT_READY: {
    status: HttpStatus.CONFLICT,
    en: 'The file is still being processed.',
    ar: 'لا يزال الملف قيد المعالجة.',
  },

  // ── services & availability (module 6) ────────────────────
  SERVICE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The service was not found.',
    ar: 'الخدمة غير موجودة.',
  },
  CATEGORY_HIDDEN: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This category is hidden and cannot be chosen for a service.',
    ar: 'هذه الفئة مخفية ولا يمكن اختيارها لخدمة.',
  },
  WILAYA_CLOSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Some wilayas are closed: {closed}.',
    ar: 'بعض الولايات مغلقة: {closed}.',
  },
  SERVICE_PUBLISH_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The service cannot be published yet: {missing}.',
    ar: 'لا يمكن نشر الخدمة بعد: {missing}.',
  },
  SERVICE_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible while the service is {status}.',
    ar: 'هذا الإجراء غير ممكن والخدمة في حالة {status}.',
  },
  FEATURED_LIMIT: {
    status: HttpStatus.CONFLICT,
    en: 'At most {max} services can be featured.',
    ar: 'لا يمكن تمييز أكثر من {max} خدمة.',
  },
  SERVICE_HAS_BOOKINGS: {
    status: HttpStatus.CONFLICT,
    en: 'This service has {upcomingBookings} accepted upcoming bookings.',
    ar: 'لهذه الخدمة {upcomingBookings} حجوزات مقبولة قادمة.',
  },
  SERVICE_IN_PACKS: {
    status: HttpStatus.CONFLICT,
    en: 'This service is part of {packsCount} packs of its provider; remove it from them before moving it to another provider.',
    ar: 'هذه الخدمة جزء من {packsCount} باقات لمقدمها؛ أزلها منها قبل نقلها إلى مقدم آخر.',
  },
  PHOTO_LIMIT_REACHED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The photo limit ({max}) is reached.',
    ar: 'تم بلوغ الحد الأقصى للصور ({max}).',
  },
  PHOTO_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The photo was not found.',
    ar: 'الصورة غير موجودة.',
  },
  PHOTO_ORDER_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The order must list every photo exactly once.',
    ar: 'يجب أن يتضمن الترتيب كل صورة مرة واحدة بالضبط.',
  },
  AVAILABILITY_BLOCK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The availability block was not found.',
    ar: 'فترة عدم التوفر غير موجودة.',
  },
  AVAILABILITY_BLOCK_NOT_REMOVABLE: {
    status: HttpStatus.CONFLICT,
    en: 'Only manual blocks can be removed; this day is held or booked by a booking.',
    ar: 'يمكن حذف الحجب اليدوي فقط؛ هذا اليوم محجوز بحجز.',
  },
  AVAILABILITY_DATE_PAST: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The date is in the past.',
    ar: 'التاريخ في الماضي.',
  },
  AVAILABILITY_SERVICE_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The service does not belong to this provider.',
    ar: 'الخدمة لا تخص مقدم الخدمة هذا.',
  },

  // ── ready packs (module 7) ────────────────────────────────
  PACK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The pack was not found.',
    ar: 'الباقة غير موجودة.',
  },
  PACK_SERVICE_NOT_FOUND: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Some services of the pack were not found.',
    ar: 'بعض خدمات الباقة غير موجودة.',
  },
  PACK_SERVICE_OTHER_PROVIDER: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Every service of a pack must belong to the pack’s provider.',
    ar: 'يجب أن تكون كل خدمات الباقة تابعة لمقدم الخدمة نفسه.',
  },
  PACK_PUBLISH_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The pack cannot be published yet: {missing}.',
    ar: 'لا يمكن نشر الباقة بعد: {missing}.',
  },
  PACK_WILAYA_NOT_COVERED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The pack wilaya is not covered by every service in the pack.',
    ar: 'ولاية الباقة غير مغطاة من طرف كل خدمة في الباقة.',
  },
  PACK_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible while the pack is {status}.',
    ar: 'هذا الإجراء غير ممكن والباقة في حالة {status}.',
  },
  PACK_HAS_BOOKINGS: {
    status: HttpStatus.CONFLICT,
    en: 'This pack has {upcomingBookings} accepted upcoming bookings.',
    ar: 'لهذه الباقة {upcomingBookings} حجوزات مقبولة قادمة.',
  },

  // ── bookings & invoices (module 8) ────────────────────────
  BOOKING_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The booking was not found.',
    ar: 'الحجز غير موجود.',
  },
  BOOKING_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'A booking cannot move from "{from}" to "{to}".',
    ar: 'لا يمكن نقل الحجز من "{from}" إلى "{to}".',
  },
  BOOKING_NOT_EDITABLE: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible while the booking is {status}.',
    ar: 'هذا الإجراء غير ممكن والحجز في حالة {status}.',
  },
  DATE_UNAVAILABLE: {
    status: HttpStatus.CONFLICT,
    en: 'The provider is not available on {date}.',
    ar: 'مقدم الخدمة غير متاح بتاريخ {date}.',
  },
  SERVICE_TIMES_REQUIRED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Choose a start and end time: this service is booked by the hour.',
    ar: 'اختر وقت البداية والنهاية: هذه الخدمة تُحجز حسب الساعات.',
  },
  OUTSIDE_SERVICE_HOURS: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This service is not available at these hours on that day.',
    ar: 'هذه الخدمة غير متاحة في هذه الساعات في ذلك اليوم.',
  },
  OUTSIDE_SERVICE_PERIOD: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This service can only be booked for events in its availability period.',
    ar: 'لا يمكن حجز هذه الخدمة إلا لمناسبات ضمن فترة توفرها.',
  },
  SLOT_UNAVAILABLE: {
    status: HttpStatus.CONFLICT,
    en: 'These hours are already booked on {date}. Choose other times.',
    ar: 'هذه الساعات محجوزة بالفعل بتاريخ {date}. اختر أوقاتًا أخرى.',
  },
  BOOKING_DUPLICATE: {
    status: HttpStatus.CONFLICT,
    en: 'You already have booking {reference} for this on {date} at the same time.',
    ar: 'لديك بالفعل الحجز {reference} لهذا في {date} في نفس الوقت.',
  },
  SERVICE_UNAVAILABLE_FOR_BOOKING: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This service cannot be booked: it is not visible in the app.',
    ar: 'لا يمكن حجز هذه الخدمة: إنها غير ظاهرة في التطبيق.',
  },
  PACK_UNAVAILABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This pack cannot be booked: it is not visible in the app.',
    ar: 'لا يمكن حجز هذه الباقة: إنها غير ظاهرة في التطبيق.',
  },
  PROVIDER_NOT_ACCEPTING: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The provider is not accepting bookings.',
    ar: 'مقدم الخدمة لا يقبل الحجوزات حاليًا.',
  },
  MIN_NOTICE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The event date must be on or after {minDate}.',
    ar: 'يجب أن يكون تاريخ المناسبة في {minDate} أو بعده.',
  },
  BOOKING_DATE_PAST: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The date is in the past.',
    ar: 'التاريخ في الماضي.',
  },
  NOT_A_CLIENT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Bookings can only be made for client accounts.',
    ar: 'يمكن إنشاء الحجوزات لحسابات العملاء فقط.',
  },
  BOOKING_EXTRA_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Some extras do not belong to this service.',
    ar: 'بعض الإضافات لا تخص هذه الخدمة.',
  },
  BOOKING_TOTAL_NEGATIVE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The booking total cannot be negative.',
    ar: 'لا يمكن أن يكون مجموع الحجز سالبًا.',
  },
  COMMUNE_WILAYA_MISMATCH: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The commune is not in this wilaya.',
    ar: 'البلدية ليست في هذه الولاية.',
  },
  ACADEMIC_REQUEST_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The academic request was not found.',
    ar: 'الطلب الأكاديمي غير موجود.',
  },
  USE_RESCHEDULE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Use the reschedule action to change the event date.',
    ar: 'استخدم إجراء إعادة الجدولة لتغيير تاريخ المناسبة.',
  },
  RESCHEDULE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The reschedule proposal was not found.',
    ar: 'اقتراح إعادة الجدولة غير موجود.',
  },
  RESCHEDULE_NOT_PENDING: {
    status: HttpStatus.CONFLICT,
    en: 'This reschedule proposal is already {status}.',
    ar: 'اقتراح إعادة الجدولة هذا أصبح {status}.',
  },
  RESCHEDULE_PENDING_EXISTS: {
    status: HttpStatus.CONFLICT,
    en: 'A new date is already waiting for confirmation. Cancel it first.',
    ar: 'يوجد تاريخ جديد في انتظار التأكيد. ألغه أولًا.',
  },
  REMINDER_TOO_SOON: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    en: 'The provider was reminded less than 12 hours ago. Try again in {retryAfterSeconds} seconds.',
    ar: 'تم تذكير مقدم الخدمة منذ أقل من 12 ساعة. حاول مجددًا بعد {retryAfterSeconds} ثانية.',
  },
  INVOICE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This booking has no invoice.',
    ar: 'لا توجد فاتورة لهذا الحجز.',
  },

  // ── messages (module 11) ──────────────────────────────────
  CONVERSATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The conversation was not found.',
    ar: 'المحادثة غير موجودة.',
  },
  MESSAGE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The message was not found.',
    ar: 'الرسالة غير موجودة.',
  },
  MESSAGE_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This message is {status}; this action is not possible.',
    ar: 'هذه الرسالة في حالة {status}؛ هذا الإجراء غير ممكن.',
  },
  CONVERSATION_CLOSED: {
    status: HttpStatus.CONFLICT,
    en: 'This conversation is closed. Reopen it to write.',
    ar: 'هذه المحادثة مغلقة. أعد فتحها للكتابة.',
  },
  CONVERSATION_NOT_CLOSED: {
    status: HttpStatus.CONFLICT,
    en: 'This conversation is not closed.',
    ar: 'هذه المحادثة غير مغلقة.',
  },
  CONVERSATION_ALREADY_CLOSED: {
    status: HttpStatus.CONFLICT,
    en: 'This conversation is already closed.',
    ar: 'هذه المحادثة مغلقة بالفعل.',
  },
  PARTICIPANT_NOT_FOUND: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The user is not a participant of this conversation.',
    ar: 'المستخدم ليس مشاركًا في هذه المحادثة.',
  },
  RECIPIENT_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Messages can only be sent to existing client or provider accounts.',
    ar: 'يمكن إرسال الرسائل إلى حسابات العملاء أو مقدمي الخدمات الموجودة فقط.',
  },

  // ── disputes (module 9) ───────────────────────────────────
  DISPUTE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The dispute was not found.',
    ar: 'النزاع غير موجود.',
  },
  DISPUTE_ALREADY_OPEN: {
    status: HttpStatus.CONFLICT,
    en: 'This booking already has an open dispute ({reference}).',
    ar: 'هذا الحجز لديه نزاع مفتوح بالفعل ({reference}).',
  },
  BOOKING_NOT_DISPUTABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'A dispute can only be opened on an accepted, completed or cancelled booking.',
    ar: 'لا يمكن فتح نزاع إلا على حجز مقبول أو مكتمل أو ملغى.',
  },
  DISPUTE_WINDOW_CLOSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The dispute window for this booking is closed. Use ignoreWindow with a note to open it anyway.',
    ar: 'انتهت مهلة فتح النزاع لهذا الحجز. استخدم ignoreWindow مع ملاحظة لفتحه على أي حال.',
  },
  DISPUTE_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible on a {status} dispute.',
    ar: 'هذا الإجراء غير ممكن على نزاع بحالة {status}.',
  },
  DISPUTE_PARTY_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The user is not a party of this dispute.',
    ar: 'المستخدم ليس طرفًا في هذا النزاع.',
  },
  DISPUTE_EVIDENCE_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'A party can add at most {max} evidence files.',
    ar: 'يمكن لكل طرف إضافة {max} ملفات إثبات كحد أقصى.',
  },
  EVIDENCE_FILE_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Some evidence files do not exist or are not private uploads.',
    ar: 'بعض ملفات الإثبات غير موجودة أو ليست ملفات خاصة.',
  },

  // ── forms & academic requests (module 10) ─────────────────
  FORM_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The form was not found.',
    ar: 'النموذج غير موجود.',
  },
  FORM_CLOSED: {
    status: HttpStatus.GONE,
    en: 'This form is no longer accepting requests.',
    ar: 'هذا النموذج لم يعد يستقبل الطلبات.',
  },
  FORM_VERSION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The form version was not found.',
    ar: 'نسخة النموذج غير موجودة.',
  },
  FORM_SCHEMA_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The form schema is invalid.',
    ar: 'مخطط النموذج غير صالح.',
  },
  FORM_TRANSLATION_MISSING: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Every label must be filled in English and Arabic before publishing.',
    ar: 'يجب ملء كل التسميات بالإنجليزية والعربية قبل النشر.',
  },
  FORM_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible on a {status} form.',
    ar: 'هذا الإجراء غير ممكن على نموذج بحالة {status}.',
  },
  FORM_HAS_SUBMISSIONS: {
    status: HttpStatus.CONFLICT,
    en: 'This form has {submissionsCount} submissions. Close it instead.',
    ar: 'هذا النموذج لديه {submissionsCount} طلبات. أغلقه بدلًا من ذلك.',
  },
  FORM_DEFAULT_REQUIRED: {
    status: HttpStatus.CONFLICT,
    en: 'Exactly one form must be the default. Make another form the default first.',
    ar: 'يجب أن يكون نموذج واحد بالضبط هو الافتراضي. اجعل نموذجًا آخر افتراضيًا أولًا.',
  },
  FORM_ANSWERS_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Some answers are invalid.',
    ar: 'بعض الإجابات غير صالحة.',
  },
  FORM_SUBMISSION_LIMIT: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    en: 'This email has reached the monthly limit of {limit} requests for this form.',
    ar: 'بلغ هذا البريد الحد الشهري البالغ {limit} طلبات لهذا النموذج.',
  },
  FORM_REQUIRES_ACCOUNT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'This form requires an Eventor client account with this email.',
    ar: 'يتطلب هذا النموذج حساب عميل في Eventor بهذا البريد.',
  },
  CODE_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The verification code is incorrect.',
    ar: 'رمز التحقق غير صحيح.',
  },
  CODE_EXPIRED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The verification code has expired. Ask for a new one.',
    ar: 'انتهت صلاحية رمز التحقق. اطلب رمزًا جديدًا.',
  },
  CODE_RESEND_TOO_SOON: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    en: 'A code was just sent. Try again in {retryAfterSeconds} seconds.',
    ar: 'تم إرسال رمز للتو. حاول مجددًا بعد {retryAfterSeconds} ثانية.',
  },
  UPLOAD_TOKEN_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'An uploaded file has expired or does not belong to this form. Upload it again.',
    ar: 'انتهت صلاحية ملف مرفوع أو لا ينتمي إلى هذا النموذج. ارفعه مجددًا.',
  },
  EDIT_LINK_INVALID: {
    status: HttpStatus.NOT_FOUND,
    en: 'This edit link is invalid or has expired.',
    ar: 'رابط التعديل هذا غير صالح أو منتهي الصلاحية.',
  },
  ACADEMIC_REQUEST_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible on a {status} request.',
    ar: 'هذا الإجراء غير ممكن على طلب بحالة {status}.',
  },
  ACADEMIC_REQUEST_FIELDS_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Some fields do not exist in the form version of this request.',
    ar: 'بعض الحقول غير موجودة في نسخة النموذج الخاصة بهذا الطلب.',
  },
  PROPOSAL_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The proposal was not found.',
    ar: 'الاقتراح غير موجود.',
  },
  PROPOSAL_EXISTS: {
    status: HttpStatus.CONFLICT,
    en: 'This service is already proposed for the request.',
    ar: 'هذه الخدمة مقترحة بالفعل لهذا الطلب.',
  },
  PROPOSAL_BOOKED: {
    status: HttpStatus.CONFLICT,
    en: 'This proposal already has a booking.',
    ar: 'هذا الاقتراح لديه حجز بالفعل.',
  },
  REQUESTER_NOT_CLIENT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The requester email belongs to a non-client account.',
    ar: 'بريد صاحب الطلب يخص حسابًا ليس حساب عميل.',
  },

  // ── reviews & reports (module 12) ─────────────────────────
  REVIEW_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The review was not found.',
    ar: 'التقييم غير موجود.',
  },
  REVIEW_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible on a {status} review.',
    ar: 'هذا الإجراء غير ممكن على تقييم بحالة {status}.',
  },
  REVIEW_NO_OPEN_REPORTS: {
    status: HttpStatus.CONFLICT,
    en: 'This review has no open reports to dismiss.',
    ar: 'لا توجد بلاغات مفتوحة على هذا التقييم.',
  },
  REVIEW_REPLY_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The review reply was not found.',
    ar: 'الرد على التقييم غير موجود.',
  },
  REVIEW_REPLY_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This action is not possible on a {status} reply.',
    ar: 'هذا الإجراء غير ممكن على رد بحالة {status}.',
  },
  REPORT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The report was not found.',
    ar: 'البلاغ غير موجود.',
  },
  REPORT_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    en: 'This report is already {status}.',
    ar: 'هذا البلاغ بحالة {status} بالفعل.',
  },
  REPORT_NOT_CONVERTIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Only reports on a review or a message linked to a booking can become a dispute.',
    ar: 'يمكن تحويل البلاغات إلى نزاع فقط إذا كانت على تقييم أو رسالة مرتبطة بحجز.',
  },
  MESSAGE_NO_OPEN_REPORTS: {
    status: HttpStatus.CONFLICT,
    en: 'This message has no open reports.',
    ar: 'لا توجد بلاغات مفتوحة على هذه الرسالة.',
  },

  // ── overview & search (module 13) ─────────────────────────
  OVERVIEW_RANGE_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The date range is invalid: "from" must be on or before "to", at most 366 days.',
    ar: 'نطاق التاريخ غير صالح: يجب أن يكون "from" قبل "to" أو يساويه، بحد أقصى 366 يومًا.',
  },
  // ── mobile app API (module 15) ────────────────────────────
  FORBIDDEN_AUDIENCE: {
    status: HttpStatus.FORBIDDEN,
    en: 'This token belongs to another application.',
    ar: 'هذا الرمز يخص تطبيقًا آخر.',
  },
  EMAIL_NOT_VERIFIED: {
    status: HttpStatus.FORBIDDEN,
    en: 'Verify your email address before signing in.',
    ar: 'يرجى تأكيد بريدك الإلكتروني قبل تسجيل الدخول.',
  },
  EMAIL_ALREADY_VERIFIED: {
    status: HttpStatus.CONFLICT,
    en: 'This email address is already verified.',
    ar: 'تم تأكيد هذا البريد الإلكتروني من قبل.',
  },
  PASSWORD_ALREADY_SET: {
    status: HttpStatus.CONFLICT,
    en: 'This account already has a password. Sign in instead.',
    ar: 'هذا الحساب لديه كلمة مرور بالفعل. سجّل الدخول.',
  },
  ROLE_NOT_ALLOWED_IN_APP: {
    status: HttpStatus.FORBIDDEN,
    en: 'Only client and provider accounts can use the app.',
    ar: 'حسابات العملاء ومقدمي الخدمات فقط يمكنها استخدام التطبيق.',
  },
  PROVIDER_FIELDS_REQUIRED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'A provider account needs a business name and a category.',
    ar: 'حساب مقدم الخدمة يحتاج إلى اسم النشاط والفئة.',
  },
  PROVIDER_FIELDS_NOT_ALLOWED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'These fields belong to provider accounts only.',
    ar: 'هذه الحقول خاصة بحسابات مقدمي الخدمات فقط.',
  },
  PROVIDER_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This provider was not found.',
    ar: 'لم يتم العثور على مقدم الخدمة.',
  },
  FAVOURITE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This favourite was not found.',
    ar: 'لم يتم العثور على هذا المفضل.',
  },
  FAVOURITE_TARGET_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Send exactly one of serviceId or packId.',
    ar: 'أرسل إما serviceId أو packId، وليس كليهما.',
  },
  BUDGET_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'You have not created a budget yet.',
    ar: 'لم تنشئ ميزانية بعد.',
  },
  BUDGET_ITEM_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This budget line was not found.',
    ar: 'لم يتم العثور على هذا البند.',
  },
  BUDGET_ITEM_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'A budget cannot hold more than {max} lines.',
    ar: 'لا يمكن أن تحتوي الميزانية على أكثر من {max} بند.',
  },
  BUDGET_BOOKING_ALREADY_LINKED: {
    status: HttpStatus.CONFLICT,
    en: 'This booking is already linked to another budget line.',
    ar: 'هذا الحجز مرتبط بالفعل ببند آخر في الميزانية.',
  },
  NOTIFICATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This notification was not found.',
    ar: 'لم يتم العثور على هذا الإشعار.',
  },
  DEVICE_TOKEN_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'This device token is not registered.',
    ar: 'رمز الجهاز هذا غير مسجل.',
  },
  MONTH_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    en: 'The month must look like YYYY-MM.',
    ar: 'يجب أن يكون الشهر بالصيغة YYYY-MM.',
  },

  // ── mobile app, part 2: bookings, messaging, reviews, disputes ──
  PROVIDER_NOT_VERIFIED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Your profile is still being reviewed. You can publish and accept bookings once it is approved.',
    ar: 'لا يزال ملفك قيد المراجعة. يمكنك النشر وقبول الحجوزات بعد الموافقة عليه.',
  },
  CHECK_IN_NOT_ALLOWED: {
    status: HttpStatus.CONFLICT,
    en: 'This booking cannot be confirmed in its current state.',
    ar: 'لا يمكن تأكيد هذا الحجز في حالته الحالية.',
  },
  CHECK_IN_TOO_EARLY: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'You can confirm once the event has taken place.',
    ar: 'يمكنك التأكيد بعد انتهاء المناسبة.',
  },
  CHECK_IN_DISPUTED: {
    status: HttpStatus.CONFLICT,
    en: 'A problem is already open on this booking.',
    ar: 'هناك مشكلة مفتوحة بالفعل على هذا الحجز.',
  },
  REVIEW_EXISTS: {
    status: HttpStatus.CONFLICT,
    en: 'You have already reviewed this booking.',
    ar: 'لقد قمت بتقييم هذا الحجز من قبل.',
  },
  REVIEW_NOT_ALLOWED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'Only the client of a completed booking can leave a review.',
    ar: 'يمكن فقط لعميل حجز مكتمل ترك تقييم.',
  },
  REVIEW_WINDOW_CLOSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'The review window for this booking is closed.',
    ar: 'انتهت مهلة التقييم لهذا الحجز.',
  },
  REVIEW_EDIT_WINDOW_CLOSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    en: 'A review can only be edited within 48 hours.',
    ar: 'يمكن تعديل التقييم خلال 48 ساعة فقط.',
  },
  REVIEW_REPLY_EXISTS: {
    status: HttpStatus.CONFLICT,
    en: 'You have already replied to this review.',
    ar: 'لقد قمت بالرد على هذا التقييم من قبل.',
  },
  REPORT_TARGET_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    en: 'The reported item was not found.',
    ar: 'لم يتم العثور على العنصر المُبلّغ عنه.',
  },
  NOT_A_PARTICIPANT: {
    status: HttpStatus.FORBIDDEN,
    en: 'You are not part of this conversation.',
    ar: 'أنت لست طرفًا في هذه المحادثة.',
  },
  CONVERSATION_READ_ONLY: {
    status: HttpStatus.FORBIDDEN,
    en: 'You cannot write in this conversation.',
    ar: 'لا يمكنك الكتابة في هذه المحادثة.',
  },
  DISPUTE_NOT_WITHDRAWABLE: {
    status: HttpStatus.CONFLICT,
    en: 'Only the person who opened a dispute can withdraw it, while it is still open.',
    ar: 'يمكن فقط لمن فتح النزاع سحبه، وما دام مفتوحًا.',
  },
  BOOKING_TAB_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    en: 'Unknown tab "{tab}".',
    ar: 'تبويب غير معروف "{tab}".',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}
