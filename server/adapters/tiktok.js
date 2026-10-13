import { isMock, simulateCall } from './index.js';
import { getPlatform } from '../platforms.js';
import { redirectUri } from '../settings.js';

const API = 'https://open.tiktokapis.com';
const spec = getPlatform('tiktok');

/**
 * TikTok — the strictest gate in the whole set.
 *
 * THE WALL: until your client passes TikTok's compliance audit, EVERY Direct
 * Post is restricted to SELF_ONLY privacy no matter what privacy_level you
 * request, and only 5 users may publish through the client per 24h. Public
 * attempts return `unaudited_client_can_only_post_to_private_accounts`.
 * TikTok publishes no audit turnaround — you are planning a launch around an
 * approval you do not control.
 *
 * THE WAY THROUGH: DRAFT mode (post_mode: MEDIA_UPLOAD) sends the video to the
 * creator's TikTok inbox as a draft and is EXEMPT from the private-only
 * restriction. No audit needed. The trade-off: the creator taps publish in the
 * app. This adapter defaults to draft mode and only attempts DIRECT_POST when
 * you explicitly say the client is audited.
 *
 * OTHER RULES:
 *   - Two approvals stack: the app must hold video.publish AND the creator must
 *     authorise it. Neither alone is enough.
 *   - Access tokens last 24 HOURS. Build the refresh loop before you need it.
 *   - Videos: FILE_UPLOAD or PULL_FROM_URL. Photos: PULL_FROM_URL ONLY.
 *   - PULL_FROM_URL requires verified ownership of the URL prefix or domain.
 *   - Rate limits: 6 init requests/min, 30 status fetches/min, per user token.
 *   - Per-creator daily cap is typically ~15 posts, SHARED across all API
 *     clients — other tools you use eat the same budget.
 *   - The audit checks UX details: you must render current creator_info, offer
 *     title/privacy/interaction settings with NO defaults, show the music and
 *     branded-content policy links, and get express consent with a content
 *     preview before upload.
 */
