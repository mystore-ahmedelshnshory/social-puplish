import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, now, toDbTime } from './db.js';
import { ACTIVE_PLATFORMS, BLOCKED_PLATFORMS, PLATFORMS, getPlatform, validateForPlatform } from './platforms.js';
import { ADAPTERS, getAdapter } from './adapters/index.js';
import { isMock, publicBaseUrl, getSetting, setSetting } from './settings.js';
import { startQueue, enqueueTargets, attachTargets } from './queue.js';
import { seedAccountsFromEnv } from './seed-env.js';
import { renderScene } from './render-scene.js';
import { loadImage } from 'canvas';
import { seedIfEmpty } from './seed.js';
import { getPostStats, listStatsPosts } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

// Optional blanket passcode for public hosts: with APP_PASSCODE set, the whole
// app (UI included) sits behind HTTP Basic auth — your browser asks once and
// remembers. Needed when the app runs on a public URL you don't control, e.g.
// a free-tier host that only offers public apps.
const APP_PASSCODE = (process.env.APP_PASSCODE || '').trim();
if (APP_PASSCODE) {
  app.use((req, res, next) => {
    const hdr = req.get('authorization') || '';
    const b64 = hdr.startsWith('Basic ') ? hdr.slice(6) : '';
    if (b64) {
      const pass = Buffer.from(b64, 'base64').toString('utf8').split(':').slice(1).join(':');
      if (pass === APP_PASSCODE) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Amplify", charset="UTF-8"');
    res.status(401).send('Amplify — enter the passcode from your APP_PASSCODE setting.');
  });
}

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/renders', express.static(path.join(ROOT, 'data', 'renders')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/processed', express.static(path.join(ROOT, 'data', 'processed')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]+/g, '_')}`),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});

const json = (v) => {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

const parsePost = (row) => ({
  ...row,
  media: json(row.media) || [],
  scene: json(row.scene),
  targets: db
    .prepare(
      `SELECT pt.*, a.platform, a.handle, a.display_name
         FROM post_targets pt JOIN accounts a ON a.id = pt.account_id
        WHERE pt.post_id = ?`,
    )
    .all(row.id)
    .map((t) => ({ ...t, result: json(t.result) })),
});

const parseAccount = (row) => {
  const adapter = getAdapter(row.platform);
  const creds = json(row.tokens) || {};
  const cfg = adapter ? adapter.isConfigured(creds) : { ready: false, missing: [] };
  const spec = getPlatform(row.platform);
  return {
    id: row.id,
    platform: row.platform,
    platformName: spec?.name || row.platform,
    color: spec?.color,
    handle: row.handle,
    displayName: row.display_name,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    // Never echo secret values back to the browser — only whether they exist.
    credentialsPresent: Object.fromEntries(
      (adapter?.describeCredentials() || []).map((c) => [c.key, Boolean(creds[c.key])]),
    ),
    liveReady: !isMock() && cfg.ready,
    missing: cfg.missing,
    mode: isMock() ? 'mock' : cfg.ready ? 'live' : 'incomplete',
  };
};

// ---------------------------------------------------------------- platforms

app.get('/api/platforms', (req, res) => {
  res.json({
    mockMode: isMock(),
    active: ACTIVE_PLATFORMS.map((p) => ({
      ...p,
      adapterPresent: Boolean(ADAPTERS[p.id]),
      credentialFields: getAdapter(p.id)?.describeCredentials() || [],
      oauthEnvPresent: Boolean(OAUTH_ENV_KEY[p.id] && process.env[OAUTH_ENV_KEY[p.id]]),
      hasBrowserFlow: Boolean(getAdapter(p.id)?.connectUrl),
    })),
    blocked: BLOCKED_PLATFORMS.map((p) => ({ id: p.id, name: p.name, color: p.color, gate: p.gate, notes: p.notes })),
  });
});

app.get('/api/platforms/:id/validate', (req, res) => {
  const post = json(req.query.post) || { text: '', media: [] };
  res.json(validateForPlatform(req.params.id, post));
});

// ---------------------------------------------------------------- accounts

app.get('/api/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY platform, handle').all().map(parseAccount));
});

app.post('/api/accounts', (req, res) => {
  const { platform, handle, displayName, kind, credentials } = req.body;
  const spec = getPlatform(platform);
  if (!spec) return res.status(400).json({ error: `Unknown platform "${platform}"` });
  if (!spec.enabled) return res.status(400).json({ error: `${spec.name}: ${spec.gate.label}` });
  if (!handle) return res.status(400).json({ error: 'A handle is required' });

  try {
    db.prepare(
      `INSERT INTO accounts (platform, handle, display_name, kind, tokens)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform, handle) DO UPDATE SET
         display_name = excluded.display_name,
         kind = excluded.kind,
         tokens = excluded.tokens,
         status = 'connected'`,
    ).run(platform, handle, displayName || handle, kind || 'profile', JSON.stringify(credentials || {}));
    const row = db.prepare('SELECT * FROM accounts WHERE platform = ? AND handle = ?').get(platform, handle);
    res.json(parseAccount(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/accounts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const existing = json(row.tokens) || {};
  const merged = { ...existing, ...(req.body.credentials || {}) };
  db.prepare('UPDATE accounts SET tokens = ?, display_name = COALESCE(?, display_name) WHERE id = ?').run(
    JSON.stringify(merged),
    req.body.displayName ?? null,
    row.id,
  );
  res.json(parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id)));
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/accounts/:id/connect-url', (req, res) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  const adapter = row ? getAdapter(row.platform) : null;
  const url = adapter?.connectUrl?.(crypto_state());
  res.json({ url: url?.url || null, reason: url ? null : 'OAuth is not configured for this platform in this build.' });
});

function crypto_state() {
  return Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------- posts

/**
 * Validate every target against its platform's CURRENT rules, enqueue only the
 * ones that pass, and report the rejections with reasons. A post never enters
 * the queue doomed: policy failures surface before any job exists.
 */
function publishNow(postId, accountIds) {
  const post = parsePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(postId));
  // A scene with no uploaded media WILL render to a poster in the worker,
  // so validate as if that image already exists at the scene's dimensions.
  const mediaForCheck = post.media.length
    ? post.media
    : post.scene
      ? [{ type: 'image', width: post.scene.width, height: post.scene.height, mime: 'image/jpeg' }]
      : [];

  const enqueued = [];
  const rejected = [];
  for (const accountId of accountIds) {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) continue;
    const check = validateForPlatform(acc.platform, { ...post, media: mediaForCheck });
    if (check.ok) enqueued.push(accountId);
    else rejected.push({ accountId, platform: acc.platform, name: getPlatform(acc.platform)?.name, errors: check.errors });
  }

  if (enqueued.length) {
    db.prepare('DELETE FROM jobs WHERE post_id = ? AND state IN (?,?)').run(postId, 'queued', 'retry');
    enqueueTargets(postId, enqueued);
    db.prepare(`UPDATE jobs SET not_before = datetime('now') WHERE post_id = ? AND state = 'queued'`).run(postId);
  }
  return { enqueued, rejected };
}


app.get('/api/posts', (req, res) => {
  const rows = db.prepare('SELECT * FROM posts ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC LIMIT 200').all();
  res.json(rows.map(parsePost));
});

app.get('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(parsePost(row));
});

app.post('/api/posts', (req, res) => {
  const { text, scene, media, scheduledAt, targets, publish } = req.body;
  let report = {};
  const info = db
    .prepare(
      `INSERT INTO posts (text, scene, media, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      text || '',
      scene ? JSON.stringify(scene) : null,
      JSON.stringify(media || []),
      toDbTime(scheduledAt),
      scheduledAt ? 'scheduled' : 'draft',
    );

  const postId = info.lastInsertRowid;
  if (Array.isArray(targets) && targets.length) {
    const accountIds = targets.map((t) => (typeof t === 'object' ? t.accountId : t));
    attachTargets(postId, accountIds);
    // Only "publish now" creates jobs. A scheduled post's jobs are born when
    // the scheduler sees scheduled_at arrive; a draft's are born never.
    if (publish && !toDbTime(scheduledAt)) report = publishNow(postId, accountIds);
  }

  res.json({ ...parsePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(postId)), ...report });
});

