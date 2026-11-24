import { describe, expect, it } from 'vitest';
import { assetLinks, normaliseFingerprints } from './well-known.js';

const RELEASE = '80:74:C0:3F:BA:FC:B0:1C:DD:8F:ED:7D:80:B2:24:1F:27:BB:04:F7:C1:28:A3:43:6C:DD:C5:EE:70:F4:49:A3';
const PLAY = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

describe('assetlinks.json (BUG-C3)', () => {
  it('lists every valid fingerprint, upper-cased, and drops malformed ones', () => {
    expect(normaliseFingerprints(` ${RELEASE.toLowerCase()} , ${PLAY}, not-a-key`)).toEqual([RELEASE, PLAY]);
  });

  it('is an empty list without a package or a valid key (Android then simply opens the browser)', () => {
    expect(assetLinks({ ANDROID_APP_PACKAGE: 'com.symloop.eventor', ANDROID_CERT_SHA256: 'x' })).toEqual([]);
    expect(assetLinks({ ANDROID_APP_PACKAGE: '', ANDROID_CERT_SHA256: RELEASE })).toEqual([]);
    expect(assetLinks({ ANDROID_APP_PACKAGE: 'com.symloop.eventor', ANDROID_CERT_SHA256: `${RELEASE},${PLAY}` })).toEqual([
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.symloop.eventor', sha256_cert_fingerprints: [RELEASE, PLAY] } },
    ]);
  });
});
