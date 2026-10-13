import { db, now } from './db.js';
import { getAdapter } from './adapters/index.js';
import { getPlatform, validateForPlatform } from './platforms.js';
import { renderScene } from './render-scene.js';
import { isMock } from './settings.js';
import { fixImageForPlatform } from './media-fix.js';

/**
 * A deliberately small scheduler + worker queue.
 *
 * For a personal single-user app this beats running Redis + BullMQ: one fewer
 * process, one fewer thing to keep alive at 3am, and the DB is the queue.
 * Two loops:
 *
 *   tickScheduler()  every 15s — finds posts whose scheduled_at has arrived,
 *                    validates them per platform, and fans out one job per target.
 *
 *   tickWorkers()    every 2s  — claims due jobs and runs them with bounded
 *                    concurrency, per-platform minimum spacing (pacing), and
 *                    exponential backoff on retryable failures.
 *
 * If this ever becomes multi-tenant, swap these two functions for BullMQ and
 * keep everything above them — the adapters and the schema do not change.
 */

const CONCURRENCY = 3;
const inFlight = new Set();
const lastRunByPlatform = new Map();

export function enqueueTargets(postId, accountIds) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  const insertTarget = db.prepare(`
    INSERT INTO post_targets (post_id, account_id, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(post_id, account_id) DO UPDATE SET status = 'pending', result = NULL
  `);
  const insertJob = db.prepare(`
    INSERT INTO jobs (post_id, account_id, target_id, platform, state, not_before)
    VALUES (?, ?, ?, ?, 'queued', datetime('now'))
  `);
  const getAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');

  const created = [];
  const tx = db.transaction(() => {
    for (const accountId of accountIds) {
      const acc = getAccount.get(accountId);
      if (!acc) continue;
      const t = insertTarget.run(postId, accountId);
      const targetId =
        db.prepare('SELECT id FROM post_targets WHERE post_id = ? AND account_id = ?').get(postId, accountId).id;
      insertJob.run(postId, accountId, targetId, acc.platform);
      created.push({ accountId, platform: acc.platform, targetId });
    }
  });
  tx();

  db.prepare(`UPDATE posts SET status = ?, updated_at = ? WHERE id = ?`).run(
    post.scheduled_at && post.scheduled_at > now() ? 'scheduled' : 'queued',
    now(),
    postId,
  );

  return created;
}

/**
 * Attach target rows WITHOUT enqueueing jobs. Drafts and scheduled posts must
 * not start publishing the moment they are saved — jobs are created only by
 * enqueueTargets (publish now) or by the scheduler when the time arrives.
 */
export function attachTargets(postId, accountIds) {
  const insertTarget = db.prepare(`
    INSERT INTO post_targets (post_id, account_id, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT(post_id, account_id) DO UPDATE SET status = 'pending', result = NULL
  `);
  const getAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const tx = db.transaction(() => {
    for (const accountId of accountIds) {
      if (!getAccount.get(accountId)) continue;
      insertTarget.run(postId, accountId);
    }
  });
  tx();
}

export function tickScheduler() {
  const t = now();
  const due = db
    .prepare(`SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`)
    .all(t);

  for (const post of due) {
    const targets = db
      .prepare(`SELECT pt.*, a.platform FROM post_targets pt JOIN accounts a ON a.id = pt.account_id WHERE pt.post_id = ?`)
      .all(post.id);

    if (targets.length === 0) {
      db.prepare(`UPDATE posts SET status = 'draft', updated_at = ? WHERE id = ?`).run(now(), post.id);
      continue;
    }

    const insertJob = db.prepare(`
      INSERT INTO jobs (post_id, account_id, target_id, platform, state, not_before)
      VALUES (?, ?, ?, ?, 'queued', datetime('now'))
    `);
    const tx = db.transaction(() => {
      for (const tgt of targets) {
        if (tgt.status === 'published' || tgt.status === 'failed') continue;
        insertJob.run(post.id, tgt.account_id, tgt.id, tgt.platform);
      }
      db.prepare(`UPDATE posts SET status = 'queued', updated_at = ? WHERE id = ?`).run(now(), post.id);
    });
    tx();
  }
}

async function tickWorkers() {
  const due = db
    .prepare(
      `SELECT * FROM jobs
        WHERE state IN ('queued','retry') AND not_before <= ?
        ORDER BY not_before ASC, id ASC
        LIMIT 25`,
    )
    .all(now());

  for (const job of due) {
    if (inFlight.size >= CONCURRENCY) break;
    if (inFlight.has(job.id)) continue;

    // Pacing: never hit the same platform faster than its documented minimum
    // interval. This is what keeps a burst from tripping rate-limit detection.
    const spec = getPlatform(job.platform);
    const minInterval = (spec?.limits?.minIntervalSec ?? 1) * 1000;
    const last = lastRunByPlatform.get(job.platform) || 0;
    const wait = last + minInterval - Date.now();
    if (wait > 0) {
      db.prepare(`UPDATE jobs SET not_before = datetime('now', ?) WHERE id = ?`).run(
        `+${Math.ceil(wait / 1000)} seconds`,
        job.id,
      );
      continue;
    }

    // Claim it atomically so two workers can't grab the same row.
    const claimed = db
      .prepare(`UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state IN ('queued','retry')`)
      .run(now(), job.id);
    if (claimed.changes === 0) continue;

    inFlight.add(job.id);
    lastRunByPlatform.set(job.platform, Date.now());
    runJob(job).finally(() => inFlight.delete(job.id));
  }
}

