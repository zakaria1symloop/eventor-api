import { AvailabilityKind, PriceType, ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { dayStatus } from './availability.service.js';
import {
  canTransition,
  dailyLimit,
  featureRefusal,
  fromCents,
  isServiceVisible,
  MAX_FEATURED_SERVICES,
  serviceVisibilityReasons,
  servicePublishMissing,
  toCents,
  type PublishCheckInput,
  type ServiceVisibilityInput,
} from './services.policy.js';

const visible = (overrides: Partial<ServiceVisibilityInput> = {}): ServiceVisibilityInput => ({
  status: ServiceStatus.Published,
  deleted: false,
  provider: { status: UserStatus.Active, verificationStatus: VerificationStatus.Verified, deleted: false },
  openWilayas: 1,
  ...overrides,
});

describe('service visibility rule', () => {
  it('is visible when published, provider active and verified, with an open wilaya', () => {
    expect(serviceVisibilityReasons(visible())).toEqual([]);
    expect(isServiceVisible(visible())).toBe(true);
  });

  it.each([
    [{ status: ServiceStatus.Draft }, ['not_published']],
    [{ status: ServiceStatus.Hidden }, ['not_published']],
    [{ deleted: true }, ['deleted']],
    [{ openWilayas: 0 }, ['no_open_wilaya']],
    [{ provider: { status: UserStatus.Blocked, verificationStatus: VerificationStatus.Verified, deleted: false } }, ['provider_blocked']],
    [{ provider: { status: UserStatus.Active, verificationStatus: VerificationStatus.Pending, deleted: false } }, ['provider_not_verified']],
    [{ provider: { status: UserStatus.Active, verificationStatus: VerificationStatus.Rejected, deleted: false } }, ['provider_not_verified']],
    [{ provider: { status: UserStatus.Active, verificationStatus: VerificationStatus.Verified, deleted: true } }, ['provider_deleted']],
  ] as [Partial<ServiceVisibilityInput>, string[]][])('%o → %o', (overrides, reasons) => {
    expect(serviceVisibilityReasons(visible(overrides))).toEqual(reasons);
    expect(isServiceVisible(visible(overrides))).toBe(false);
  });

  it('lists every reason at once', () => {
    expect(
      serviceVisibilityReasons(
        visible({ status: ServiceStatus.Hidden, openWilayas: 0, provider: { status: UserStatus.Blocked, verificationStatus: VerificationStatus.Pending, deleted: false } }),
      ),
    ).toEqual(['not_published', 'provider_blocked', 'provider_not_verified', 'no_open_wilaya']);
  });
});

describe('service publish guard', () => {
  const complete: PublishCheckInput = {
    titleEn: 'Wedding photo & video coverage',
    titleAr: 'تغطية زفاف بالصورة والفيديو',
    descriptionEn: 'Full day.',
    descriptionAr: 'يوم كامل.',
    basePrice: '45000.00',
    priceType: PriceType.PerEvent,
    photos: 3,
    categoryUsable: true,
    wilayas: 2,
  };

  it('passes a complete service', () => {
    expect(servicePublishMissing(complete)).toEqual([]);
  });

  it('lists what is missing in form order', () => {
    expect(servicePublishMissing({ ...complete, titleAr: ' ', descriptionAr: '', photos: 0, wilayas: 0, categoryUsable: false, basePrice: '0.00' })).toEqual([
      'titleAr',
      'descriptionAr',
      'price',
      'photos',
      'category',
      'wilayas',
    ]);
  });

  it('accepts a zero price only on quote', () => {
    expect(servicePublishMissing({ ...complete, basePrice: '0.00', priceType: PriceType.OnQuote })).toEqual([]);
  });
});

describe('service transitions and featuring', () => {
  it.each([
    ['publish', ServiceStatus.Draft, true],
    ['publish', ServiceStatus.Hidden, false],
    ['unpublish', ServiceStatus.Published, true],
    ['unpublish', ServiceStatus.Draft, false],
    ['hide', ServiceStatus.Published, true],
    ['hide', ServiceStatus.Draft, false],
    ['show', ServiceStatus.Hidden, true],
    ['show', ServiceStatus.Published, false],
  ] as const)('%s from %s → %s', (action, from, allowed) => {
    expect(canTransition(action, from)).toBe(allowed);
  });

  it('features published services up to the limit', () => {
    expect(featureRefusal(ServiceStatus.Published, MAX_FEATURED_SERVICES - 1, false)).toBeNull();
    expect(featureRefusal(ServiceStatus.Published, MAX_FEATURED_SERVICES, false)).toBe('FEATURED_LIMIT');
    expect(featureRefusal(ServiceStatus.Published, MAX_FEATURED_SERVICES, true)).toBeNull();
    expect(featureRefusal(ServiceStatus.Draft, 0, false)).toBe('SERVICE_INVALID_TRANSITION');
  });
});

describe('money helpers', () => {
  it.each([
    ['45000.00', 4_500_000],
    ['45000', 4_500_000],
    ['0.5', 50],
    ['12.34', 1234],
    ['-3.10', -310],
  ])('%s → %i cents', (value, cents) => {
    expect(toCents(value)).toBe(cents);
  });

  it('formats cents with two decimals', () => {
    expect(fromCents(4_500_000)).toBe('45000.00');
    expect(fromCents(-4_505)).toBe('-45.05');
    expect(fromCents(7)).toBe('0.07');
  });
});

describe('availability day status', () => {
  const block = (kind: AvailabilityKind, extra: { startTime?: string | null; service?: object | null } = {}) => ({
    kind,
    startTime: extra.startTime ?? null,
    service: (extra.service ?? null) as never,
  });

  it('ranks booked > held > blocked > partial > free', () => {
    expect(dayStatus([])).toBe('free');
    expect(dayStatus([block(AvailabilityKind.Blocked, { startTime: '14:00' })])).toBe('partial');
    expect(dayStatus([block(AvailabilityKind.Blocked, { service: { id: 'x' } })])).toBe('partial');
    expect(dayStatus([block(AvailabilityKind.Blocked)])).toBe('blocked');
    expect(dayStatus([block(AvailabilityKind.Blocked), block(AvailabilityKind.Held)])).toBe('held');
    expect(dayStatus([block(AvailabilityKind.Held), block(AvailabilityKind.Booked)])).toBe('booked');
  });
});

describe('dailyLimit ("Only one booking per day")', () => {
  it('lets the checkbox win, then the old number, then keeps the current value', () => {
    expect(dailyLimit({ onePerDay: true }, null)).toBe(1);
    expect(dailyLimit({ onePerDay: false }, 1)).toBeNull();
    expect(dailyLimit({ onePerDay: false, maxEventsPerDay: 3 }, 1)).toBeNull();
    expect(dailyLimit({ maxEventsPerDay: 3 }, 1)).toBe(3);
    expect(dailyLimit({ maxEventsPerDay: null }, 1)).toBeNull();
    expect(dailyLimit({}, 1)).toBe(1);
  });
});