app.patch('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { text, scene, media, scheduledAt, targets } = req.body;

  db.prepare(
    `UPDATE posts SET
       text = COALESCE(?, text),
       scene = COALESCE(?, scene),
       media = COALESCE(?, media),
       scheduled_at = ?,
       status = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    text ?? null,
    scene !== undefined ? JSON.stringify(scene) : null,
    media !== undefined ? JSON.stringify(media) : null,
    toDbTime(scheduledAt),
    scheduledAt ? 'scheduled' : row.status === 'published' ? row.status : 'draft',
    now(),
    row.id,
  );

  if (Array.isArray(targets)) {
    db.prepare('DELETE FROM post_targets WHERE post_id = ?').run(row.id);
    db.prepare('DELETE FROM jobs WHERE post_id = ?').run(row.id);
    const accountIds = targets.map((t) => (typeof t === 'object' ? t.accountId : t));
    if (accountIds.length) {
      attachTargets(row.id, accountIds);
      if (req.body.publish && !toDbTime(scheduledAt)) enqueueTargets(row.id, accountIds);
    }
  } else if (req.body.publish) {
    const accountIds = db.prepare('SELECT account_id FROM post_targets WHERE post_id = ?').all(row.id).map((r) => r.account_id);
    if (accountIds.length && !toDbTime(scheduledAt || row.scheduled_at)) enqueueTargets(row.id, accountIds);
  }

  res.json(parsePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id)));
});

app.delete('/api/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** Run validation for every targeted platform before committing — the pre-check. */
app.post('/api/posts/:id/precheck', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const post = parsePost(row);
  const platforms = req.body.platforms || [...new Set(post.targets.map((t) => t.platform))];
  res.json(platforms.map((p) => ({ platform: p, name: getPlatform(p)?.name || p, ...validateForPlatform(p, post) })));
});

app.post('/api/posts/:id/publish', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const accountIds =
    req.body.accountIds ||
    db.prepare('SELECT account_id FROM post_targets WHERE post_id = ?').all(row.id).map((r) => r.account_id);

  if (!accountIds.length) return res.status(400).json({ error: 'No target accounts selected.' });

  res.json({ ...parsePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id)), ...publishNow(row.id, accountIds) });
});

// ---------------------------------------------------------------- jobs

app.get('/api/jobs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT j.*, a.platform AS acc_platform, a.handle
         FROM jobs j JOIN accounts a ON a.id = j.account_id
        ORDER BY j.id DESC LIMIT 200`,
    )
    .all();
  res.json(rows);
});

