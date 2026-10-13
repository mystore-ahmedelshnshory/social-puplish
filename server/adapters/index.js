/**
 * The adapter contract.
 *
 * Every platform implements this ONE interface. The core of the app
 * (compose -> validate -> schedule -> queue -> publish -> retry) never
 * mentions a specific network. Adding platform #7 is a new file in this
 * folder plus one entry in the registry below — nothing else changes.
 *
 *   describeCredentials() -> [{ key, label, hint, required }]
 *   isConfigured(creds)   -> { ready, missing[] }
 *   publish({ post, account, creds, scene })
 *                         -> { ok, externalId, mode, detail, error?, retryable? }
 *   connectUrl(state)     -> { url } | null      (OAuth platforms)
 *   exchangeCode(code)    -> { tokens, handle, displayName } | null
 */

import { isMock } from '../settings.js';
import { telegram } from './telegram.js';
import { facebookPage } from './facebook-page.js';
import { instagram } from './instagram.js';
import { linkedin } from './linkedin.js';
import { youtube } from './youtube.js';
import { tiktok } from './tiktok.js';

export const ADAPTERS = {
  telegram: telegram,
  facebook_page: facebookPage,
  instagram: instagram,
  linkedin: linkedin,
  youtube: youtube,
  tiktok: tiktok,
};

export const getAdapter = (platformId) => ADAPTERS[platformId] || null;

/**
 * MOCK_MODE lets the entire app run end-to-end with zero API keys — every
 * adapter simulates a real publish (including the occasional transient
 * failure, so the retry/backoff path is genuinely exercised).
 *
 * Set MOCK_MODE=0 and supply real credentials to publish for real.
 */
export { isMock };

let mockCounter = 0;

/** Simulated network call: latency + a ~12% transient failure rate. */
// MOCK_FAIL_RATE=0 makes simulated publishes deterministic for the test suite.
export async function simulateCall(platform, { failRate = Number(process.env.MOCK_FAIL_RATE ?? 0.12), latency = [400, 1400] } = {}) {
  const wait = latency[0] + Math.random() * (latency[1] - latency[0]);
  await new Promise((r) => setTimeout(r, wait));
  mockCounter += 1;

  if (Math.random() < failRate) {
    const reasons = [
      'rate_limit_exceeded (429) — backing off',
      'upstream 503 Service Unavailable',
      'socket hang up during media transfer',
      'access_token_expired (401) — refresh required',
    ];
    const err = new Error(reasons[Math.floor(Math.random() * reasons.length)]);
    err.retryable = true;
    throw err;
  }

  return {
    ok: true,
    externalId: `mock_${platform}_${Date.now().toString(36)}_${mockCounter}`,
    mode: 'mock',
    detail: `Simulated publish (attempt succeeded after ${Math.round(wait)}ms). No API credentials are configured — set MOCK_MODE=0 and add real keys to publish for real.`,
  };
}
