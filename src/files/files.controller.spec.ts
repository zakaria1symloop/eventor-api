import { frameAncestors } from './files.controller.js';

describe('frameAncestors', () => {
  it('uses the dashboard URL when CORS allows every origin', () => {
    expect(frameAncestors({ CORS_ORIGINS: '*', ADMIN_URL: 'http://localhost:3001/' })).toBe("'self' http://localhost:3001");
  });

  it('uses the CORS allowlist as origins, ignoring invalid entries and duplicates', () => {
    expect(frameAncestors({ CORS_ORIGINS: 'https://admin.eventor.dz, https://admin.eventor.dz/, nope', ADMIN_URL: 'http://x' })).toBe("'self' https://admin.eventor.dz");
  });
});
