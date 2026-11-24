/**
 * BUG-C3: Android App Links. Android checks
 * `https://<host>/.well-known/assetlinks.json` (200, `application/json`, no
 * redirect) before it lets the Eventor app open links of that host, such as the
 * emailed `/set-password?token=…`. nginx sends exactly that path of the dashboard
 * host to the API (deploy/nginx/eventor.conf).
 */
export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';

/** `AB:cd:…` → `AB:CD:…`; anything that is not 32 colon-separated hex bytes is dropped. */
export function normaliseFingerprints(value: string): string[] {
  return value
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));
}

export function assetLinks(env: { ANDROID_APP_PACKAGE: string; ANDROID_CERT_SHA256: string }): unknown[] {
  const fingerprints = normaliseFingerprints(env.ANDROID_CERT_SHA256);
  if (!env.ANDROID_APP_PACKAGE || fingerprints.length === 0) return [];
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: env.ANDROID_APP_PACKAGE, sha256_cert_fingerprints: fingerprints },
    },
  ];
}
