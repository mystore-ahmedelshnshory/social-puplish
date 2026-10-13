import { isMock, simulateCall } from './index.js';
import { getPlatform } from '../platforms.js';
import { redirectUri } from '../settings.js';

const REST = 'https://api.linkedin.com/rest';
const spec = getPlatform('linkedin');

// LinkedIn requires a version header on every REST call. It is bumped yearly;
// a version older than ~3 years starts returning 4xx. Pin it in one place.
const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || '202506';

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-Restli-Protocol-Version': '2.0.0',
  'Linkedin-Version': LINKEDIN_VERSION,
});

/**
 * LinkedIn — two very different destinations behind one API.
 *
 * PERSONAL PROFILE: author = urn:li:person:{id}, scope w_member_social.
 *   Granted instantly and self-serve via the "Share on LinkedIn" product.
 *   150 requests per member per day. THIS IS WHAT THIS ADAPTER USES.
 *
 * COMPANY PAGE: author = urn:li:organization:{id}, scope w_organization_social.
 *   Requires the Community Management API partner programme — registered legal
 *   organization, business email, verified organization AND domain, a Page
 *   super-admin verifying the app, then a screencast review. Development tier
 *   is capped at 500 calls/app and 100 calls/member per 24h, with no webhooks
 *   and a 12-month deadline to finish building. Set LINKEDIN_AUTHOR=organization
 *   once you have that approval.
 *
 * Also: every app must be associated with a LinkedIn Page you administer, and
 * you need a privacy policy URL on file even for the self-serve product.
 * Access tokens live 60 days; refresh tokens 365 days and are not on by default.
 */