export const tiktok = {
  platformId: 'tiktok',

  describeCredentials() {
    return [
      { key: 'accessToken', label: 'Access token', hint: 'Scope video.publish — expires in 24 hours', required: true },
      { key: 'refreshToken', label: 'Refresh token', hint: '', required: false },
      { key: 'clientKey', label: 'Client key', hint: '', required: false },
      { key: 'clientSecret', label: 'Client secret', hint: '', required: false },
      { key: 'audited', label: 'Client passed TikTok\u2019s audit?', hint: 'true/false — if false, DIRECT_POST is forced private, so we use DRAFT mode', required: false },
    ];
  },

  isConfigured(creds = {}) {
    const missing = [];
    if (!creds.accessToken) missing.push('accessToken');
    return { ready: missing.length === 0, missing };
  },

  async publish({ post, account, creds }) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return simulateCall('tiktok', { latency: [900, 2400] });
    }

    const audited = creds.audited === true || creds.audited === 'true';
    const media = (post.media || [])[0];
    if (!media) {
      return { ok: false, error: 'TikTok needs a video (or photo carousel).', retryable: false };
    }

    const mode = audited ? 'DIRECT_POST' : 'MEDIA_UPLOAD';

    try {
      // Ask the creator's account what it actually allows, and respect it.
      const infoRes = await fetch(`${API}/v2/post/publish/creator_info/query/`, {
        method: 'POST',
        headers: authHeaders(creds.accessToken),
      }).then((r) => r.json());

      if (infoRes.error?.code !== 'ok') {
        return { ok: false, error: `TikTok creator_info: ${infoRes.error?.message || 'failed'}`, retryable: true };
      }

      const privacy = audited ? (infoRes.data?.privacy_level_options?.[0] ?? 'PUBLIC_TO_EVERYONE') : 'SELF_ONLY';

      const allImages = (post.media || []).filter((m) => m.type === 'image' && m.url).slice(0, spec.limits.carouselMax);

      // Photo post (carousel): multiple PULL_FROM_URL images in one init call.
      // NOTE: TikTok requires verified ownership of the URL prefix/domain for
      // every pulled URL — that is a portal setting, not a code setting.
      if (allImages.length > 1) {
        const photoBody = {
          post_mode: mode,
          post_info: {
            title: (post.text || '').slice(0, spec.limits.captionChars),
            privacy_level: privacy,
            disable_comment: false,
          },
          source_info: {
            source: 'PULL_FROM_URL',
            photo_images: allImages.map((m) => m.url),
            photo_cover_index: 0,
          },
        };
        const photoRes = await fetch(`${API}/v2/post/publish/content/init/`, {
          method: 'POST',
          headers: { ...authHeaders(creds.accessToken), 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(photoBody),
        }).then((r) => r.json());
        if (photoRes.error?.code !== 'ok') {
          return { ok: false, error: `TikTok photo init [${photoRes.error?.code}]: ${photoRes.error?.message}`, retryable: photoRes.error?.code === 'rate_limit_exceeded' };
        }
        return pollTiktokStatus(photoRes.data?.publish_id, creds, audited, `photo carousel of ${allImages.length}`);
      }

      const initBody = {
        post_info: {
          title: (post.text || '').slice(0, spec.limits.captionChars),
          privacy_level: privacy,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: media.url ? 'PULL_FROM_URL' : 'FILE_UPLOAD',
          video_size: media.bytes || 0,
          chunk_size: media.bytes || 0,
          total_chunk_count: 1,
          ...(media.url ? { video_url: media.url } : {}),
        },
      };

      const initRes = await fetch(
        `${API}/v2/post/publish/${media.type === 'image' ? 'content' : 'video'}/init/`,
        {
          method: 'POST',
          headers: { ...authHeaders(creds.accessToken), 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ post_mode: mode, ...initBody }),
        },
      ).then((r) => r.json());

      if (initRes.error?.code !== 'ok') {
        const code = initRes.error?.code;
        // These are hard stops, not transient failures. Retrying just burns the
        // 6-init-per-minute budget.
        const retryable = code === 'rate_limit_exceeded' || code === 'internal';
        return { ok: false, error: `TikTok init [${code}]: ${initRes.error?.message}`, retryable };
      }

      const publishId = initRes.data?.publish_id;

      if (mode === 'FILE_UPLOAD' && initRes.data?.upload_url && media.path) {
        const fs = await import('node:fs');
        await fetch(initRes.data.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${(media.bytes || 1) - 1}/${media.bytes || 1}` },
          body: fs.readFileSync(media.path),
        });
      }

      return pollTiktokStatus(publishId, creds, audited, audited ? `video (${privacy})` : 'video');
    } catch (err) {
      return { ok: false, error: err.message, retryable: true };
    }
  },

  connectUrl(state) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) return null;
    const redirect = encodeURIComponent(redirectUri('tiktok', 'TIKTOK_REDIRECT_URI'));
    return {
      // NOTE: add ,video.list here once the Display API product is enabled in
      // your TikTok app — TikTok rejects authorize requests for scopes the app
      // hasn't declared, so this stays conservative until you enable it.
      url: `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=video.publish,user.info.basic&response_type=code&redirect_uri=${redirect}&state=${state}`,
    };
  },

  /** Trade the browser-flow code for an access token (24h) + refresh token. */
  async exchangeCode(code) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const secret = process.env.TIKTOK_CLIENT_SECRET;
    const redirect = redirectUri('tiktok', 'TIKTOK_REDIRECT_URI');
    if (!clientKey || !secret) throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set');

    const tok = await fetch(`${API}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey, client_secret: secret, code,
        grant_type: 'authorization_code', redirect_uri: redirect,
      }),
    }).then((r) => r.json());
    if (!tok.access_token) {
      throw new Error(tok.error_description || tok.error || 'TikTok returned no access token');
    }

    const info = await fetch(`${API}/v2/user/info/?fields=display_name,username`, {
      headers: authHeaders(tok.access_token),
    }).then((r) => r.json());
    const u = info?.data?.user;

    return {
      tokens: JSON.stringify({
        accessToken: tok.access_token, refreshToken: tok.refresh_token,
        clientKey, clientSecret: secret,
      }),
      handle: u?.username || tok.open_id || 'tiktok-account',
      displayName: u?.display_name || u?.username || 'TikTok account',
    };
  },

  /** Verify the token and report exactly what this client may publish. */
  async test(creds) {
    if (isMock()) return { ok: true, mode: 'mock', detail: 'Simulation mode: these credentials were NOT checked against the real platform. Turn simulation off in Admin to run the live check.' };
    if (!this.isConfigured(creds).ready) return { ok: false, error: 'Access token is required.' };
    try {
      const r = await fetch(`${API}/v2/post/publish/creator_info/query/`, {
        method: 'POST',
        headers: { ...authHeaders(creds.accessToken), 'Content-Type': 'application/json; charset=UTF-8' },
      }).then((x) => x.json());
      if (r.error?.code !== 'ok') return { ok: false, error: `TikTok [${r.error?.code}]: ${r.error?.message}` };
      const audited = creds.audited === true || creds.audited === 'true';
      return {
        ok: true,
        detail: audited
          ? `Token valid. Client is audited — DIRECT_POST available with privacy levels: ${(r.data?.privacy_level_options || []).join(', ')}.`
          : `Token valid. Client NOT audited: direct posts are forced private, so Amplify will publish as DRAFTS to the inbox (that path is exempt).`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },


  /**
   * Stats via the DISPLAY API (scope video.list, POST /v2/video/query/) — a
   * separate TikTok product from the Content Posting audit. Our externalId
   * is the publish_id, so resolve the public video id through status/fetch
   * first. Caveats: unaudited clients post privately (nothing to report
   * until the user taps Post from the inbox), and video/query covers videos —
   * photo posts may return nothing.
   */
  async fetchStats(publishId, creds) {
    if (isMock() || !creds.accessToken) {
      return { supported: false, metrics: {}, note: 'Connect TikTok and turn simulation off for real stats.' };
    }
    const H = { ...authHeaders(creds.accessToken), 'Content-Type': 'application/json; charset=UTF-8' };
    try {
      const st = await fetch(`${API}/v2/post/publish/status/fetch/`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ publish_id: publishId }),
      }).then((r) => r.json());
      const videoId = st.data?.publicaly_available_video_id?.[0];
      if (!videoId) {
        return { supported: false, metrics: {}, error: `No public video id yet (publish status: ${st.data?.status || 'unknown'}). Drafts and private posts report no stats.` };
      }
      const q = await fetch(`${API}/v2/video/query/?fields=id,title,like_count,comment_count,share_count,view_count,share_url`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ filters: { video_id: [String(videoId)] }, max_count: 1 }),
      }).then((r) => r.json());
      if (q.error?.code && q.error.code !== 'ok') {
        return { supported: false, metrics: {}, error: `TikTok ${q.error.code}: ${q.error.message}. Stats need the Display API (scope video.list) enabled on your client.` };
      }
      const v = q.data?.videos?.[0];
      if (!v) return { supported: false, metrics: {}, error: 'TikTok returned no video — video/query does not cover photo posts.' };
      return {
        supported: true,
        metrics: {
          views: v.view_count ?? null,
          likes: v.like_count ?? null,
          comments: v.comment_count ?? null,
          shares: v.share_count ?? null,
          url: v.share_url || null,
        },
      };
    } catch (err) {
      return { supported: false, metrics: {}, error: err.message };
    }
  },
};

