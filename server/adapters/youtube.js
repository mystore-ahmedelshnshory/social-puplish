import fs from 'node:fs';
import { isMock, simulateCall } from './index.js';
import { getPlatform } from '../platforms.js';
import { redirectUri } from '../settings.js';

const spec = getPlatform('youtube');

/**
 * YouTube — free in dollars, priced in quota and gated by an audit.
 *
 * THE TRAP: all videos uploaded via videos.insert from an UNVERIFIED API
 * project created after 28 July 2020 are restricted to PRIVATE viewing mode.
 * Sending privacyStatus: "public" does not override this and the call does not
 * fail — the upload succeeds, then the channel owner gets an email saying the
 * video was locked private. Fix: submit the YouTube API Services Audit and
 * Quota Extension Form. Free, but no published turnaround.
 *
 * QUOTA (since 1 June 2026 — three separate buckets, not one):
 *   videos.insert  100 calls/day/project
 *   search.list    100 calls/day/project
 *   everything else 10,000 units/day combined (videos.update = 50, thumbnails.set = 50)
 * Resets at midnight Pacific. Failed calls still burn quota.
 *
 * OTHER CEILINGS:
 *   - Unverified channels: 15-minute videos max. Verify in YouTube Studio.
 *   - 256 GB or 12 hours per file, whichever is less.
 *   - uploadLimitExceeded (400) is a per-CHANNEL limit, separate from project
 *     quota, and cannot be raised by requesting more quota.
 *   - Service accounts CANNOT upload on a channel's behalf. You must complete
 *     an interactive OAuth with access_type=offline at least once per channel
 *     to obtain a refresh token.
 *   - Resumable upload protocol is mandatory for anything production-shaped.
 */
