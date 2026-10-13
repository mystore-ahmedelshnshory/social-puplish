/**
 * Credentials that survive a restart of an ephemeral host.
 *
 * Free container hosts (Hugging Face Spaces, Render, …) reset the filesystem
 * — and therefore the SQLite database — whenever the container restarts or is
 * rebuilt. Real OAuth credentials therefore would disappear with it.
 *
 * This module lets a deployment keep the few values that must outlive a
 * restart in host-level environment variables ("Secrets" in the HF UI), and
 * re-inserts them into the accounts table on every boot. The host stores the
 * secrets privately; the app just reads them.
 *
 * Recognised variables:
 *   SEED_TELEGRAM_BOT_TOKEN + SEED_TELEGRAM_CHAT_ID   — the 2-minute path
 *   SEED_ACCOUNTS_JSON — a JSON array for the other platforms, each entry:
 *       { "platform": "facebook_page", "handle": "<page id>",
 *         "displayName": "My Page", "tokens": { …same keys as the UI… } }
 *
 * Seeding is additive: it never deletes accounts you added through the UI, and
 * it updates only the accounts whose handle matches.
 */
import { db } from './db.js';

const upsert = db.prepare(`
  INSERT INTO accounts (platform, handle, display_name, kind, tokens)
  VALUES (?, ?, ?, 'env', ?)
  ON CONFLICT(platform, handle) DO UPDATE SET
    display_name = excluded.display_name,
    tokens       = excluded.tokens,
    status       = 'connected'
`);

export function seedAccountsFromEnv(env = process.env) {
  const seeded = [];

  const botToken = (env.SEED_TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.SEED_TELEGRAM_CHAT_ID || '').trim();
  if (botToken && chatId) {
    upsert.run(
      'telegram',
      chatId,
      `Telegram ${chatId}`,
      JSON.stringify({ botToken, chatId }),
    );
    seeded.push(`telegram → ${chatId}`);
  } else if (botToken || chatId) {
    console.warn(
      '[seed] Telegram needs BOTH SEED_TELEGRAM_BOT_TOKEN and SEED_TELEGRAM_CHAT_ID — ' +
      'only one was provided, nothing was seeded.',
    );
  }

  if (env.SEED_ACCOUNTS_JSON) {
    try {
      const list = JSON.parse(env.SEED_ACCOUNTS_JSON);
      if (!Array.isArray(list)) throw new Error('must be a JSON array');
      for (const a of list) {
        if (!a?.platform || !a?.handle) throw new Error('every entry needs platform + handle');
        upsert.run(
          a.platform,
          String(a.handle),
          a.displayName || String(a.handle),
          JSON.stringify(a.tokens || {}),
        );
        seeded.push(`${a.platform} → ${a.handle}`);
      }
    } catch (e) {
      console.warn('[seed] SEED_ACCOUNTS_JSON ignored:', e.message);
    }
  }

  return seeded;
}
