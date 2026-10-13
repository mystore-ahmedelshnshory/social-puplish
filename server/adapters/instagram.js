import { isMock, simulateCall } from './index.js';
import { getPlatform } from '../platforms.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const spec = getPlatform('instagram');

/**
 * Instagram — the strictest publishing rules of any platform here.
 *
 * HARD BLOCKER: personal accounts cannot publish through the API at all.
 * The account must be Business or Creator. There is no exception, no
 * workaround, and no permission that unlocks it.
 *
 * FLOW (two-step container model):
 *   1. POST /{ig-user-id}/media  with image_url/video_url  -> returns a container id
 *   2. GET  /{id}?fields=status_code  until status_code === "FINISHED"
 *   3. POST /{ig-user-id}/media_publish with creation_id={container id}
 *
 * The media URL must be PUBLICLY reachable — Instagram's servers fetch it,
 * not yours. Local file paths will fail with a download error.
 *
 * IMAGES: JPEG only, <= 8 MB, aspect ratio strictly between 4:5 and 1.91:1.
 * LIMIT:  100 API-published posts per rolling 24h (a carousel counts as one).
 *         Read the live ceiling from /{ig-user-id}/content_publishing_limit.
 * NOTES:  No text-only posts. Links in captions render but are not clickable.
 */