export const linkedin = {
  platformId: 'linkedin',

  describeCredentials() {
    return [
      { key: 'personUrn', label: 'Your person URN id', hint: 'The numeric id in urn:li:person:{id} — from /v2/userinfo', required: true },
      { key: 'accessToken', label: 'Access token', hint: 'Scope: w_member_social', required: true },
      { key: 'authorType', label: 'Author type', hint: 'person (default) or organization — organization needs partner approval', required: false },
    ];
  },

  isConfigured(creds = {}) {
    const missing = [];
    if (!creds.personUrn) missing.push('personUrn');
    if (!creds.accessToken) missing.push('accessToken');
    return { ready: missing.length === 0, missing };
  },

  async publish({ post, account, creds }) {
    if (isMock() || !this.isConfigured(creds).ready) {
      return simulateCall('linkedin');
    }

    const commentary = (post.text || '').slice(0, spec.limits.captionChars);
    if (!commentary.trim()) {
      return { ok: false, error: 'LinkedIn posts need commentary text.', retryable: false };
    }

    const isOrg = (creds.authorType || process.env.LINKEDIN_AUTHOR) === 'organization';
    const author = isOrg ? `urn:li:organization:${creds.personUrn}` : `urn:li:person:${creds.personUrn}`;

    const body = {
      author,
      commentary,
      visibility: { distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], visibility: 'PUBLIC' } },
      lifecycleState: 'PUBLISHED',
      isCommentable: true,
    };

    const images = (post.media || []).filter((m) => m.type === 'image' && m.path).slice(0, spec.limits.carouselMax);

    // Multi-image: register each file through the images API, then publish a
    // native carousel. Single image uses the simpler media attachment.
    if (images.length > 1) {
      const fs = await import('node:fs');
      const elements = [];
      for (const m of images) {
        const init = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
          method: 'POST',
          headers: headers(creds.accessToken),
          body: JSON.stringify({ initializeUpload: { owner: author } }),
        }).then((r) => r.json());
        const up = init?.value;
        if (!up?.uploadUrl) return { ok: false, error: 'LinkedIn image initializeUpload failed.', retryable: true };
        await fetch(up.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': m.mime || 'image/jpeg' },
          body: fs.readFileSync(m.path),
        });
        elements.push({ image: up.image });
      }
      body.content = { carousel: { elements } };
    } else {
      // Single image attachment. Media must be uploaded first and referenced by URN.
      const image = (post.media || []).find((m) => m.type === 'image');
      if (image?.urn) {
        body.content = {
          media: { id: image.urn, title: (post.text || '').slice(0, 200) },
          mediaAttachments: [],
        };
      }
    }

    try {
      const res = await fetch(`${REST}/posts`, { method: 'POST', headers: headers(creds.accessToken), body: JSON.stringify(body) });
      const location = res.headers.get('x-restli-id');

      if (!res.ok && res.status !== 201) {
        const text = await res.text();
        // ACCESS_DENIED covers BOTH missing scopes and missing Page roles.
        const retryable = res.status === 429 || res.status >= 500;
        return { ok: false, error: `LinkedIn ${res.status}: ${text.slice(0, 300)}`, retryable };
      }
      return { ok: true, externalId: location, mode: 'live', detail: `Published as ${author}` };
    } catch (err) {
      return { ok: false, error: err.message, retryable: true };
    }
  },

  connectUrl(state) {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    if (!clientId) return null;
    const redirect = encodeURIComponent(redirectUri('linkedin', 'LINKEDIN_REDIRECT_URI'));
    return {
      url: `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirect}&state=${state}&scope=openid%20profile%20w_member_social`,
    };
  },

  async exchangeCode(code) {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const secret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirect = redirectUri('linkedin', 'LINKEDIN_REDIRECT_URI');
    if (!clientId || !secret) throw new Error('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set');

    const tok = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: secret }),
    }).then((r) => r.json());
    if (tok.error) throw new Error(tok.error_description || tok.error);

    const info = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());

    return {
      tokens: JSON.stringify({ accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresIn: tok.expires_in }),
      handle: info.sub,
      displayName: info.name || info.email || info.sub,
    };
  },

  /** Verify the token and confirm the w_member_social scope is present. */
  async test(creds) {
    if (isMock()) return { ok: true, mode: 'mock', detail: 'Simulation mode: these credentials were NOT checked against the real platform. Turn simulation off in Admin to run the live check.' };
    if (!this.isConfigured(creds).ready) return { ok: false, error: 'Person URN id and access token are required.' };
    try {
      const r = await fetch('https://api.linkedin.com/v2/userinfo', { headers: headers(creds.accessToken) }).then((x) => x.json());
      if (r.error || !r.sub) return { ok: false, error: `LinkedIn rejected the token: ${r.error_description || r.error || 'unknown'}` };
      return { ok: true, detail: `Token valid for ${r.name || r.sub}. Personal-profile posting (w_member_social) is self-serve and instant.` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },


  /**
   * Likes/comments via socialActions. Honest caveat: LinkedIn gates READ
   * access behind r_member_social / r_organization_social while personal
   * apps only ever get w_member_social, so this typically answers 403 —
   * surfaced as the platform gate, not an Amplify bug. Company-page
   * impressions need the Community Management API (review + verified domain).
   */
  async fetchStats(shareUrn, creds) {
    if (isMock() || !creds.accessToken) {
      return { supported: false, metrics: {}, note: 'Connect LinkedIn and turn simulation off for real stats.' };
    }
    if (!shareUrn || !shareUrn.startsWith('urn:li:')) {
      return { supported: false, metrics: {}, error: `Unrecognised LinkedIn post id: ${shareUrn}` };
    }
    try {
      const r = await fetch(`${REST}/socialActions/${shareUrn}`, { headers: headers(creds.accessToken) }).then((x) => x.json());
      if (r.status === 403 || r.serviceErrorCode) {
        return {
          supported: false,
          metrics: {},
          error: `LinkedIn ${r.status || ''} ${r.message || 'access denied'} — reading engagement requires r_member_social / r_organization_social, which LinkedIn does not grant personal apps.`,
        };
      }
      return {
        supported: true,
        metrics: {
          likes: r.likesSummary?.aggregatedTotalLikes ?? r.likesSummary?.totalLikes ?? null,
          comments: r.commentsSummary?.aggregatedTotalComments ?? r.commentsSummary?.totalFirstLevelComments ?? null,
          url: `https://www.linkedin.com/feed/update/${shareUrn}/`,
        },
      };
    } catch (err) {
      return { supported: false, metrics: {}, error: err.message };
    }
  },
};