export async function runJob(job) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(job.account_id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(job.post_id);
  if (!account || !post) return finish(job, { ok: false, error: 'Account or post disappeared', retryable: false });

  const adapter = getAdapter(account.platform);
  if (!adapter) return finish(job, { ok: false, error: `No adapter for platform "${account.platform}"`, retryable: false });

  let media = [];
  try {
    media = JSON.parse(post.media || '[]');
  } catch {}

  // If the post carries a poster scene but no uploaded image, render the
  // poster server-side. Scheduled posts must render without a browser open.
  let scene = null;
  try {
    scene = post.scene ? JSON.parse(post.scene) : null;
  } catch {}

  if (scene && media.length === 0) {
    try {
      const rendered = await renderScene(scene);
      media = [
        {
          type: 'image',
          filename: `poster-${post.id}.jpg`,
          path: rendered.path,
          url: rendered.publicUrl,
          mime: 'image/jpeg',
          bytes: rendered.bytes,
          width: rendered.width,
          height: rendered.height,
        },
      ];
      db.prepare('UPDATE posts SET media = ? WHERE id = ?').run(JSON.stringify(media), post.id);
    } catch (err) {
      return finish(job, { ok: false, error: `Poster render failed: ${err.message}`, retryable: true });
    }
  }

  // Auto-fix images into this platform's hard rules (format, aspect, width,
  // size). The original stays untouched — only this job publishes the copy.
  const fixNotes = [];
  const fixedMedia = [];
  for (const m of media) {
    if (m.type === 'image') {
      try {
        const r = await fixImageForPlatform(m, account.platform);
        fixedMedia.push(r.item);
        fixNotes.push(...r.notes);
      } catch (err) {
        return finish(job, { ok: false, error: `Media auto-fix failed: ${err.message}`, retryable: true });
      }
    } else {
      fixedMedia.push(m);
    }
  }
  media = fixedMedia;

  // Validate immediately before publishing — platform rules may have changed
  // between compose time and fire time (e.g. a token expired).
  const check = validateForPlatform(account.platform, { ...post, media });
  if (!check.ok) {
    return finish(job, { ok: false, error: check.errors.join(' | '), retryable: false });
  }

  const creds = (() => {
    try {
      return JSON.parse(account.tokens || '{}');
    } catch {
      return {};
    }
  })();

  let result;
  try {
    result = await adapter.publish({ post: { ...post, media }, account, creds, scene });
  } catch (err) {
    result = { ok: false, error: err.message, retryable: err.retryable !== false };
  }

  finish(job, result, [...check.warnings, ...fixNotes]);
}

function finish(job, result, warnings = []) {
  const t = now();
  const attempt = job.attempts + 1;

  if (result.ok) {
    db.prepare(`UPDATE jobs SET state = 'done', external_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`).run(
      result.externalId || null,
      t,
      job.id,
    );
    db.prepare(`UPDATE post_targets SET status = 'published', result = ?, external_id = ? WHERE id = ?`).run(
      JSON.stringify({ ...result, warnings }),
      result.externalId || null,
      job.target_id,
    );
  } else if (result.retryable && attempt < job.max_attempts) {
    // Exponential backoff: 30s, 120s, 480s...
    const delaySec = 30 * Math.pow(4, attempt - 1);
    db.prepare(`UPDATE jobs SET state = 'retry', not_before = datetime('now', ?), last_error = ?, updated_at = ? WHERE id = ?`).run(
      `+${delaySec} seconds`,
      String(result.error).slice(0, 500),
      t,
      job.id,
    );
    db.prepare(`UPDATE post_targets SET status = 'retrying', result = ? WHERE id = ?`).run(
      JSON.stringify({ error: result.error, attempt, retryInSec: delaySec, warnings }),
      job.target_id,
    );
  } else {
    db.prepare(`UPDATE jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(
      String(result.error).slice(0, 500),
      t,
      job.id,
    );
    db.prepare(`UPDATE post_targets SET status = 'failed', result = ? WHERE id = ?`).run(
      JSON.stringify({ error: result.error, attempts: attempt, warnings }),
      job.target_id,
    );
  }

  // Roll the parent post's status up from its targets.
  const targets = db
    .prepare('SELECT status FROM post_targets WHERE post_id = ?')
    .all(job.post_id)
    .map((r) => r.status);
  let postStatus = 'queued';
  if (targets.every((s) => s === 'published')) postStatus = 'published';
  else if (targets.every((s) => s === 'published' || s === 'failed')) postStatus = 'partial';
  else if (targets.every((s) => s === 'failed')) postStatus = 'failed';
  else if (targets.some((s) => s === 'retrying')) postStatus = 'queued';
  db.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?').run(postStatus, t, job.post_id);
}

let started = false;
export function startQueue() {
  if (started) return;
  started = true;
  setInterval(() => {
    try {
      tickScheduler();
    } catch (err) {
      console.error('[scheduler]', err.message);
    }
  }, 15_000);
  setInterval(() => {
    try {
      tickWorkers();
    } catch (err) {
      console.error('[worker]', err.message);
    }
  }, 2_000);

  // On boot, requeue anything left mid-flight by a restart.
  db.prepare(`UPDATE jobs SET state = 'queued', not_before = datetime('now') WHERE state = 'running'`).run();
  console.log(`[queue] running (simulation: ${isMock()}, concurrency: ${CONCURRENCY})`);
}