/** Poll: only PUBLISH_COMPLETE is success. 30 status fetches/min is the cap. */
async function pollTiktokStatus(publishId, creds, audited, what) {
  for (let i = 0; i < 40; i++) {
    const st = await fetch(`${API}/v2/post/publish/status/fetch/`, {
      method: 'POST',
      headers: { ...authHeaders(creds.accessToken), 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
    }).then((r) => r.json());

    const status = st.data?.status;
    if (status === 'PUBLISH_COMPLETE') {
      return {
        ok: true,
        externalId: publishId,
        mode: audited ? 'live' : 'draft',
        detail: audited
          ? `Published ${what} to TikTok.`
          : `Sent ${what} to your TikTok inbox as a DRAFT. Open the app and tap Post. Draft mode needs no audit; Direct Post stays private-only until your client passes TikTok\u2019s compliance audit.`,
      };
    }
    if (status === 'FAILED') {
      return { ok: false, error: `TikTok publish failed: ${st.data?.fail_reason}`, retryable: false };
    }
    if (st.error?.code === 'spam_risk_too_many_posts') {
      return { ok: false, error: 'Creator hit the daily unpublished-post cap. Wait 24 hours.', retryable: false };
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return { ok: false, error: 'TikTok publish timed out while polling status.', retryable: true };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}
