import { db } from './db.js';

/**
 * Runtime settings, editable from the Admin tab without a restart.
 *
 * Env vars provide the defaults; anything changed in the UI is stored in
 * SQLite and wins from then on. This is what lets you flip simulation mode
 * off the moment your first real credentials are in place.
 */

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

const cache = new Map();
for (const row of db.prepare('SELECT key, value FROM settings').all()) cache.set(row.key, row.value);

export function getSetting(key, dflt = null) {
  if (cache.has(key)) return cache.get(key);
  return dflt;
}

export function setSetting(key, value) {
  cache.set(key, value);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Simulation mode: publishes are faked (including transient failures). */
export const isMock = () =>
  getSetting('mock_mode', process.env.MOCK_MODE !== '0' ? '1' : '0') === '1';

/** Base URL the outside world uses to reach this server. Instagram and TikTok
 *  fetch media from a PUBLIC url themselves, so localhost will not do in live mode. */
export const publicBaseUrl = () =>
  getSetting('public_base_url', process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

/** OAuth callback URL for a platform: explicit env override wins, then the
 *  live PUBLIC_BASE_URL, then localhost for dev. Adapters call this so a
 *  deployed instance never hands providers a localhost redirect it can't use. */
export function redirectUri(platform, envKey) {
  const override = envKey ? process.env[envKey] : '';
  if (override) return override;
  const base = publicBaseUrl();
  if (base) return `${base}/api/oauth/${platform}/callback`;
  return `http://localhost:${process.env.PORT || 4321}/api/oauth/${platform}/callback`;
}

