/**
 * Seeds demo accounts so the app is explorable the moment it starts.
 *
 * These have NO credentials, which is exactly the point: every adapter falls
 * back to MOCK_MODE and simulates a real publish (including occasional
 * transient failures, so you can watch the retry/backoff path work).
 *
 * Add real credentials through the Accounts tab and set MOCK_MODE=0 to go live.
 */
import { db } from './db.js';

const DEMO = [
  { platform: 'telegram', handle: '@amplify_demo', displayName: 'Demo Channel', kind: 'channel' },
  { platform: 'facebook_page', handle: '100000000000001', displayName: 'My Business Page', kind: 'page' },
  { platform: 'instagram', handle: 'my.brand.ig', displayName: 'My Brand (Business)', kind: 'business' },
  { platform: 'linkedin', handle: 'urn:li:person:demo', displayName: 'My LinkedIn Profile', kind: 'profile' },
  { platform: 'youtube', handle: 'UCdemoChannelId', displayName: 'My Channel', kind: 'channel' },
  { platform: 'tiktok', handle: '@my.brand.tiktok', displayName: 'My Brand TikTok', kind: 'profile' },
];

export function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  if (count > 0) return 0;

  const ins = db.prepare(
    `INSERT OR IGNORE INTO accounts (platform, handle, display_name, kind, tokens) VALUES (?, ?, ?, ?, '{}')`,
  );
  const tx = db.transaction(() => DEMO.forEach((a) => ins.run(a.platform, a.handle, a.displayName, a.kind)));
  tx();
  console.log(`[seed] created ${DEMO.length} demo accounts (mock mode)`);
  return DEMO.length;
}
