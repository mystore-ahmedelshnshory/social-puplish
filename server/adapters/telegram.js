import { isMock, simulateCall } from './index.js';
import { getPlatform } from '../platforms.js';

const API = 'https://api.telegram.org';
const spec = getPlatform('telegram');

/**
 * Telegram — the reference adapter and the easiest platform in the set.
 * No OAuth, no review, no verification. A bot token from @BotFather is enough.
 *
 * The bot must be an ADMINISTRATOR of the target channel/group. `chat_id`
 * is the numeric id, or @channelusername for public channels.
 */
export const telegram = {
  platformId: 'telegram',

  describeCredentials() {
    return [
      { key: 'botToken', label: 'Bot token', hint: 'From @BotFather — looks like 123456789:AAHdq...', required: true },
      { key: 'chatId', label: 'Chat / channel id', hint: 'Numeric id, or @yourchannel for a public channel', required: true },
    ];
  },

  isConfigured(creds = {}) {
    const missing = [];
    if (!creds.botToken) missing.push('botToken');
    if (!creds.chatId) missing.push('chatId');
    return { ready: missing.length === 0, missing };
  },

  async publish({ post, account, creds }) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return simulateCall('telegram');
    }

    const caption = (post.text || '').slice(0, spec.limits.captionChars);
    const allMedia = (post.media || []).filter((m) => m.url).slice(0, spec.limits.carouselMax);
    const media = allMedia[0];

    try {
      // Album: 2-10 items arrive as ONE grouped message. The caption lives on
      // the first item — Telegram renders it as the album caption.
      if (allMedia.length > 1) {
        const body = new FormData();
        body.set('chat_id', creds.chatId);
        body.set(
          'media',
          JSON.stringify(
            allMedia.map((m, i) => ({
              type: m.type === 'video' ? 'video' : 'photo',
              media: m.url,
              ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
            })),
          ),
        );
        const res = await fetch(`${API}/bot${creds.botToken}/sendMediaGroup`, { method: 'POST', body });
        const json = await res.json();
        if (!json.ok) {
          return { ok: false, error: `Telegram ${json.error_code}: ${json.description}`, retryable: json.error_code === 429 || json.error_code >= 500 };
        }
        return { ok: true, externalId: String(json.result[0]?.message_id), mode: 'live', detail: `Album of ${allMedia.length} sent to ${creds.chatId}` };
      }

      let res;
      if (media?.url) {
        const method = media.type === 'video' ? 'sendVideo' : 'sendPhoto';
        const field = media.type === 'video' ? 'video' : 'photo';
        const body = new FormData();
        body.set('chat_id', creds.chatId);
        body.set(field, media.url);
        if (caption) body.set('caption', caption);
        body.set('parse_mode', 'HTML');
        res = await fetch(`${API}/bot${creds.botToken}/${method}`, { method: 'POST', body });
      } else {
        res = await fetch(`${API}/bot${creds.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: creds.chatId, text: caption || '(empty)', parse_mode: 'HTML' }),
        });
      }

      const json = await res.json();
      if (!json.ok) {
        const retryable = json.error_code === 429 || json.error_code >= 500;
        return { ok: false, error: `Telegram ${json.error_code}: ${json.description}`, retryable };
      }
      return {
        ok: true,
        externalId: String(json.result.message_id),
        mode: 'live',
        detail: `Posted to ${creds.chatId}`,
      };
    } catch (err) {
      return { ok: false, error: err.message, retryable: true };
    }
  },

  connectUrl() {
    return null; // no OAuth — credentials are pasted directly
  },

  /** Live credential check: getMe is free, instant and needs no permissions. */
  async test(creds) {
    if (isMock()) return { ok: true, mode: 'mock', detail: 'Simulation mode: these credentials were NOT checked against the real platform. Turn simulation off in Admin to run the live check.' };
    if (!this.isConfigured(creds).ready) return { ok: false, error: 'Bot token and chat id are both required.' };
    try {
      const r = await fetch(`${API}/bot${creds.botToken}/getMe`).then((x) => x.json());
      if (!r.ok) return { ok: false, error: `Telegram said: ${r.description}` };
      return { ok: true, detail: `Bot @${r.result.username} is valid. Remember: it must be an admin of the target chat/channel.` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },


  /**
   * The Telegram Bot API exposes NO per-message analytics — bots cannot read
   * views or reactions (only account-level getChatMemberCount). stats.js
   * surfaces the platform note instead of pretending otherwise.
   */
  async fetchStats() {
    return { supported: false, metrics: {} };
  },
};
