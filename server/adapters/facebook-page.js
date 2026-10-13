import { isMock, simulateCall } from './index.js';
import { getPlatform } from '../platforms.js';
import { redirectUri } from '../settings.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const spec = getPlatform('facebook_page');

/**
 * Facebook Pages — fully supported and untouched by the Groups API removal.
 *
 * Personal use shortcut: Meta "Standard Access" for pages_manage_posts and
 * pages_read_engagement works immediately for anyone holding an admin,
 * developer or tester role on the app. No App Review, no Business Verification.
 * Those are only required for Advanced Access — i.e. Pages you do not own.
 *
 * Publishing to Groups or personal profiles/timelines is impossible: Meta
 * removed publish_to_groups across ALL API versions on 22 April 2024, and
 * publish_actions died in 2018.
 */
export const facebookPage = {
  platformId: 'facebook_page',

  describeCredentials() {
    return [
      { key: 'pageId', label: 'Page ID', hint: 'From your Page\u2019s About tab, or /me/accounts', required: true },
      { key: 'pageAccessToken', label: 'Page access token', hint: 'Long-lived page token with pages_manage_posts', required: true },
      { key: 'appId', label: 'App ID', hint: 'Your Meta app id', required: false },
      { key: 'appSecret', label: 'App secret', hint: 'Only needed for the full OAuth flow', required: false },
    ];
  },

  isConfigured(creds = {}) {
    const missing = [];
    if (!creds.pageId) missing.push('pageId');
    if (!creds.pageAccessToken) missing.push('pageAccessToken');
    return { ready: missing.length === 0, missing };
  },

  async publish({ post, account, creds }) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return simulateCall('facebook_page');
    }

    const message = (post.text || '').slice(0, spec.limits.captionChars);
    const allMedia = (post.media || []).filter((m) => m.url);
    const media = allMedia[0];

    try {
      // Multi-photo feed post: upload each photo UNPUBLISHED, then attach them
      // to one feed post. This is the only supported multi-image path.
      const images = allMedia.filter((m) => m.type === 'image').slice(0, spec.limits.carouselMax);
      if (images.length > 1) {
        const fbids = [];
        for (const m of images) {
          const r = await fetch(`${GRAPH}/${creds.pageId}/photos`, {
            method: 'POST',
            body: new URLSearchParams({ access_token: creds.pageAccessToken, url: m.url, published: 'false' }),
          }).then((x) => x.json());
          if (r.error) return { ok: false, error: `Facebook photo upload #${r.error.code}: ${r.error.message}`, retryable: r.error.code === 1 };
          fbids.push(r.id);
        }
        const feed = new URLSearchParams({ access_token: creds.pageAccessToken });
        if (message) feed.set('message', message);
        feed.set('attached_media', JSON.stringify(fbids.map((id) => ({ media_fbid: id }))));
        const res = await fetch(`${GRAPH}/${creds.pageId}/feed`, { method: 'POST', body: feed }).then((x) => x.json());
        if (res.error) return { ok: false, error: `Facebook #${res.error.code}: ${res.error.message}`, retryable: false };
        return { ok: true, externalId: res.id, mode: 'live', detail: `Album of ${fbids.length} photos published to Page ${creds.pageId}` };
      }

      const params = new URLSearchParams({ access_token: creds.pageAccessToken });
      let endpoint = `/${creds.pageId}/feed`;

      if (media?.type === 'image' && media.url) {
        endpoint = `/${creds.pageId}/photos`;
        params.set('url', media.url);
        if (message) params.set('caption', message);
      } else if (media?.type === 'video' && media.url) {
        endpoint = `/${creds.pageId}/videos`;
        params.set('file_url', media.url);
        if (message) params.set('description', message);
      } else if (message) {
        params.set('message', message);
      } else {
        return { ok: false, error: 'Nothing to publish — Facebook needs a message or media.' };
      }

      const res = await fetch(`${GRAPH}${endpoint}`, { method: 'POST', body: params });
      const json = await res.json();

      if (json.error) {
        // code 190 = token problem, 10/200 = permission problem. Neither is worth retrying.
        const retryable = json.error.code === 1 || json.error.code === 2 || json.error.error_subcode === 459;
        return { ok: false, error: `Facebook #${json.error.code}: ${json.error.message}`, retryable };
      }
      return { ok: true, externalId: json.post_id || json.id, mode: 'live', detail: `Published to Page ${creds.pageId}` };
    } catch (err) {
      return { ok: false, error: err.message, retryable: true };
    }
  },

  connectUrl(state) {
    const appId = process.env.FACEBOOK_APP_ID;
    if (!appId) return null;
    const redirect = encodeURIComponent(redirectUri('facebook_page', 'FACEBOOK_REDIRECT_URI'));
    // read_insights + instagram_manage_insights ride along so the SAME token can
    // also power the Stats tab later (Graph answer to a metric you may not read
    // is an error, so the stats code degrades gracefully when these are absent).
    const scope = [
      'pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
      'read_insights', 'instagram_basic', 'instagram_manage_insights',
    ].join(',');
    return {
      url: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&state=${state}&scope=${scope}`,
    };
  },

  async exchangeCode(code) {
    const appId = process.env.FACEBOOK_APP_ID;
    const secret = process.env.FACEBOOK_APP_SECRET;
    const redirect = redirectUri('facebook_page', 'FACEBOOK_REDIRECT_URI');
    if (!appId || !secret) throw new Error('FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are not set');

    const tokenRes = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&client_secret=${secret}&code=${code}`,
    ).then((r) => r.json());
    if (tokenRes.error) throw new Error(tokenRes.error.message);

    // Exchange for a long-lived token, then list the Pages it administers.
    const longRes = await fetch(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${secret}&fb_exchange_token=${tokenRes.access_token}`,
    ).then((r) => r.json());
    const userToken = longRes.access_token || tokenRes.access_token;

    const accounts = await fetch(`${GRAPH}/me/accounts?access_token=${userToken}`).then((r) => r.json());
    const first = accounts?.data?.[0];
    if (!first) throw new Error('This token does not administer any Facebook Page.');

    return {
      tokens: JSON.stringify({ userToken, pageToken: first.access_token, pageId: first.id }),
      handle: first.id,
      displayName: first.name,
      // One button connects EVERY page the token administers — the original
      // idea was "my pages", plural.
      extra: (accounts.data || []).slice(1).map((pg) => ({
        handle: pg.id,
        displayName: pg.name,
        tokens: JSON.stringify({ userToken, pageToken: pg.access_token, pageId: pg.id }),
      })),
    };
  },

  /** Verify the page token can see the page and holds the publish permission. */
  async test(creds) {
    if (isMock()) return { ok: true, mode: 'mock', detail: 'Simulation mode: these credentials were NOT checked against the real platform. Turn simulation off in Admin to run the live check.' };
    if (!this.isConfigured(creds).ready) return { ok: false, error: 'Page id and page access token are required.' };
    try {
      const r = await fetch(
        `${GRAPH}/${creds.pageId}?fields=name,access_token&access_token=${creds.pageAccessToken}`,
      ).then((x) => x.json());
      if (r.error) return { ok: false, error: `Facebook #${r.error.code}: ${r.error.message}` };
      const perms = await fetch(
        `${GRAPH}/${creds.pageId}?fields=perms&access_token=${creds.pageAccessToken}`,
      ).then((x) => x.json());
      const has = (perms?.perms?.data || []).some((p) => p.permission === 'pages_manage_posts' && p.status === 'granted');
      return {
        ok: true,
        detail: `Token works for Page "${r.name}".${has ? ' pages_manage_posts granted.' : ' WARNING: pages_manage_posts NOT granted — publishing will fail.'}`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },


  /**
   * Post engagement. Meta deprecated `post_impressions` (15 Nov 2025) and
   * `post_impressions_unique` (15 Jun 2026) — modern metrics are
   * `post_media_view` (views) and `post_total_media_view_unique` (reach).
   * Requesting a dead metric fails the WHOLE insights call, so try the modern
   * pair first, then a safe subset. Node fields (reactions/comments/shares)
   * are stable and fetched first so a missing read_insights grant still
   * yields engagement counts.
   */
  async fetchStats(postId, creds) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return { supported: false, metrics: {}, note: 'Configure Page credentials and turn simulation off for real stats.' };
    }
    try {
      const node = await fetch(
        `${GRAPH}/${postId}?fields=reactions.summary(true).limit(0),comments.summary(true).limit(0),shares,permalink_url&access_token=${creds.pageAccessToken}`,
      ).then((r) => r.json());
      if (node.error) return { supported: false, metrics: {}, error: `Facebook #${node.error.code}: ${node.error.message}` };

      const metrics = {
        views: null,
        reach: null,
        likes: node.reactions?.summary?.total_count ?? null,
        comments: node.comments?.summary?.total_count ?? null,
        shares: node.shares?.count ?? null,
        url: node.permalink_url || null,
      };

      for (const metricSet of ['post_media_view,post_total_media_view_unique', 'post_media_view']) {
        const ins = await fetch(
          `${GRAPH}/${postId}/insights?metric=${metricSet}&access_token=${creds.pageAccessToken}`,
        ).then((r) => r.json());
        if (ins.error) continue; // metric lists keep shifting — degrade, don't fail
        for (const d of ins.data || []) {
          const v = d.values?.at(-1)?.value;
          if (d.name === 'post_media_view' && typeof v === 'number') metrics.views = v;
          if (d.name === 'post_total_media_view_unique' && typeof v === 'number') metrics.reach = v;
        }
        if (metrics.views != null) break;
      }
      return { supported: true, metrics };
    } catch (err) {
      return { supported: false, metrics: {}, error: err.message };
    }
  },
};