app.post('/api/jobs/:id/retry', (req, res) => {
  db.prepare(`UPDATE jobs SET state = 'queued', attempts = 0, not_before = datetime('now'), last_error = NULL WHERE id = ?`).run(
    req.params.id,
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------- media & render

app.post('/api/media', upload.array('files', 12), async (req, res) => {
  const saved = [];
  for (const f of req.files || []) {
    let width = null;
    let height = null;
    if (!f.mimetype.startsWith('video')) {
      // Probe dimensions so validators can check aspect ratios BEFORE publish.
      try {
        const img = await loadImage(f.path);
        width = img.width;
        height = img.height;
      } catch {}
    }
    const info = db
      .prepare('INSERT INTO media (filename, stored_as, mime, bytes, width, height) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.originalname, f.filename, f.mimetype, f.size, width, height);
    saved.push({
      id: info.lastInsertRowid,
      filename: f.originalname,
      url: `/uploads/${f.filename}`,
      path: f.path,
      mime: f.mimetype,
      bytes: f.size,
      width,
      height,
      type: f.mimetype.startsWith('video') ? 'video' : 'image',
    });
  }
  res.json(saved);
});

app.get('/api/media', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM media ORDER BY id DESC LIMIT 100')
      .all()
      .map((m) => ({ ...m, url: `/uploads/${m.stored_as}`, type: (m.mime || '').startsWith('video') ? 'video' : 'image' })),
  );
});

app.delete('/api/media/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, row.stored_as));
  } catch {}
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/** Render a poster scene server-side and return the image — used for previews
 *  and by the queue when a scheduled post fires with no browser present. */
app.post('/api/render', async (req, res) => {
  try {
    const out = await renderScene(req.body.scene || req.body, {
      format: req.body.format === 'png' ? 'png' : 'jpeg',
      quality: req.body.quality ?? 0.92,
    });
    res.json({ ...out, path: undefined });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ---------------------------------------------------------------- OAuth connect flows

const OAUTH_ENV_KEY = {
  facebook_page: 'FACEBOOK_APP_ID',
  linkedin: 'LINKEDIN_CLIENT_ID',
  youtube: 'GOOGLE_CLIENT_ID',
  tiktok: 'TIKTOK_CLIENT_KEY',
};

const infoPage = (title, body) => `<!doctype html><meta charset="utf-8">
<body style="font:15px/1.6 system-ui,sans-serif;background:#0a0c14;color:#e8ebf5;display:grid;place-items:center;min-height:100vh">
<div style="max-width:460px;border:1px solid #262c40;border-radius:14px;padding:22px;background:#141826">
<h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#98a1bd">${body}</p>
<p style="margin:14px 0 0;color:#6f7896;font-size:13px">You can close this tab — return to Amplify's Accounts tab.</p></div></body>`;

app.get('/api/oauth/:platform/start', (req, res) => {
  const platform = req.params.platform;
  const adapter = getAdapter(platform);
  const spec = getPlatform(platform);
  if (!spec?.enabled) return res.status(404).send(infoPage('Unknown platform', platform));

  const envKey = OAUTH_ENV_KEY[platform];
  if (!envKey) {
    return res.status(501).send(infoPage(
      'No browser sign-in for ' + spec.name,
      'This platform uses paste-style credentials — open the Accounts tab and paste them there.',
    ));
  }
  if (!process.env[envKey]) {
    return res.status(501).send(infoPage(
      'OAuth is not configured for ' + spec.name,
      `Set the ${envKey} environment variable (and its secret) on the server to enable the browser sign-in flow. Meanwhile, paste-style credentials in the Accounts tab work exactly the same.`,
    ));
  }
  if (!adapter?.connectUrl) return res.status(501).send(infoPage('No browser flow', spec.name + ' uses paste-style credentials only.'));

  const state = crypto.randomUUID();
  db.prepare('INSERT INTO oauth_states (state, platform) VALUES (?, ?)').run(state, platform);
  const u = adapter.connectUrl(state);
  res.redirect(u.url);
});

app.get('/api/oauth/:platform/callback', async (req, res) => {
  const platform = req.params.platform;
  const { code, state, error, error_description } = req.query;

  if (error) return res.send(infoPage('Connection cancelled', error_description || error));

  const row = state ? db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state) : null;
  if (state) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (!row) return res.send(infoPage('Invalid or expired sign-in state', 'States expire after 10 minutes. Start again from the Accounts tab.'));

  const adapter = getAdapter(platform);
  if (!adapter || typeof adapter.exchangeCode !== 'function') {
    return res.send(infoPage(
      'No browser sign-in for ' + (getPlatform(platform)?.name || platform),
      'This platform uses paste-style credentials — open the Accounts tab and paste them there instead.',
    ));
  }
  try {
    const out = await adapter.exchangeCode(code);
    const rows = [{ handle: out.handle, displayName: out.displayName, tokens: out.tokens }, ...(out.extra || [])];
    const up = db.prepare(`
      INSERT INTO accounts (platform, handle, display_name, kind, tokens)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, handle) DO UPDATE SET tokens = excluded.tokens, display_name = excluded.display_name, status = 'connected'
    `);
    for (const a of rows) up.run(platform, a.handle, a.displayName || a.handle, 'oauth', a.tokens);
    res.redirect(`/?oauth=ok&platform=${platform}&n=${rows.length}`);
  } catch (e) {
    res.send(infoPage('Connection failed', e.message));
  }
});

// ---------------------------------------------------------------- admin

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || '';
function adminGate(req, res, next) {
  if (!ADMIN_PASSCODE) return next();
  if (req.get('x-admin-passcode') === ADMIN_PASSCODE) return next();
  res.status(401).json({ error: 'Admin passcode required (ADMIN_PASSCODE is set).' });
}

app.get('/api/admin/status', adminGate, (req, res) => {
  res.json({
    mockMode: isMock(),
    publicBaseUrl: publicBaseUrl(),
    passcodeProtected: Boolean(ADMIN_PASSCODE),
    env: {
      FACEBOOK_APP_ID: Boolean(process.env.FACEBOOK_APP_ID),
      LINKEDIN_CLIENT_ID: Boolean(process.env.LINKEDIN_CLIENT_ID),
      GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
      TIKTOK_CLIENT_KEY: Boolean(process.env.TIKTOK_CLIENT_KEY),
    },
    queue: {
      concurrency: 3,
      outstanding: db.prepare(`SELECT COUNT(*) c FROM jobs WHERE state IN ('queued','retry','running')`).get().c,
      done: db.prepare(`SELECT COUNT(*) c FROM jobs WHERE state = 'done'`).get().c,
      failed: db.prepare(`SELECT COUNT(*) c FROM jobs WHERE state = 'failed'`).get().c,
    },
    settings: {
      mock_mode: getSetting('mock_mode'),
      public_base_url: getSetting('public_base_url'),
    },
  });
});

const QUOTA_NOTES = {
  telegram: 'Telegram rates per minute (~20 messages/min to channels), not per day — the daily figure is Amplify\u2019s own pacing budget.',
  facebook_page: 'Meta publishes no hard daily Page-post cap; 200/day is Amplify\u2019s conservative pacing budget.',
  linkedin: '150 requests per member per day on Share on LinkedIn. Counts ALL your LinkedIn API use, not just Amplify.',
  instagram: 'Rolling 24h window, not a calendar day. When connected live, the platform-reported number is authoritative.',
  youtube: '100 videos.insert calls per day per Cloud project (separate bucket since June 2026). Channel-level ceilings apply on top.',
  tiktok: 'Per-creator daily cap (typically ~15) SHARED across every API client you use — other tools eat the same budget.',
};

app.get('/api/admin/quotas', adminGate, async (req, res) => {
  const rows = db
    .prepare(`SELECT platform, COUNT(*) c FROM jobs WHERE state = 'done' AND date(updated_at) = date('now') GROUP BY platform`)
    .all();

  const out = [];
  for (const p of ACTIVE_PLATFORMS) {
    const publishedToday = rows.find((r) => r.platform === p.id)?.c || 0;
    let reported = null;
    const adapter = getAdapter(p.id);
    if (adapter?.remainingQuota && !isMock()) {
      const acc = db.prepare('SELECT * FROM accounts WHERE platform = ? LIMIT 1').get(p.id);
      const creds = json(acc?.tokens || '{}');
      if (acc && adapter.isConfigured(creds).ready) {
        try { reported = await adapter.remainingQuota(creds); } catch {}
      }
    }
    out.push({
      id: p.id,
      name: p.name,
      color: p.color,
      capDaily: p.limits.dailyPosts || null,
      publishedToday,
      reported,
      note: QUOTA_NOTES[p.id] || '',
    });
  }
  res.json(out);
});

app.post('/api/admin/settings', adminGate, (req, res) => {
  const { mockMode, publicBaseUrl: base } = req.body;
  if (typeof mockMode === 'boolean') setSetting('mock_mode', mockMode ? '1' : '0');
  if (typeof base === 'string') setSetting('public_base_url', base);
  res.json({ mockMode: isMock(), publicBaseUrl: publicBaseUrl() });
});

app.post('/api/accounts/:id/test', adminGate, async (req, res) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const adapter = getAdapter(row.platform);
  if (!adapter?.test) return res.json({ ok: false, error: 'This platform has no connection test.' });
  const creds = json(row.tokens) || {};
  res.json(await adapter.test(creds));
});

// ---------------------------------------------------------------- custom fonts

const FONTS_DIR = path.join(ROOT, 'data', 'fonts');
fs.mkdirSync(FONTS_DIR, { recursive: true });
app.use('/fonts', express.static(FONTS_DIR));

/**
 * Custom fonts are registered in BOTH renderers so WYSIWYG survives:
 *   browser  -> FontFace API from /fonts/<file>
 *   server   -> node-canvas registerFont() at boot and on upload
 * Family name = file basename, so a scene's fontFamily resolves identically
 * in the editor and in the 3am headless render.
 */
const { registerFont } = await import('canvas');
const fontList = [];
function scanFonts() {
  fontList.length = 0;
  for (const f of fs.readdirSync(FONTS_DIR)) {
    if (!/\.(ttf|otf|woff2?)$/i.test(f)) continue;
    const family = f.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[_-]+/g, ' ');
    try {
      registerFont(path.join(FONTS_DIR, f), { family });
      fontList.push({ family, filename: f, url: `/fonts/${f}` });
    } catch (err) {
      console.warn(`[fonts] could not register ${f}: ${err.message}`);
    }
  }
  return fontList;
}
scanFonts();

app.get('/api/fonts', (req, res) => res.json(fontList));

app.post('/api/fonts', upload.single('font'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No font file received.' });
  if (!/\.(ttf|otf|woff2?)$/i.test(req.file.originalname)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Only ttf / otf / woff / woff2 are supported.' });
  }
  // Move into FONTS_DIR under a clean name (no timestamp prefix) so the
  // derived family name is just the file name; -2, -3... on collision.
  const safeName = path.basename(req.file.originalname).replace(/[^\w.\-]+/g, '_');
  let dest = path.join(FONTS_DIR, safeName);
  for (let n = 2; fs.existsSync(dest); n++) {
    dest = path.join(FONTS_DIR, safeName.replace(/(\.\w+)$/, `-${n}$1`));
  }
  try {
    fs.renameSync(req.file.path, dest);
  } catch {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
  }
  scanFonts();
  res.json(fontList);
});

// ---- post-publish analytics (item 7) ------------------------------------
app.get('/api/stats/posts', (req, res) => {
  res.json(listStatsPosts());
});

app.get('/api/stats/post', async (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: 'Query param id (post id) is required.' });
  try {
    const out = await getPostStats(id, { refresh: req.query.refresh === '1' });
    if (!out) return res.status(404).json({ error: `No post #${id}.` });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mockMode: isMock(),
    time: now(),
    counts: {
      accounts: db.prepare('SELECT COUNT(*) c FROM accounts').get().c,
      posts: db.prepare('SELECT COUNT(*) c FROM posts').get().c,
      jobsQueued: db.prepare(`SELECT COUNT(*) c FROM jobs WHERE state IN ('queued','retry','running')`).get().c,
    },
  });
});

const PORT = Number(process.env.PORT || 4321);
seedIfEmpty();
// Credentials kept in host environment variables (survive a filesystem reset).
const seeded = seedAccountsFromEnv();
if (seeded.length) console.log(`[seed] accounts restored from environment: ${seeded.join(', ')}`);
if (seeded.length && isMock()) {
  console.log('[seed] NOTE: simulation mode is still ON — set MOCK_MODE=0 to publish for real.');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Amplify listening on http://0.0.0.0:${PORT}`);
  console.log(`  Mode: ${isMock() ? 'SIMULATION (no API keys needed — publishes are simulated)' : 'LIVE'}`);
  console.log(`  Platforms: ${ACTIVE_PLATFORMS.map((p) => p.name).join(', ')}\n`);
  startQueue();
});
