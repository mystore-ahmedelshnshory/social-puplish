/**
 * Post-publish analytics (backlog item 7).
 *
 * Every published post_target already stores the platform-side id
 * (`external_id`, written by the queue from each adapter's publish result).
 * This module turns those ids into normalized engagement numbers:
 *
 *   { supported, metrics: { views, reach, likes, comments, shares, saved, url },
 *     note?, error?, fetchedAt, cached, mock? }
 *
 * PLATFORM REALITY (researched October 2026 — encode, don't re-litigate):
 *
 *  - Meta killed impressions. Instagram: `impressions`/`plays` deprecated
 *    across ALL versions 21 Apr 2025 (error for media created ≥ 2 Jul 2024),
 *    replaced by `views`; `reach`, `likes`, `comments`, `saved`,
 *    `total_interactions` survive. Facebook: `post_impressions` gone
 *    15 Nov 2025 → `post_media_view`; `post_impressions_unique` gone
 *    15 Jun 2026 → `post_total_media_view_unique`; `page_fans` → follows.
 *    Requesting a dead metric fails the WHOLE insights call, so adapters
 *    try the modern set first and fall back to a safe subset.
 *  - Telegram Bot API has NO per-message analytics at all (views/reactions
 *    are not readable by bots). Reported honestly as unsupported.
 *  - TikTok numbers live in the Display API (`POST /v2/video/query/`,
 *    scope `video.list`) — a different product from the Content Posting
 *    audit. Our external id is the publish_id, so resolve the public
 *    video id via `status/fetch` first. Photo posts may not report.
 *  - YouTube `videos?part=statistics` gives view/like/comment counts
 *    (shares not exposed; the Analytics API needs yt-analytics.readonly).
 *    The OAuth flow already requests youtube.readonly.
 *  - LinkedIn engagement READS need r_member_social / r_organization_social;
 *    personal apps only ever get w_member_social, so socialActions usually
 *    answers 403. We try, then report the gate honestly.
 *
 * Caching: SQLite `stats` table, 10-minute TTL (STATS_TTL_MIN), because
 * every platform rate-limits reads and nobody needs sub-minute freshness.
 *
 * Simulation mode: deterministic seeded pseudo-stats that grow with the
 * hours since publish — stable between refreshes, so the whole UI is
 * testable end-to-end with zero API keys.
 */

import { db, now } from './db.js';
import { isMock } from './settings.js';
import { getAdapter } from './adapters/index.js';

const CACHE_TTL_MIN = Number(process.env.STATS_TTL_MIN || 10);

export const METRIC_KEYS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved'];

/** Shown in the UI wherever a platform cannot deliver numbers. */
export const STATS_NOTES = {
  telegram:
    'Telegram Bot API exposes no per-message analytics — bots cannot read views or reactions. This is a platform limitation, not an Amplify bug.',
  facebook_page:
    'Reactions/comments/shares + post_media_view insights (Meta deprecated post_impressions 15 Nov 2025). Live mode needs pages_read_engagement and read_insights on the page token.',
  instagram:
    'views/reach/likes/comments/saved via media insights (impressions & plays deprecated 21 Apr 2025). Live mode needs instagram_manage_insights.',
  linkedin:
    'Likes/comments via socialActions — but LinkedIn gates READ access behind r_member_social / r_organization_social, which personal apps are not granted. A 403 here is LinkedIn, not Amplify.',
  youtube:
    'Views/likes/comments via videos?part=statistics. Share counts are not exposed by the Data API; deeper metrics need the YouTube Analytics API (yt-analytics.readonly).',
  tiktok:
    'View/like/comment/share counts via the Display API video/query (scope video.list) — a separate product from the Content Posting audit. Photo posts may not report stats.',
};

// ---------------------------------------------------------------- mock stats

/** FNV-1a → uint32 seed so the same post+platform always mocks the same. */
function seedFrom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_SHAPE = {
  facebook_page: ['views', 'reach', 'likes', 'comments', 'shares'],
  instagram: ['views', 'reach', 'likes', 'comments', 'saved'],
  linkedin: ['likes', 'comments'],
  youtube: ['views', 'likes', 'comments'],
  tiktok: ['views', 'likes', 'comments', 'shares'],
};

/**
 * Deterministic simulated stats. `publishedAt`/`now` are injectable so the
 * test suite can pin time. Numbers grow logarithmically with hours since
 * publish and never change for a given (platform, externalId, time) triple.
 */
export function mockStats({ platform, externalId, publishedAt, now: nowMs = Date.now() }) {
  if (!MOCK_SHAPE[platform]) {
    return { supported: false, mock: true, metrics: {}, note: STATS_NOTES[platform] || 'No stats for this platform.' };
  }
  const rnd = mulberry32(seedFrom(`${platform}:${externalId}`));
  const hours = Math.max(0.5, (nowMs - publishedAt) / 3.6e6);
  const growth = Math.log2(1 + hours);
  const views = Math.max(3, Math.round((60 + rnd() * 500) * growth * (0.7 + rnd() * 0.8)));

  const metrics = {};
  for (const key of MOCK_SHAPE[platform]) {
    if (key === 'views') metrics.views = views;
    else if (key === 'reach') metrics.reach = Math.round(views * (0.55 + rnd() * 0.35));
    else if (key === 'likes') metrics.likes = Math.max(1, Math.round(views * (0.03 + rnd() * 0.09)));
    else if (key === 'comments') metrics.comments = Math.round((metrics.likes ?? views * 0.05) * (0.02 + rnd() * 0.12));
    else if (key === 'shares') metrics.shares = Math.round((metrics.likes ?? views * 0.05) * (0.04 + rnd() * 0.18));
    else if (key === 'saved') metrics.saved = Math.round((metrics.likes ?? views * 0.05) * (0.1 + rnd() * 0.3));
  }
  return {
    supported: true,
    mock: true,
    metrics,
    note: 'Simulated stats (deterministic fakes that grow with time). Turn simulation off in Admin for real numbers.',
  };
}