export const instagram = {
  platformId: 'instagram',

  describeCredentials() {
    return [
      { key: 'igUserId', label: 'Instagram business account id', hint: 'The ig-user-id of your Business/Creator account', required: true },
      { key: 'accessToken', label: 'Access token', hint: 'Needs instagram_business_content_publish', required: true },
      { key: 'publicMediaBase', label: 'Public media base URL', hint: 'Where rendered posters are reachable from the internet', required: false },
    ];
  },

  isConfigured(creds = {}) {
    const missing = [];
    if (!creds.igUserId) missing.push('igUserId');
    if (!creds.accessToken) missing.push('accessToken');
    return { ready: missing.length === 0, missing };
  },

  async publish({ post, account, creds }) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return simulateCall('instagram', { latency: [700, 2000] });
    }

    const items = (post.media || []).filter((m) => m.url).slice(0, spec.limits.carouselMax);
    if (!items.length) {
      return {
        ok: false,
        error: 'Instagram does not support text-only posts. Attach at least one image or video.',
        retryable: false,
      };
    }

    const caption = (post.text || '').slice(0, spec.limits.captionChars);

    // One container per item, then (for 2+) a CAROUSEL parent container.
    const createContainer = async (params) => {
      params.set('access_token', creds.accessToken);
      const r = await fetch(`${GRAPH}/${creds.igUserId}/media`, { method: 'POST', body: params }).then((x) => x.json());
      if (r.error) throw Object.assign(new Error(`Instagram container: ${r.error.message}`), { retryable: r.error.code === 1 });
      return r.id;
    };
    const pollContainer = async (id) => {
      for (let i = 0; i < 30; i++) {
        const st = await fetch(`${GRAPH}/${id}?fields=status_code&access_token=${creds.accessToken}`).then((x) => x.json());
        if (st.status_code === 'FINISHED') return;
        if (st.status_code === 'ERROR') throw Object.assign(new Error('Instagram rejected a media container (format, size or aspect ratio).'), { retryable: false });
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw Object.assign(new Error('Instagram container processing timed out.'), { retryable: true });
    };

    try {
      let publishableId;

      if (items.length > 1) {
        const children = [];
        for (const m of items) {
          const params = new URLSearchParams({ is_carousel_item: 'true' });
          params.set(m.type === 'video' ? 'video_url' : 'image_url', m.url);
          const id = await createContainer(params);
          await pollContainer(id);
          children.push(id);
        }
        const parent = new URLSearchParams({ media_type: 'CAROUSEL', children: children.join(',') });
        if (caption) parent.set('caption', caption);
        publishableId = await createContainer(parent);
      } else {
        const m = items[0];
        const params = new URLSearchParams();
        params.set(m.type === 'video' ? 'video_url' : 'image_url', m.url);
        if (caption) params.set('caption', caption);
        if (m.type === 'video' && m.isReel) params.set('media_type', 'REELS');
        publishableId = await createContainer(params);
      }

      await pollContainer(publishableId);

      const publishRes = await fetch(`${GRAPH}/${creds.igUserId}/media_publish`, {
        method: 'POST',
        body: new URLSearchParams({ creation_id: publishableId, access_token: creds.accessToken }),
      }).then((r) => r.json());

      if (publishRes.error) {
        const retryable = publishRes.error.code === 1 || publishRes.error.code === 4 || publishRes.error.code === 32;
        return { ok: false, error: `Instagram publish #${publishRes.error.code}: ${publishRes.error.message}`, retryable };
      }
      return {
        ok: true,
        externalId: publishRes.id,
        mode: 'live',
        detail: items.length > 1
          ? `Carousel of ${items.length} published (counts as ONE post against the 100/24h cap).`
          : `Published to Instagram ${creds.igUserId}`,
      };
    } catch (err) {
      return { ok: false, error: err.message, retryable: err.retryable !== false };
    }
  },

  async remainingQuota(creds) {
    if (!this.isConfigured(creds).ready) return null;
    try {
      const r = await fetch(
        `${GRAPH}/${creds.igUserId}/content_publishing_limit?fields=quota_usage,config&access_token=${creds.accessToken}`,
      ).then((x) => x.json());
      const d = r?.data?.[0];
      if (!d) return null;
      return { used: d.quota_usage, total: d.config?.quota_total ?? 100, windowSec: d.config?.quota_duration ?? 86400 };
    } catch {
      return null;
    }
  },

  connectUrl() {
    return null;
  },

  /** Verify the account is professional and the token can read it. */
  async test(creds) {
    if (isMock()) return { ok: true, mode: 'mock', detail: 'Simulation mode: these credentials were NOT checked against the real platform. Turn simulation off in Admin to run the live check.' };
    if (!this.isConfigured(creds).ready) return { ok: false, error: 'Instagram user id and access token are required.' };
    try {
      const r = await fetch(
        `${GRAPH}/${creds.igUserId}?fields=username,account_type,media_count&access_token=${creds.accessToken}`,
      ).then((x) => x.json());
      if (r.error) return { ok: false, error: `Instagram #${r.error.code}: ${r.error.message}` };
      const professional = ['BUSINESS', 'CREATOR'].includes(r.account_type);
      return {
        ok: professional,
        detail: professional
          ? `@${r.username} is a ${r.account_type} account with ${r.media_count} posts — API publishing allowed.`
          : `@${r.username} is a ${r.account_type} account. Personal accounts CANNOT publish through the API — switch it to Business or Creator in Instagram settings.`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },


  /**
   * Media insights. `impressions`/`plays` were deprecated across ALL Graph
   * versions on 21 Apr 2025 (media created ≥ 2 Jul 2024 ERRORS on them —
   * one dead metric kills the whole call), replaced by `views`. `reach`,
   * `likes`, `comments`, `saved`, `total_interactions` survive. Try the
   * modern full set, then a guaranteed subset. Needs the
   * instagram_manage_insights permission on the token.
   */
  async fetchStats(mediaId, creds) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return { supported: false, metrics: {}, note: 'Configure Instagram credentials and turn simulation off for real stats.' };
    }
    let lastErr = null;
    try {
      for (const metricSet of ['views,reach,likes,comments,saved,total_interactions', 'likes,comments,total_interactions']) {
        const r = await fetch(`${GRAPH}/${mediaId}/insights?metric=${metricSet}&access_token=${creds.accessToken}`).then((x) => x.json());
        if (r.error) { lastErr = r.error; continue; }
        const m = Object.fromEntries((r.data || []).map((d) => [d.name, d.values?.at(-1)?.value ?? null]));
        const link = await fetch(`${GRAPH}/${mediaId}?fields=permalink&access_token=${creds.accessToken}`)
          .then((x) => x.json())
          .catch(() => ({}));
        return {
          supported: true,
          metrics: {
            views: m.views ?? null,
            reach: m.reach ?? null,
            likes: m.likes ?? null,
            comments: m.comments ?? null,
            saved: m.saved ?? null,
            url: link.permalink || null,
          },
        };
      }
      return { supported: false, metrics: {}, error: `Instagram insights #${lastErr?.code}: ${lastErr?.message}` };
    } catch (err) {
      return { supported: false, metrics: {}, error: err.message };
    }
  },
};
