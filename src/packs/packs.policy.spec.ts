import { PackStatus, ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import {
  canPackTransition,
  isPackVisible,
  packAttentionReasons,
  packPricing,
  packPublishMissing,
  priceBelowSum,
  type PackItemState,
  type PackProviderState,
} from './packs.policy.js';

const item = (serviceId: string, basePrice: string, overrides: Partial<PackItemState> = {}): PackItemState => ({
  serviceId,
  basePrice,
  status: ServiceStatus.Published,
  deleted: false,
  ...overrides,
});
const okProvider: PackProviderState = { status: UserStatus.Active, verificationStatus: VerificationStatus.Verified, deleted: false };

describe('pack pricing', () => {
  it('computes the sum of items and the savings', () => {
    expect(packPricing('380000.00', [item('a', '250000.00'), item('b', '120000.00'), item('c', '55000.00')])).toEqual({
      sumOfItems: '425000.00',
      savings: '45000.00',
      savingsPercent: 10.6,
    });
  });

  it('reports negative savings when the pack costs more, and ignores deleted items', () => {
    expect(packPricing('100000.00', [item('a', '60000.00'), item('b', '30000.50'), item('c', '99999.00', { deleted: true })])).toEqual({
      sumOfItems: '90000.50',
      savings: '-9999.50',
      savingsPercent: -11.1,
    });
  });

  it('has no percentage without items', () => {
    expect(packPricing('1000.00', [])).toEqual({ sumOfItems: '0.00', savings: '-1000.00', savingsPercent: 0 });
  });

  it.each([
    ['89999.99', true],
    ['90000.00', false],
    ['90000.01', false],
    ['0.00', false],
  ])('price %s below 90000.00 → %s', (price, expected) => {
    expect(priceBelowSum(price, [item('a', '60000.00'), item('b', '30000.00')])).toBe(expected);
  });
});

describe('pack needs attention', () => {
  it('is healthy with published items and an active verified provider', () => {
    expect(packAttentionReasons([item('a', '1'), item('b', '1')], okProvider)).toEqual([]);
  });

  it('flags unpublished or deleted items and the provider state', () => {
    expect(
      packAttentionReasons([item('a', '1', { status: ServiceStatus.Hidden }), item('b', '1', { deleted: true }), item('c', '1', { status: ServiceStatus.Draft })], {
        status: UserStatus.Blocked,
        verificationStatus: VerificationStatus.Pending,
        deleted: false,
      }),
    ).toEqual([
      { code: 'item_not_published', serviceId: 'a' },
      { code: 'item_deleted', serviceId: 'b' },
      { code: 'item_not_published', serviceId: 'c' },
      { code: 'provider_blocked', serviceId: null },
      { code: 'provider_not_verified', serviceId: null },
    ]);
  });
});

describe('pack publish guard', () => {
  const input = { nameEn: 'Essentiel Mariage', nameAr: 'باقة الزفاف الأساسية', price: '380000.00', items: [item('a', '250000.00'), item('b', '175000.00')], provider: okProvider };

  it('passes a complete pack', () => {
    expect(packPublishMissing(input)).toEqual([]);
  });

  it('lists every missing requirement', () => {
    expect(
      packPublishMissing({
        nameEn: 'X',
        nameAr: '',
        price: '500000.00',
        items: [item('a', '250000.00', { status: ServiceStatus.Draft })],
        provider: { status: UserStatus.Blocked, verificationStatus: VerificationStatus.Rejected, deleted: false },
      }),
    ).toEqual(['nameAr', 'items', 'unpublishedItems', 'providerBlocked', 'providerNotVerified', 'priceNotBelowSum']);
  });

  it('counts a deleted item as unpublished and not as an item', () => {
    expect(packPublishMissing({ ...input, items: [item('a', '250000.00'), item('b', '175000.00', { deleted: true })], price: '100000.00' })).toEqual([
      'items',
      'unpublishedItems',
    ]);
  });
});

describe('pack transitions and visibility', () => {
  it.each([
    ['publish', PackStatus.Draft, true],
    ['publish', PackStatus.Unpublished, true],
    ['publish', PackStatus.Published, false],
    ['unpublish', PackStatus.Published, true],
    ['unpublish', PackStatus.Draft, false],
  ] as const)('%s from %s → %s', (action, from, allowed) => {
    expect(canPackTransition(action, from)).toBe(allowed);
  });

  it('is visible only when published, healthy, in an open wilaya, with an active verified provider', () => {
    const base = { status: PackStatus.Published, needsAttention: false, deleted: false, provider: okProvider, wilayaOpen: true };
    expect(isPackVisible(base)).toBe(true);
    expect(isPackVisible({ ...base, needsAttention: true })).toBe(false);
    expect(isPackVisible({ ...base, status: PackStatus.Unpublished })).toBe(false);
    expect(isPackVisible({ ...base, wilayaOpen: false })).toBe(false);
    expect(isPackVisible({ ...base, provider: { ...okProvider, verificationStatus: VerificationStatus.Pending } })).toBe(false);
  });
});