// ------------------------------------------------------------------- queries

const TARGETS_SQL = `
  SELECT pt.id AS target_id, a.platform, pt.external_id,
         a.handle, a.display_name, a.tokens,
         p.text, p.status, p.created_at,
         (SELECT MAX(j.updated_at) FROM jobs j WHERE j.target_id = pt.id AND j.state = 'done') AS published_at
  FROM post_targets pt
  JOIN accounts a ON a.id = pt.account_id
  JOIN posts p ON p.id = pt.post_id
  WHERE pt.post_id = ? AND pt.status = 'published'
  ORDER BY pt.id`;

/** Posts that have at least one published target — the Stats tab's list. */
export function listStatsPosts() {
  return db
    .prepare(
      `SELECT p.id, p.text, p.status, p.created_at,
        (SELECT MAX(j.updated_at) FROM jobs j
           JOIN post_targets t2 ON t2.id = j.target_id
          WHERE t2.post_id = p.id AND j.state = 'done') AS published_at,
        (SELECT GROUP_CONCAT(DISTINCT a2.platform) FROM post_targets pt
           JOIN accounts a2 ON a2.id = pt.account_id
          WHERE pt.post_id = p.id AND pt.status = 'published') AS platforms
       FROM posts p
       WHERE EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.status = 'published')
       ORDER BY published_at DESC, p.id DESC`,
    )
    .all()
    .map((r) => ({ ...r, platforms: (r.platforms || '').split(',').filter(Boolean) }));
}

const parseDbTime = (s, fallback) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : fallback);

/**
 * Stats for ONE published target, cache-first.
 * `row` comes from TARGETS_SQL (or a test fixture with the same shape).
 */
export async function fetchTargetStats(row, { refresh = false, now: nowMs = Date.now(), fetcher = null } = {}) {
  const base = {
    platform: row.platform,
    accountLabel: row.display_name || row.handle || row.platform,
    externalId: row.external_id || null,
    publishedAt: row.published_at || row.created_at || null,
  };

  // Telegram has nothing to fetch, ever — skip the cache round-trip too.
  if (row.platform === 'telegram') {
    return { ...base, supported: false, metrics: {}, note: STATS_NOTES.telegram, fetchedAt: now(), cached: false };
  }

  if (!refresh) {
    const hit = db.prepare('SELECT metrics, fetched_at FROM stats WHERE target_id = ?').get(row.target_id);
    if (hit && nowMs - parseDbTime(hit.fetched_at, 0) < CACHE_TTL_MIN * 60_000) {
      return { ...base, ...JSON.parse(hit.metrics), fetchedAt: hit.fetched_at, cached: true };
    }
  }

  let out;
  const useMock = isMock() || !row.external_id || /^mock_/i.test(row.external_id);
  if (useMock) {
    out = mockStats({
      platform: row.platform,
      externalId: row.external_id || `target_${row.target_id}`,
      publishedAt: parseDbTime(row.published_at || row.created_at, nowMs - 7.2e6),
      now: nowMs,
    });
  } else {
    const adapter = fetcher || getAdapter(row.platform);
    if (!adapter?.fetchStats) {
      out = { supported: false, metrics: {}, note: 'This adapter has no fetchStats implementation.' };
    } else {
      try {
        out = await adapter.fetchStats(row.external_id, JSON.parse(row.tokens || '{}'));
        out = out || { supported: false, metrics: {} };
        out.metrics = out.metrics || {};
        if (out.supported === undefined) out.supported = !out.error;
      } catch (err) {
        out = { supported: false, metrics: {}, error: err.message };
      }
    }
  }

  const fetchedAt = now();
  const payload = { supported: !!out.supported, mock: !!out.mock, metrics: out.metrics, note: out.note || null, error: out.error || null };
  db.prepare(
    `INSERT INTO stats (target_id, metrics, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET metrics = excluded.metrics, fetched_at = excluded.fetched_at`,
  ).run(row.target_id, JSON.stringify(payload), fetchedAt);

  return { ...base, ...payload, fetchedAt, cached: false };
}

/** All published targets of one post + engagement totals. */
export async function getPostStats(postId, { refresh = false, now: nowMs = Date.now() } = {}) {
  const post = db.prepare('SELECT id, text, status, created_at FROM posts WHERE id = ?').get(postId);
  if (!post) return null;
  const rows = db.prepare(TARGETS_SQL).all(postId);
  const targets = [];
  for (const row of rows) targets.push(await fetchTargetStats(row, { refresh, now: nowMs }));

  const totals = {};
  for (const key of METRIC_KEYS) {
    const sum = targets.reduce((acc, t) => acc + (t.metrics?.[key] ?? 0), 0);
    totals[key] = targets.some((t) => t.metrics?.[key] != null) ? sum : null;
  }
  return { post, totals, targets };
}