export const youtube = {
  platformId: 'youtube',

  describeCredentials() {
    return [
      { key: 'refreshToken', label: 'OAuth refresh token', hint: 'Scope youtube.upload, access_type=offline', required: true },
      { key: 'clientId', label: 'OAuth client id', hint: 'From your Google Cloud project', required: true },
      { key: 'clientSecret', label: 'OAuth client secret', hint: '', required: true },
      { key: 'audited', label: 'Project passed Google\u2019s audit?', hint: 'true/false — if false, uploads are forced private', required: false },
    ];
  },

  isConfigured(creds = {}) {
    const missing = [];
    if (!creds.refreshToken) missing.push('refreshToken');
    if (!creds.clientId) missing.push('clientId');
    if (!creds.clientSecret) missing.push('clientSecret');
    return { ready: missing.length === 0, missing };
  },

  async publish({ post, account, creds }) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return simulateCall('youtube', { latency: [1200, 3000] });
    }

    const video = (post.media || []).find((m) => m.type === 'video');
    if (!video?.path || !fs.existsSync(video.path)) {
      return { ok: false, error: 'YouTube needs a video file on local disk to upload.', retryable: false };
    }

    const audited = creds.audited === true || creds.audited === 'true';

    try {
      const accessToken = await refreshGoogleToken(creds);

      const snippet = {
        title: (post.title || post.text || 'Untitled').slice(0, spec.limits.titleChars),
        description: (post.text || '').slice(0, spec.limits.captionChars),
        tags: post.tags || [],
        categoryId: '22',
      };
      const status = {
        // Without an audited project Google overrides this to private anyway.
        privacyStatus: audited ? 'public' : 'private',
        selfDeclaredMadeForKids: false,
      };
      if (audited && post.scheduledAt && new Date(post.scheduledAt) > new Date()) {
        status.privacyStatus = 'private';
        status.publishAt = new Date(post.scheduledAt).toISOString();
      }

      // Resumable upload: init the session, then PUT the bytes.
      const initRes = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(fs.statSync(video.path).size),
            'X-Upload-Content-Type': video.mime || 'video/mp4',
          },
          body: JSON.stringify({ snippet, status }),
        },
      );

      const sessionUrl = initRes.headers.get('location');
      if (!sessionUrl) {
        const text = await initRes.text();
        const retryable = initRes.status === 403 && /quota|rateLimit/i.test(text);
        return { ok: false, error: `YouTube init ${initRes.status}: ${text.slice(0, 300)}`, retryable };
      }

      const putRes = await fetch(sessionUrl, {
        method: 'PUT',
        headers: { 'Content-Type': video.mime || 'video/mp4' },
        body: fs.readFileSync(video.path),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

      if (putRes.status >= 400) {
        const msg = putRes.json?.error?.message || `HTTP ${putRes.status}`;
        // uploadLimitExceeded is a channel-level ceiling — retrying will not help.
        const retryable = putRes.status === 429 || putRes.status >= 500;
        return { ok: false, error: `YouTube upload: ${msg}`, retryable };
      }

      return {
        ok: true,
        externalId: putRes.json.id,
        mode: 'live',
        detail: audited
          ? `Uploaded and public: https://youtu.be/${putRes.json.id}`
          : `Uploaded but PRIVATE — your Cloud project has not passed Google\u2019s API Services audit, so YouTube locks it. Submit the audit form to publish publicly.`,
      };
    } catch (err) {
      return { ok: false, error: err.message, retryable: true };
    }
  },

  connectUrl(state) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return null;
    // URLSearchParams below percent-encodes this value — encoding it here
    // as well produced %253A (double-encoded) and Google rejects that as a
    // redirect_uri mismatch.
    const redirect = redirectUri('youtube', 'GOOGLE_REDIRECT_URI');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline', // required to get a refresh token
      prompt: 'consent',
      state,
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  },

  /** Swap the authorization code for long-lived credentials.
   *  Google only returns a refresh_token when the request asks for offline
   *  access AND forces the consent screen — connectUrl() sets both. If a user
   *  previously granted this app, Google skips the refresh token silently,
   *  which is why the error below points them at the permissions page. */
  async exchangeCode(code) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    const redirect = redirectUri('youtube', 'GOOGLE_REDIRECT_URI');
    if (!clientId || !secret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set');

    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirect,
        client_id: clientId, client_secret: secret,
      }),
    }).then((r) => r.json());
    if (tok.error) throw new Error(tok.error_description || tok.error);
    if (!tok.refresh_token) {
      throw new Error(
        'Google returned no refresh token. Revoke Amplify at myaccount.google.com/permissions ' +
        'and connect again — the flow asks for offline access with a forced consent screen.',
      );
    }

    // Name the account after the channel it uploads to (the token needs
    // youtube.readonly for this, which connectUrl already requests).
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());
    const first = ch?.items?.[0];

    return {
      tokens: JSON.stringify({
        refreshToken: tok.refresh_token, clientId, clientSecret: secret, accessToken: tok.access_token,
      }),
      handle: first?.id || 'youtube-channel',
      displayName: first?.snippet?.title || 'YouTube channel',
    };
  },

  /** Verify the refresh token and surface the audit state of the project. */
  async test(creds) {
    if (isMock()) return { ok: true, mode: 'mock', detail: 'Simulation mode: these credentials were NOT checked against the real platform. Turn simulation off in Admin to run the live check.' };
    if (!this.isConfigured(creds).ready) return { ok: false, error: 'Refresh token, client id and client secret are required.' };
    try {
      const token = await refreshGoogleToken(creds);
      const r = await fetch('https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet,status', {
        headers: { Authorization: `Bearer ${token}` },
      }).then((x) => x.json());
      if (r.error) return { ok: false, error: `YouTube: ${r.error.message}` };
      const ch = r.items?.[0];
      if (!ch) return { ok: false, error: 'This token is not linked to any YouTube channel.' };
      const audited = creds.audited === true || creds.audited === 'true';
      return {
        ok: true,
        detail: `Channel "${ch.snippet.title}" reachable.${audited ? '' : ' Project not marked audited — uploads will be locked PRIVATE until Google approves the API Services audit.'}`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },


  /**
   * Public video statistics: view/like/comment counts (the Data API does not
   * expose shares). Uses the same refresh-token flow as uploads — the OAuth
   * consent already requests youtube.readonly. Like counts are null when the
   * channel hides them. Deeper metrics (watch time, traffic sources) need
   * the YouTube Analytics API (yt-analytics.readonly).
   */
  async fetchStats(videoId, creds) {
    if (isMock() || !creds.refreshToken) {
      return { supported: false, metrics: {}, note: 'Configure YouTube credentials and turn simulation off for real stats.' };
    }
    try {
      const token = await refreshGoogleToken(creds);
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ).then((x) => x.json());
      const s = r.items?.[0]?.statistics;
      if (!s) {
        return { supported: false, metrics: {}, error: r.error?.message || `YouTube has no video with id ${videoId} (deleted?).` };
      }
      return {
        supported: true,
        metrics: {
          views: Number(s.viewCount ?? 0),
          likes: s.likeCount != null ? Number(s.likeCount) : null,
          comments: s.commentCount != null ? Number(s.commentCount) : null,
          url: `https://youtu.be/${videoId}`,
        },
      };
    } catch (err) {
      return { supported: false, metrics: {}, error: err.message };
    }
  },
};

async function refreshGoogleToken(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  }).then((r) => r.json());
  if (!res.access_token) throw new Error(`Google token refresh failed: ${res.error || 'unknown'}`);
  return res.access_token;
}
