import {
  initDesigner, applyTemplate, setPreset, addTextLayer, addImageLayer, selectLayer,
  getSelected, updateSelected, moveSelected, deleteSelected, setBackground,
  getScene, setScene, exportPNG, PRESETS, TEMPLATES, getActiveTemplate,
  undo, redo, historyState,
} from './designer.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  platforms: [],
  blocked: [],
  accounts: [],
  posts: [],
  jobs: [],
  mockMode: true,
  selectedAccounts: new Set(),
  currentPostId: null,
  preset: PRESETS[0],
  library: [],
  attached: [],
  fonts: [],
  statsPosts: [],
  statsPostId: null,
  statsDetail: null,
};

const api = {
  get: (u) => fetch(u).then((r) => r.json()),
  send: (u, method, body) =>
    fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }),
};

function toast(title, msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b></b>${msg ? '<p></p>' : ''}`;
  el.querySelector('b').textContent = title;
  if (msg) el.querySelector('p').textContent = msg;
  $('#toast-host').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (t ? new Date(t.replace(' ', 'T') + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const plat = (id) => state.platforms.find((p) => p.id === id) || state.blocked.find((p) => p.id === id) || { name: id, color: '#888' };

/** The DB stores UTC. A datetime-local input needs the browser's LOCAL wall
 *  clock, otherwise an edit silently shifts the schedule by the UTC offset. */
const toLocalInputValue = (utc) => {
  if (!utc) return '';
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ================================================================ tabs

$$('#tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'queue') loadJobs();
    if (b.dataset.tab === 'accounts') loadAccounts();
    if (b.dataset.tab === 'admin') loadAdmin();
    if (b.dataset.tab === 'calendar') renderCalendar();
    if (b.dataset.tab === 'stats') loadStats();
  }),
);

// ================================================================ designer UI

function buildPresetSelect() {
  $('#preset').innerHTML = PRESETS.map(
    (p, i) => `<option value="${i}">${esc(p.label)} · ${p.w}×${p.h}</option>`,
  ).join('');
  $('#preset').addEventListener('change', (e) => {
    state.preset = PRESETS[Number(e.target.value)];
    setPreset(state.preset);
  });
}

function buildTemplates() {
  $('#templates').innerHTML = TEMPLATES.map((t) => {
    const bg =
      t.bg.type === 'gradient'
        ? `linear-gradient(135deg, ${t.bg.stops[0].color}, ${t.bg.stops[t.bg.stops.length - 1].color})`
        : t.bg.color;
    return `<button data-tpl="${t.id}" style="background:${bg}" title="${esc(t.label)}"><span>${esc(t.label)}</span></button>`;
  }).join('');
  $$('#templates button').forEach((b) =>
    b.addEventListener('click', () => {
      const tpl = TEMPLATES.find((t) => t.id === b.dataset.tpl);
      applyTemplate(tpl, state.preset);
      syncTemplateActive();
      syncBgInputs();
    }),
  );
  syncTemplateActive();
}

function syncTemplateActive() {
  $$('#templates button').forEach((b) => b.classList.toggle('active', b.dataset.tpl === getActiveTemplate()));
}

function syncBgInputs() {
  const s = getScene();
  if (!s) return;
  $('#bg-type').value = s.background.type;
  if (s.background.type === 'gradient') {
    $('#bg-color-1').value = s.background.stops[0].color;
    $('#bg-color-2').value = s.background.stops[s.background.stops.length - 1].color;
  } else {
    $('#bg-color-1').value = s.background.color.startsWith('#') ? s.background.color : '#0f172a';
  }
}

$('#bg-type').addEventListener('change', (e) => {
  const type = e.target.value;
  if (type === 'solid') setBackground({ type: 'solid', color: $('#bg-color-1').value });
  else setBackground({ type: 'gradient', stops: [{ at: 0, color: $('#bg-color-1').value }, { at: 1, color: $('#bg-color-2').value }] });
});
$('#bg-color-1').addEventListener('input', () => {
  const s = getScene();
  if (s.background.type === 'gradient') setBackground({ stops: [{ at: 0, color: $('#bg-color-1').value }, { at: 1, color: s.background.stops[1].color }] });
  else setBackground({ color: $('#bg-color-1').value });
});
$('#bg-color-2').addEventListener('input', () => {
  const s = getScene();
  if (s.background.type === 'gradient') setBackground({ stops: [{ at: 0, color: s.background.stops[0].color }, { at: 1, color: $('#bg-color-2').value }] });
});

$('#add-text').addEventListener('click', addTextLayer);

$('#image-input').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('files', f);
  const res = await fetch('/api/media', { method: 'POST', body: fd });
  const saved = await res.json().catch(() => null);
  if (!Array.isArray(saved) || !saved.length) return toast('Upload failed', 'The image could not be stored.', 'err');
  // The scene stores the SERVER url, so the headless renderer and the
  // platform APIs can both reach the exact same file later.
  await addImageLayer(saved[0].url);
  toast('Image added', 'Stored in your media library. Drag to move, scroll to resize.', 'ok');
});

$('#export-png').addEventListener('click', async () => {
  const blob = await exportPNG();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `amplify-poster-${state.preset.id}-${Date.now()}.png`;
  a.click();
  toast('Poster exported', `${state.preset.w}×${state.preset.h} PNG`, 'ok');
});

function renderLayerList() {
  const s = getScene();
  if (!s) return;
  const sel = getSelected();
  $('#layer-list').innerHTML = s.layers
    .map((l, i) => {
      const name = l.type === 'text' ? (l.text || 'Text').slice(0, 26) : l.type === 'image' ? 'Image' : 'Shape';
      return `<div class="layer-item ${i === sel ? 'active' : ''}" data-i="${i}">
        <span class="lname">${esc(name)}</span>
        <button class="lbtn" data-act="up" title="Forward">▲</button>
        <button class="lbtn" data-act="down" title="Backward">▼</button>
        <button class="lbtn" data-act="hide" title="Hide/show">${l.hidden ? '◌' : '●'}</button>
        <button class="lbtn" data-act="del" title="Delete">✕</button>
      </div>`;
    })
    .join('') || '<p class="muted small">No layers yet.</p>';

  $$('#layer-list .layer-item').forEach((row) => {
    const i = Number(row.dataset.i);
    row.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return selectLayer(i);
      e.stopPropagation();
      selectLayer(i);
      if (act === 'up') moveSelected(1);
      if (act === 'down') moveSelected(-1);
      if (act === 'del') deleteSelected();
      if (act === 'hide') updateSelected({ hidden: !getScene().layers[i].hidden });
    });
  });
}

const num = (label, key, value, step, min, max) =>
  `<div><label>${label}</label><input type="number" data-k="${key}" value="${value}" step="${step}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''}></div>`;

function renderEditor() {
  const s = getScene();
  const i = getSelected();
  if (!s || i < 0 || !s.layers[i]) {
    $('#layer-editor').innerHTML = '<p class="muted small">Select a layer to edit it.</p>';
    return;
  }
  const l = s.layers[i];
  const fs = typeof l.fontSize === 'number' ? +(l.fontSize * 1000).toFixed(1) : 50;

  let html = '';
  if (l.type === 'text') {
    html += `<textarea data-k="text" rows="3" class="input-sm">${esc(l.text || '')}</textarea>`;
    const fontOpts = [
      ['', 'System default'],
      ['Georgia, "Times New Roman", serif', 'Serif'],
      ['"Courier New", "Nimbus Mono PS", monospace', 'Monospace'],
      ...state.fonts.map((f) => [f.family, f.family]),
    ];
    html += `<div><label>Font</label><select data-k="fontFamily" class="input-sm">
      ${fontOpts.map(([v, label]) => `<option value="${esc(v)}" ${(l.fontFamily || '') === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
    </select></div>`;
    html += `<div class="le-row">${num('Size ‰', 'fontSize', fs, 1, 5, 400)}
      <div><label>Weight</label><select data-k="fontWeight" class="input-sm">
        ${[400, 500, 600, 700, 800, 900].map((w) => `<option ${l.fontWeight === w ? 'selected' : ''}>${w}</option>`).join('')}
      </select></div></div>`;
    html += `<div class="le-row">
      <div><label>Align</label><select data-k="align" class="input-sm">
        ${['left', 'center', 'right'].map((a) => `<option ${(l.align || 'left') === a ? 'selected' : ''}>${a}</option>`).join('')}
      </select></div>
      <div><label>Vertical</label><select data-k="vAlign" class="input-sm">
        ${['top', 'middle', 'bottom'].map((a) => `<option ${(l.vAlign || 'top') === a ? 'selected' : ''}>${a}</option>`).join('')}
      </select></div></div>`;
    html += `<div class="le-row"><div><label>Colour</label><input type="color" data-k="color" value="${/^#/.test(l.color || '') ? l.color : '#ffffff'}" class="swatch" style="width:100%"></div>
      ${num('Line ht', 'lineHeight', l.lineHeight ?? 1.22, 0.02, 0.8, 3)}</div>`;
    html += `<div class="le-row"><div><label>Outline width</label><input type="number" data-k="strokeWidth" value="${l.stroke?.width || 0}" step="1" min="0" max="24" class="input-sm"></div>
      <div><label>Outline colour</label><input type="color" data-k="strokeColor" value="${l.stroke?.color || '#000000'}" class="swatch" style="width:100%"></div></div>`;
  } else {
    html += `<div class="le-row">
      <div><label>Fill</label><input type="color" data-k="fillColor" value="${/^#/.test(l.fill?.color || '') ? l.fill.color : '#000000'}" class="swatch" style="width:100%"></div>
      ${num('Corner r', 'radius', l.radius || 0, 2, 0, 400)}</div>`;
    if (l.type === 'image') {
      html += `<div class="le-row">${num('Focal X', 'focalX', (l.focalX ?? 0.5).toFixed(2), 0.05, 0, 1)}${num('Focal Y', 'focalY', (l.focalY ?? 0.5).toFixed(2), 0.05, 0, 1)}</div>`;
    }
  }
  html += `<div class="le-row">${num('X', 'x', +(l.x ?? 0).toFixed(3), 0.01)}${num('Y', 'y', +(l.y ?? 0).toFixed(3), 0.01)}</div>`;
  html += `<div class="le-row">${num('W', 'w', +(l.w ?? 1).toFixed(3), 0.01)}${num('H', 'h', +(l.h ?? 1).toFixed(3), 0.01)}</div>`;
  html += num('Opacity %', 'opacity', Math.round((l.opacity ?? 1) * 100), 5, 0, 100);

  $('#layer-editor').innerHTML = html;

  $$('#layer-editor [data-k]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.k;
      const v = el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      const patch = {};

      if (k === 'text' || k === 'align' || k === 'vAlign' || k === 'fontFamily') patch[k] = v;
      else if (k === 'fontSize') patch.fontSize = v / 1000;
      else if (k === 'fontWeight') patch.fontWeight = Number(v);
      else if (k === 'lineHeight') patch.lineHeight = v;
      else if (k === 'color') patch.color = v;
      else if (k === 'x' || k === 'y' || k === 'w' || k === 'h') patch[k] = v;
      else if (k === 'opacity') patch.opacity = v / 100;
      else if (k === 'radius') patch.radius = v;
      else if (k === 'focalX' || k === 'focalY') patch[k] = v;
      else if (k === 'fillColor') patch.fill = { ...(l.fill || {}), color: v };
      else if (k === 'strokeWidth') patch.stroke = v > 0 ? { ...(l.stroke || {}), width: v, color: l.stroke?.color || '#000000' } : null;
      else if (k === 'strokeColor') patch.stroke = l.stroke?.width ? { ...l.stroke, color: v } : null;

      updateSelected(patch);
    });
  });
}

// ================================================================ targets

/**
 * What will actually be published as media:
 *   attachments (in click order) win; otherwise the designer poster; otherwise nothing.
 */
function composeMedia() {
  if (state.attached.length) return state.attached;
  const scene = getScene();
  if (scene && scene.layers?.length) {
    return [{ type: 'image', filename: 'poster', width: scene.width, height: scene.height, mime: 'image/jpeg', bytes: 250000 }];
  }
  return [];
}

async function loadLibrary() {
  state.library = await api.get('/api/media');
  renderLibrary();
}

function renderLibrary() {
  $('#attach-count').textContent = state.attached.length
    ? `· ${state.attached.length} attached${state.attached.length > 1 ? ' — will publish as a carousel' : ''}`
    : '· none — designer poster will be used';

  $('#media-library').innerHTML =
    state.library
      .map((m) => {
        const order = state.attached.findIndex((a) => a.id === m.id);
        const thumb = m.type === 'video'
          ? `<div class="vidtag">VIDEO</div>`
          : `<img src="${esc(m.url)}" alt="${esc(m.filename)}" loading="lazy">`;
        return `<button class="lib-item ${order >= 0 ? 'attached' : ''}" data-id="${m.id}" title="${esc(m.filename)} · ${m.width || '?'}×${m.height || '?'} · ${((m.bytes || 0) / 1024).toFixed(0)} KB">
          ${thumb}
          ${order >= 0 ? `<span class="ord">${order + 1}</span>` : ''}
          <span class="del" data-del="${m.id}" title="Delete from library">✕</span>
        </button>`;
      })
      .join('') || '<p class="muted small lib-empty">Library is empty — upload images or videos to attach them to posts.</p>';

  $$('#media-library .lib-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset?.del) return;
      const id = Number(el.dataset.id);
      const item = state.library.find((m) => m.id === id);
      const at = state.attached.findIndex((a) => a.id === id);
      if (at >= 0) state.attached.splice(at, 1);
      else state.attached.push(item);
      renderLibrary();
      renderTargets();
      renderCharCounts();
    });
  });

  $$('#media-library .del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.del);
      const m = state.library.find((x) => x.id === id);
      if (!confirm(`Delete "${m?.filename}" from the library?\nPosts that already reference it keep the reference but the file will be gone.`)) return;
      await api.send(`/api/media/${id}`, 'DELETE');
      state.attached = state.attached.filter((a) => a.id !== id);
      await loadLibrary();
      renderTargets();
      toast('Deleted', 'Removed from the media library.', 'ok');
    });
  });
}

// ---------------- custom fonts + undo/redo ----------------

async function loadFonts() {
  try {
    const fonts = await api.get('/api/fonts');
    state.fonts = Array.isArray(fonts) ? fonts : [];
  } catch {
    state.fonts = [];
  }
  for (const f of state.fonts) {
    try {
      if (document.fonts.check(`16px "${f.family}"`)) continue;
      const face = new FontFace(f.family, `url(${f.url})`);
      await face.load();
      document.fonts.add(face);
    } catch {
      /* browser couldn't parse this file — server-side render still has it */
    }
  }
  const c = $('#font-count');
  if (c) c.textContent = state.fonts.length ? `(${state.fonts.length} installed)` : '';
  renderEditor();
}

function updateHistoryButtons() {
  const h = historyState();
  $('#undo-btn').disabled = !h.undo;
  $('#redo-btn').disabled = !h.redo;
}

$('#undo-btn').addEventListener('click', () => { undo(); updateHistoryButtons(); });
$('#redo-btn').addEventListener('click', () => { redo(); updateHistoryButtons(); });

$('#font-upload').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('font', file);
  try {
    const r = await fetch('/api/fonts', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    toast('Font installed', `${file.name} is ready — pick it in the text layer editor.`, 'ok');
    await loadFonts();
  } catch (err) {
    toast('Font upload failed', err.message, 'err');
  }
});

$('#lib-upload').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  const res = await fetch('/api/media', { method: 'POST', body: fd });
  const saved = await res.json().catch(() => null);
  e.target.value = '';
  if (!Array.isArray(saved)) return toast('Upload failed', 'Could not store the files.', 'err');
  await loadLibrary();
  toast('Uploaded', `${saved.length} file(s) added to the library. Click them to attach.`, 'ok');
});

function currentPost() {
  return state.posts.find((x) => x.id === state.currentPostId) || null;
}

function renderTargets() {
  const caption = $('#caption').value;
  const post = currentPost();

  $('#target-list').innerHTML =
    state.accounts
      .map((a) => {
        const p = plat(a.platform);
        const check = validateLocal(a.platform, { text: caption, media: composeMedia() });
        const v = !check.ok ? ['v-err', 'Blocked'] : check.warnings.length ? ['v-warn', 'Caution'] : ['v-ok', 'Ready'];
        const on = state.selectedAccounts.has(a.id);

        // If this composition was already sent somewhere, show what happened
        // on THIS platform — per account, not as one global status.
        const tgt = post?.targets?.find((t) => t.account_id === a.id);
        const stateChip = tgt
          ? { published: ['v-ok', 'published'], failed: ['v-err', 'failed'], retrying: ['v-warn', 'retrying'], pending: ['v-warn', 'pending'] }[tgt.status] || null
          : null;

        return `<div class="target ${on ? 'on' : ''}" data-id="${a.id}">
          <input type="checkbox" ${on ? 'checked' : ''} data-role="pick">
          <span class="dot" style="background:${p.color}"></span>
          <span class="tname"><strong>${esc(a.displayName || a.handle)}</strong><span>${esc(p.name)} · ${esc(a.handle)} · ${a.mode}</span></span>
          ${stateChip ? `<span class="tstate ${stateChip[0]}">${stateChip[1]}</span>` : `<span class="tverdict ${v[0]}">${v[1]}</span>`}
          <button class="send-btn" data-role="send" title="Publish this composition to ${esc(p.name)} only">Send</button>
        </div>`;
      })
      .join('') || '<p class="muted small">No accounts yet — connect one in the Accounts tab.</p>';

  $$('#target-list .target [data-role="pick"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.closest('.target').dataset.id);
      cb.checked ? state.selectedAccounts.add(id) : state.selectedAccounts.delete(id);
      renderTargets();
      renderCharCounts();
    });
  });

  $$('#target-list .target [data-role="send"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = Number(btn.closest('.target').dataset.id);
      publishToAccounts([id], btn);
    });
  });

  $('#target-count').textContent = `· ${state.selectedAccounts.size} selected for bulk publish`;
}

/**
 * Per-platform publish: save the current composition (or update it), then send
 * it to exactly the given accounts. Each platform has its own button because
 * a rejection on one network must never block or delay the others.
 */
async function publishToAccounts(accountIds, btn) {
  if (btn) btn.disabled = true;
  try {
    const body = {
      text: $('#caption').value,
      scene: getScene(),
      media: state.attached,
      scheduledAt: $('#schedule-at').value ? new Date($('#schedule-at').value).toISOString() : null,
      targets: accountIds,
      publish: !$('#schedule-at').value,
    };

    const post = state.currentPostId
      ? await api.send(`/api/posts/${state.currentPostId}`, 'PATCH', body)
      : await api.send('/api/posts', 'POST', body);
    state.currentPostId = post.id;

    const names = accountIds.map((id) => plat(state.accounts.find((a) => a.id === id)?.platform).name).join(', ');

    if (post.rejected?.length) {
      toast('Blocked by platform rules', post.rejected.map((r) => `${r.name}: ${r.errors.join(' ')}`).join(' · '), 'err');
    }
    if (post.enqueued?.length || !post.rejected?.length) {
      toast(
        body.scheduledAt ? `Scheduled → ${names}` : `Sent → ${names}`,
        body.scheduledAt
          ? `Fires ${fmtTime(post.scheduled_at)} on ${names} only.`
          : `Queued on ${names} only. Other platforms untouched.`,
        'ok',
      );
    }

    await loadPosts();
    renderPosts();
    renderTargets();
    if ($('#tab-calendar').classList.contains('active')) renderCalendar();
  } catch (err) {
    toast('Failed', err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Client-side mirror of the server validator, for instant feedback. */
function validateLocal(platformId, post) {
  const p = plat(platformId);
  const errors = [], warnings = [];
  const spec = state.platforms.find((x) => x.id === platformId);
  if (!spec) return { ok: false, errors: ['Unknown platform'], warnings };

  const text = post.text || '';
  const media = post.media || [];
  const limit = spec.limits?.captionChars ?? spec.limits?.textChars;

  if (spec.constraints?.noTextOnly && media.length === 0) errors.push(`${spec.name} requires at least one image or video — text-only posts are not supported.`);
  if (limit && text.length > limit) errors.push(`Caption is ${text.length} chars — ${spec.name} allows ${limit}.`);
  if (spec.limits?.mediaMax != null && media.length > spec.limits.mediaMax) warnings.push(`${spec.name} accepts ${spec.limits.mediaMax} item(s); extras will be dropped.`);
  if (spec.constraints && media[0]?.width) {
    const ar = media[0].width / media[0].height;
    if (ar < spec.constraints.aspectMin - 0.01 || ar > spec.constraints.aspectMax + 0.01) {
      warnings.push(`${ar.toFixed(2)}:1 is outside ${spec.name}'s window — it will be center-cropped automatically at publish time.`);
    }
  }
  if (spec.supports?.video === false && media.some((m) => m.type === 'video')) errors.push(`${spec.name} does not accept video.`);
  if (platformId === 'youtube') warnings.push('Uploads stay PRIVATE until your Cloud project passes Google\u2019s audit.');
  if (platformId === 'tiktok') warnings.push('Publishing as a DRAFT to your inbox until your client passes TikTok\u2019s audit.');
  if (platformId === 'instagram' && /https?:\/\//.test(text)) warnings.push('Links in Instagram captions are not clickable.');
  if (spec.gate?.level === 'audit' || spec.gate?.level === 'condition') warnings.push(spec.gate.label);

  return { ok: errors.length === 0, errors, warnings };
}

function renderCharCounts() {
  const len = $('#caption').value.length;
  const chosen = state.accounts.filter((a) => state.selectedAccounts.has(a.id));
  const specs = [...new Set(chosen.map((a) => a.platform))]
    .map((id) => state.platforms.find((p) => p.id === id))
    .filter(Boolean);

  $('#char-counts').innerHTML = specs
    .map((p) => {
      const lim = p.limits?.captionChars ?? p.limits?.textChars ?? 0;
      return `<span class="${len > lim ? 'over' : ''}">${esc(p.name)} ${len}/${lim}</span>`;
    })
    .join('');
}

// ================================================================ compose

$('#caption').addEventListener('input', () => { renderTargets(); renderCharCounts(); });

$('#btn-precheck').addEventListener('click', runPrecheck);

async function runPrecheck() {
  const ids = [...state.selectedAccounts];
  if (!ids.length) return toast('No targets', 'Select at least one account first.', 'warn');

  const accounts = state.accounts.filter((a) => ids.includes(a.id));
  const post = { text: $('#caption').value, media: composeMedia() };

  const html = accounts
    .map((a) => {
      const c = validateLocal(a.platform, post);
      const cls = !c.ok ? 'err' : 'ok';
      const items = [...c.errors.map((e) => `<li>${esc(e)}</li>`), ...c.warnings.map((w) => `<li class="warn">${esc(w)}</li>`)].join('');
      return `<div class="precheck-item ${cls}">
        <h4><span class="dot" style="background:${plat(a.platform).color}"></span>${esc(plat(a.platform).name)} — ${esc(a.displayName)}
        <span class="tverdict ${c.ok ? (c.warnings.length ? 'v-warn' : 'v-ok') : 'v-err'}" style="margin-left:auto">${c.ok ? (c.warnings.length ? 'Publishable with caveats' : 'Clear to publish') : 'Blocked'}</span></h4>
        ${items ? `<ul>${items}</ul>` : ''}
      </div>`;
    })
    .join('');

  $('#precheck').innerHTML = html;
  const blocked = accounts.filter((a) => !validateLocal(a.platform, post).ok).length;
  toast('Pre-check done', blocked ? `${blocked} platform(s) would reject this post.` : `All ${accounts.length} target(s) accept this post.`, blocked ? 'warn' : 'ok');
}

$('#btn-save').addEventListener('click', () => savePost(false));
$('#btn-publish').addEventListener('click', () => savePost(true));

async function savePost(publish) {
  const ids = [...state.selectedAccounts];
  if (!ids.length) return toast('No targets', 'Tick at least one account to publish to.', 'warn');

  const body = {
    text: $('#caption').value,
    scene: getScene(),
    media: state.attached,
    scheduledAt: $('#schedule-at').value ? new Date($('#schedule-at').value).toISOString() : null,
    targets: ids,
    publish,
  };

  try {
    const post = state.currentPostId
      ? await api.send(`/api/posts/${state.currentPostId}`, 'PATCH', body)
      : await api.send('/api/posts', 'POST', body);

    state.currentPostId = post.id;
    await loadPosts();
    renderPosts();

    if (publish && post.rejected?.length) {
      toast('Some platforms refused it', post.rejected.map((r) => `${r.name}: ${r.errors[0]}`).join(' · '), 'err');
    }

    toast(
      body.scheduledAt ? 'Scheduled' : publish ? 'Publishing' : 'Draft saved',
      body.scheduledAt
        ? `Fires ${fmtTime(post.scheduled_at)} across ${ids.length} platform(s) — server-side, laptop can be closed.`
        : publish
          ? `Queued to ${ids.length} platform(s). Watch it in the Queue tab.`
          : `Post #${post.id} saved.`,
      'ok',
    );
    if (publish) $$('#tabs button')[1].click();
  } catch (err) {
    toast('Failed', err.message, 'err');
  }
}

function renderPosts() {
  $('#post-list').innerHTML =
    state.posts
      .map((p) => {
        const chips = [...new Set(p.targets.map((t) => t.platform))]
          .map((id) => `<span class="dot" style="background:${plat(id).color}" title="${esc(plat(id).name)}"></span>`)
          .join('');
        return `<div class="post-item" data-id="${p.id}">
          <div class="pmain">
            <div class="ptext">${esc(p.text || '(poster only)')}</div>
            <div class="pmeta">#${p.id} · ${p.scheduled_at ? 'scheduled ' + fmtTime(p.scheduled_at) : 'created ' + fmtTime(p.created_at)} · ${p.targets.length} target(s)${(p.media || []).length > 1 ? ` · ${(p.media || []).length}-item carousel` : ''}</div>
          </div>
          <div class="pplat">${chips}</div>
          <span class="badge b-${esc(p.status)}">${esc(p.status)}</span>
          <button class="btn ghost sm" data-act="open">Open</button>
          <button class="btn ghost sm" data-act="republish" title="Publish again">↻</button>
        </div>`;
      })
      .join('') || '<p class="muted small">Nothing saved yet.</p>';

  $$('#post-list .post-item').forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-act="open"]').addEventListener('click', () => openPost(id));
    row.querySelector('[data-act="republish"]').addEventListener('click', async () => {
      try {
        await api.send(`/api/posts/${id}/publish`, 'POST', {});
        toast('Re-queued', `Post #${id} is back in the queue.`, 'ok');
        loadPosts().then(renderPosts);
      } catch (e) { toast('Failed', e.message, 'err'); }
    });
  });
}

function openPost(id) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  state.currentPostId = id;
  $('#caption').value = p.text || '';
  if (p.scene) {
    setScene(p.scene);
    syncBgInputs();
  }
  $('#schedule-at').value = toLocalInputValue(p.scheduled_at);
  state.attached = (p.media || [])
    .map((m) => state.library.find((l) => l.url === m.url) || (m.id ? m : null))
    .filter(Boolean);
  state.selectedAccounts = new Set(p.targets.map((t) => t.account_id));
  renderLibrary();
  renderTargets(); renderCharCounts(); renderEditor();
  toast('Loaded', `Post #${id} (${p.status}) opened for editing.`, '');
}

// ================================================================ queue

async function loadJobs() {
  state.jobs = await api.get('/api/jobs');
  renderJobs();
}

function renderJobs() {
  const counts = { queued: 0, running: 0, retry: 0, done: 0, failed: 0 };
  state.jobs.forEach((j) => { counts[j.state] = (counts[j.state] || 0) + 1; });

  $('#job-stats').innerHTML = [
    ['Queued', counts.queued], ['Running', counts.running], ['Retrying', counts.retry],
    ['Published', counts.done], ['Failed', counts.failed],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');

  $('#job-list').innerHTML =
    state.jobs
      .map((j) => {
        const p = plat(j.platform);
        const badge = { queued: 'b-scheduled', running: 'b-queued', retry: 'b-queued', done: 'b-published', failed: 'b-failed' }[j.state];
        return `<div class="job">
          <span class="dot" style="background:${p.color}"></span>
          <div>
            <div class="jname">${esc(p.name)} <span class="muted small">· post #${j.post_id} · ${esc(j.handle)}</span></div>
            <div class="jmeta">attempt ${j.attempts}/${j.max_attempts} · ${j.state === 'retry' ? 'next try ' + fmtTime(j.not_before) : 'updated ' + fmtTime(j.updated_at)}${j.external_id ? ' · id ' + esc(j.external_id) : ''}</div>
            ${j.last_error ? `<div class="jerr">${esc(j.last_error)}</div>` : ''}
          </div>
          <span class="badge ${badge}">${esc(j.state)}</span>
          ${j.state === 'failed' ? `<button class="btn ghost sm" data-retry="${j.id}">Retry</button>` : '<span></span>'}
        </div>`;
      })
      .join('') || '<p class="muted small">Queue is empty. Compose a post and hit Publish now.</p>';

  $$('#job-list [data-retry]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api.send(`/api/jobs/${b.dataset.retry}/retry`, 'POST', {});
      toast('Retrying', 'Job re-queued with the attempt counter reset.', 'ok');
      loadJobs();
    }),
  );
}

$('#refresh-jobs').addEventListener('click', loadJobs);
setInterval(() => { if ($('#tab-queue').classList.contains('active')) loadJobs(); }, 3000);

// ================================================================ accounts

async function loadAccounts() {
  state.accounts = await api.get('/api/accounts');
  state.accounts.forEach((a) => { if (state.selectedAccounts.size === 0) state.selectedAccounts.add(a.id); });
  renderAccounts();
  renderTargets();
}

function renderAccounts() {
  const connectables = state.platforms.filter((p) => p.hasBrowserFlow);
  $('#connect-buttons').innerHTML = connectables.length
    ? connectables
        .map((p) => {
          const on = p.oauthEnvPresent;
          return `<button class="btn ghost sm" data-oauth="${p.id}" ${on ? '' : 'disabled'}
            title="${on ? `Sign in with ${esc(p.name)}` : `Server needs the ${esc(p.id)} OAuth client id env var — or paste credentials below`}">
            ${on ? 'Sign in with' : '○'} ${esc(p.name)}</button>`;
        })
        .join('') +
      '<p class="hint" style="width:100%">Browser sign-in needs the platform client id set on the server (see Admin → OAuth env). Paste-style credentials always work and are equivalent.</p>'
    : '';
  $$('#connect-buttons [data-oauth]').forEach((b) =>
    b.addEventListener('click', () => (window.location.href = `/api/oauth/${b.dataset.oauth}/start`)),
  );

  $('#account-list').innerHTML = state.accounts
    .map((a) => {
      const p = plat(a.platform);
      const creds = Object.entries(a.credentialsPresent || {})
        .map(([k, set]) => `<span class="cred ${set ? 'set' : ''}">${set ? '✓' : '○'} ${esc(k)}</span>`)
        .join('');
      const modeBadge = a.mode === 'live' ? '<span class="badge b-published">live</span>'
        : a.mode === 'mock' ? '<span class="badge b-scheduled">mock</span>'
        : '<span class="badge b-queued">no keys</span>';
      return `<div class="account">
        <div class="account-head">
          <span class="pchip" style="background:${p.color}">${esc(p.name.slice(0, 2).toUpperCase())}</span>
          <span class="aname"><strong>${esc(a.displayName || a.handle)}</strong><span>${esc(p.name)} · ${esc(a.handle)}</span></span>
          ${modeBadge}
        </div>
        <div class="cred-grid">${creds || '<span class="cred">no credentials needed</span>'}</div>
        <div class="account-foot">
          <button class="btn ghost sm" data-edit="${a.id}">Edit keys</button>
          <button class="btn ghost sm danger" data-del="${a.id}" style="margin-left:auto">Remove</button>
        </div>
      </div>`;
    })
    .join('');

  $$('#account-list [data-edit]').forEach((b) => b.addEventListener('click', () => openAccountForm(state.accounts.find((a) => a.id === Number(b.dataset.edit)))));
  $$('#account-list [data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api.send(`/api/accounts/${b.dataset.del}`, 'DELETE');
      toast('Removed', 'Account disconnected.', 'ok');
      loadAccounts();
    }),
  );
}

$('#add-account').addEventListener('click', () => openAccountForm(null));

function openAccountForm(account) {
  const panel = $('#account-form-panel');
  panel.hidden = false;
  $('#account-form-title').textContent = account ? `Edit ${plat(account.platform).name} — ${account.displayName}` : 'Connect an account';

  const options = state.platforms
    .map((p) => `<option value="${p.id}" ${account && account.platform === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');

  $('#account-form').innerHTML = `
    <div class="form-grid">
      <div class="field"><label>Platform</label>
        <select id="af-platform" ${account ? 'disabled' : ''}>${options}</select>
        <p class="hint" id="af-gate"></p>
      </div>
      <div class="field"><label>Display name</label><input id="af-name" class="input" value="${esc(account?.displayName || '')}"></div>
    </div>
    <div class="field"><label>Handle / ID</label><input id="af-handle" class="input" value="${esc(account?.handle || '')}" placeholder="@channel, page id, or URN"></div>
    <div id="af-creds" class="form-grid"></div>
    <div class="row gap-sm actions">
      <button class="btn ghost" id="af-cancel">Cancel</button>
      <button class="btn primary" id="af-save">${account ? 'Save keys' : 'Connect'}</button>
    </div>`;

  const renderCreds = () => {
    const p = state.platforms.find((x) => x.id === $('#af-platform').value);
    if (!p) return;
    $('#af-gate').textContent = `${p.gate.label} — ${p.gate.detail}`;
    $('#af-creds').innerHTML = (p.credentialFields || [])
      .map((c) => `<div class="field"><label>${esc(c.label)}${c.required ? '' : ' <span class="muted small">(optional)</span>'}</label>
        <input class="input" data-cred="${esc(c.key)}" placeholder="${esc(c.hint || '')}" type="${/secret|token/i.test(c.key) ? 'password' : 'text'}">
        ${c.hint ? `<p class="hint">${esc(c.hint)}</p>` : ''}</div>`)
      .join('') || '<p class="muted small">This platform needs no credentials in mock mode.</p>';
  };

  $('#af-platform').addEventListener('change', renderCreds);
  renderCreds();
  $('#af-cancel').addEventListener('click', () => (panel.hidden = true));

  $('#af-save').addEventListener('click', async () => {
    const platform = account ? account.platform : $('#af-platform').value;
    const credentials = {};
    $$('#af-creds [data-cred]').forEach((el) => { if (el.value.trim()) credentials[el.dataset.cred] = el.value.trim(); });

    try {
      if (account) {
        await api.send(`/api/accounts/${account.id}`, 'PATCH', { credentials, displayName: $('#af-name').value || null });
        toast('Saved', 'Credentials updated.', 'ok');
      } else {
        await api.send('/api/accounts', 'POST', {
          platform,
          handle: $('#af-handle').value.trim() || `${platform}_account`,
          displayName: $('#af-name').value.trim() || platform,
          credentials,
        });
        toast('Connected', `${plat(platform).name} account added.`, 'ok');
      }
      panel.hidden = true;
      loadAccounts();
    } catch (e) { toast('Failed', e.message, 'err'); }
  });

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ================================================================ platform reality

function renderPlatforms() {
  const gateClass = (l) => `g-${l}`;
  const tierName = { 1: 'Tier 1 — works right now', 2: 'Tier 2 — works with conditions', 3: 'Tier 3 — gated behind an audit' };

  $('#platform-cards').innerHTML = state.platforms
    .slice()
    .sort((a, b) => a.tier - b.tier)
    .map((p) => {
      const lim = Object.entries(p.limits || {})
        .filter(([k]) => !['minIntervalSec'].includes(k))
        .map(([k, v]) => `<span>${esc(k)}: ${esc(v)}</span>`)
        .join('');
      return `<div class="pcard" style="--pc:${p.color}">
        <h3><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</h3>
        <span class="tier">${esc(tierName[p.tier] || '')}</span>
        <div class="gate ${gateClass(p.gate.level)}"><b>${esc(p.gate.label)}</b><p>${esc(p.gate.detail)}</p></div>
        ${lim ? `<div class="limits">${lim}</div>` : ''}
        <p class="notes">${esc(p.notes || '')}</p>
      </div>`;
    })
    .join('');

  $('#blocked-cards').innerHTML = state.blocked
    .map((p) => `<div class="pcard blocked" style="--pc:${p.color}">
        <h3><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</h3>
        <span class="tier">Not buildable</span>
        <div class="gate ${gateClass(p.gate.level)}"><b>${esc(p.gate.label)}</b><p>${esc(p.gate.detail)}</p></div>
        <p class="notes">${esc(p.notes || '')}</p>
      </div>`)
    .join('');
}

// ================================================================ calendar

state.calOffset = 0;

const localDayKey = (utc) => {
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function renderCalendar() {
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + state.calOffset);
  const y = base.getFullYear();
  const m = base.getMonth();
  $('#cal-label').textContent = base.toLocaleString([], { month: 'long', year: 'numeric' });

  const byDay = new Map();
  for (const post of state.posts) {
    const when = post.scheduled_at || post.created_at;
    const key = localDayKey(when);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(post);
  }

  const startDow = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
  const gridStart = new Date(y, m, 1 - startDow);
  const todayKey = localDayKey(new Date().toISOString());
  const statusColor = { scheduled: '#22d3ee', queued: '#fbbf24', published: '#34d399', partial: '#fbbf24', failed: '#f87171', draft: '#6f7896' };

  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const p2 = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const items = (byDay.get(key) || []).slice().sort((a, b) => (a.scheduled_at || a.created_at).localeCompare(b.scheduled_at || b.created_at));
    const shown = items.slice(0, 3);
    html += `<div class="cal-cell ${d.getMonth() !== m ? 'other' : ''} ${key === todayKey ? 'today' : ''}">
      <span class="cal-day">${d.getDate()}</span>
      ${shown
        .map((post) => {
          const t = (post.scheduled_at || post.created_at).slice(11, 16);
          const label = post.text ? post.text.slice(0, 22) : '(poster only)';
          return `<button class="cal-chip" data-post="${post.id}" style="--sc:${statusColor[post.status] || '#6366f1'}" title="#${post.id} · ${post.status} · ${esc(post.text || '(poster only)')}">${t} ${esc(label)}</button>`;
        })
        .join('')}
      ${items.length > 3 ? `<span class="cal-more">+${items.length - 3} more</span>` : ''}
    </div>`;
  }
  $('#cal-grid').innerHTML = html;

  $$('#cal-grid .cal-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#tabs button')[0].click();
      openPost(Number(chip.dataset.post));
    }),
  );
}

$('#cal-prev').addEventListener('click', () => { state.calOffset -= 1; renderCalendar(); });
$('#cal-next').addEventListener('click', () => { state.calOffset += 1; renderCalendar(); });
$('#cal-today').addEventListener('click', () => { state.calOffset = 0; renderCalendar(); });

// ================================================================ admin

let adminPass = sessionStorage.getItem('amplify_admin_pass') || '';

async function adminFetch(url, method, body) {
  const res = await fetch(url, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-admin-passcode': adminPass },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    adminPass = prompt('Admin passcode:') || '';
    sessionStorage.setItem('amplify_admin_pass', adminPass);
    return adminFetch(url, method, body);
  }
  return res.json();
}

async function loadAdmin() {
  const st = await adminFetch('/api/admin/status');
  if (!st || st.error) return toast('Admin locked', st?.error || 'Unavailable', 'err');

  const badge = $('#admin-mode-badge');
  badge.textContent = st.mockMode ? 'simulation on' : 'LIVE';
  badge.className = 'badge ' + (st.mockMode ? 'b-scheduled' : 'b-published');

  $('#mock-toggle').checked = st.mockMode;
  $('#public-base-url').value = st.publicBaseUrl || '';

  $('#admin-queue').innerHTML = [
    ['Outstanding', st.queue.outstanding], ['Published', st.queue.done], ['Failed', st.queue.failed],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');

  $('#admin-env').innerHTML = Object.entries(st.env)
    .map(([k, set]) => `<span class="cred ${set ? 'set' : ''}">${set ? '✓' : '○'} ${esc(k)}</span>`)
    .join('');

  renderAdminTests();
  renderQuotas();
}

async function renderQuotas() {
  const rows = await adminFetch('/api/admin/quotas');
  if (!Array.isArray(rows)) return;
  $('#admin-quotas').innerHTML = rows
    .map((r) => {
      const cap = r.capDaily || 0;
      const pct = cap ? Math.min(100, Math.round((r.publishedToday / cap) * 100)) : 0;
      const hot = pct >= 80;
      const reported = r.reported
        ? `<span class="cred set">platform: ${r.reported.used}/${r.reported.total} in rolling window</span>`
        : '';
      return `<div class="quota-row">
        <div class="quota-head">
          <span class="dot" style="background:${r.color}"></span>${esc(r.name)}
          ${reported}
          <span class="qnum">${r.publishedToday} published today${cap ? ` / budget ${cap}` : ''}</span>
        </div>
        ${cap ? `<div class="quota-bar"><i class="${hot ? 'hot' : ''}" style="width:${Math.max(2, pct)}%"></i></div>` : ''}
        <div class="quota-note">${esc(r.note)}</div>
      </div>`;
    })
    .join('');
}

function renderAdminTests() {
  $('#admin-tests').innerHTML = state.accounts
    .map((a) => {
      const p = plat(a.platform);
      const filled = Object.values(a.credentialsPresent || {}).filter(Boolean).length;
      return `<div class="admin-test" data-id="${a.id}">
        <span class="dot" style="background:${p.color}"></span>
        <div>
          <div class="at-name">${esc(a.displayName || a.handle)} <span class="muted small">· ${esc(p.name)}</span></div>
          <div class="at-sub">${filled ? `${filled} credential field(s) filled` : 'no credentials yet'} · mode: ${esc(a.mode)}</div>
        </div>
        <button class="btn ghost sm" data-test="${a.id}">Test connection</button>
        <div class="at-result"></div>
      </div>`;
    })
    .join('') || '<p class="muted small">No accounts.</p>';

  $$('#admin-tests [data-test]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.test;
      const box = btn.closest('.admin-test').querySelector('.at-result');
      box.className = 'at-result show busy';
      box.textContent = 'Contacting the platform…';
      btn.disabled = true;
      try {
        const r = await adminFetch(`/api/accounts/${id}/test`, 'POST', {});
        box.className = `at-result show ${r.ok ? 'ok' : 'err'}`;
        box.textContent = r.ok ? r.detail : r.error;
      } catch (e) {
        box.className = 'at-result show err';
        box.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    }),
  );
}

$('#mock-toggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  await adminFetch('/api/admin/settings', 'POST', { mockMode: on });
  const badge = $('#admin-mode-badge');
  badge.textContent = on ? 'simulation on' : 'LIVE';
  badge.className = 'badge ' + (on ? 'b-scheduled' : 'b-published');
  toast(on ? 'Simulation on' : 'LIVE MODE', on
    ? 'Publishes are simulated again.'
    : 'Real API calls from now on. Only accounts with complete, tested credentials will publish.', on ? 'warn' : 'ok');
  loadAccounts();
});

$('#save-settings').addEventListener('click', async () => {
  await adminFetch('/api/admin/settings', 'POST', { publicBaseUrl: $('#public-base-url').value.trim() });
  toast('Settings saved', 'New posters will use this base URL for platform-side media fetches.', 'ok');
});

// ================================================================ stats

const METRIC_LABELS = [
  ['views', 'Views'],
  ['reach', 'Reach'],
  ['likes', 'Likes'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['saved', 'Saves'],
];

const fmtNum = (n) =>
  n == null
    ? '—'
    : n >= 1e6
      ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
      : n >= 1000
        ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
        : String(n);

async function loadStats(selectId = null) {
  try {
    state.statsPosts = await api.get('/api/stats/posts');
    if (!Array.isArray(state.statsPosts)) state.statsPosts = [];
  } catch {
    state.statsPosts = [];
  }
  const pick = selectId ?? state.statsPostId ?? state.statsPosts[0]?.id ?? null;
  if (pick && state.statsPosts.some((p) => p.id === pick)) {
    await selectStatsPost(pick);
  } else {
    state.statsPostId = null;
    state.statsDetail = null;
    renderStatsPosts();
    renderStatsDetail();
  }
}

function renderStatsPosts() {
  $('#stats-posts').innerHTML =
    state.statsPosts
      .map((p) => {
        const chips = p.platforms
          .map((id) => `<span class="dot" style="background:${plat(id).color}" title="${esc(plat(id).name)}"></span>`)
          .join('');
        return `<div class="stats-post ${p.id === state.statsPostId ? 'active' : ''}" data-id="${p.id}">
          <div class="sp-text">${esc((p.text || '(poster only)').slice(0, 90))}</div>
          <div class="sp-meta">#${p.id} · published ${p.published_at ? fmtTime(p.published_at) : '—'} <span class="sp-chips">${chips}</span></div>
        </div>`;
      })
      .join('') || '<p class="muted small">No published posts yet — publish something in Compose first.</p>';
  $$('#stats-posts .stats-post').forEach((row) =>
    row.addEventListener('click', () => selectStatsPost(Number(row.dataset.id))),
  );
}

async function selectStatsPost(id) {
  state.statsPostId = id;
  renderStatsPosts();
  $('#stats-detail').innerHTML = '<p class="muted small">Fetching stats…</p>';
  try {
    state.statsDetail = await api.get(`/api/stats/post?id=${id}`);
  } catch (e) {
    state.statsDetail = null;
    $('#stats-detail').innerHTML = `<p class="muted small">Could not load stats: ${esc(e.message)}</p>`;
    return;
  }
  renderStatsDetail();
}

function renderStatsDetail() {
  const d = state.statsDetail;
  if (!d) {
    $('#stats-detail').innerHTML = '<p class="muted small">Pick a published post.</p>';
    return;
  }
  const totals = METRIC_LABELS.filter(([k]) => d.totals[k] != null)
    .map(([k, label]) => `<div class="sc-metric"><b>${fmtNum(d.totals[k])}</b><span>${label}</span></div>`)
    .join('');
  const cards = d.targets
    .map((t) => {
      const meta = plat(t.platform);
      const nums = METRIC_LABELS.filter(([k]) => t.metrics?.[k] != null)
        .map(([k, label]) => `<div class="sc-metric"><b>${fmtNum(t.metrics[k])}</b><span>${label}</span></div>`)
        .join('');
      const url = t.metrics?.url
        ? `<a class="sc-link" href="${esc(t.metrics.url)}" target="_blank" rel="noopener">View post ↗</a>`
        : '';
      const foot = t.error
        ? `<span class="sc-err">${esc(t.error)}</span>`
        : esc(t.note || (t.mock ? 'Simulated numbers' : 'Live platform data'));
      return `<div class="stat-card ${t.supported ? '' : 'off'}">
        <div class="sc-head"><span class="dot" style="background:${meta.color}"></span>${esc(meta.name)}
          <span class="muted small">· ${esc(t.accountLabel || '')}${t.cached ? ' · cached' : ''}</span></div>
        <div class="sc-metrics">${nums || '<span class="muted small">No metrics available.</span>'}</div>
        <div class="sc-foot small">${foot}${url}</div>
      </div>`;
    })
    .join('');
  $('#stats-detail').innerHTML = `
    <div class="stat-card totals">
      <div class="sc-head"><b>Post #${d.post.id} — all platforms</b>
        <span class="muted small">· ${esc((d.post.text || '(poster only)').slice(0, 60))}</span></div>
      <div class="sc-metrics">${totals || '<span class="muted small">No numbers yet.</span>'}</div>
    </div>
    <div class="stat-cards">${cards}</div>`;
}

$('#stats-refresh').addEventListener('click', async () => {
  if (!state.statsPostId) return toast('Nothing selected', 'Pick a published post first.', 'err');
  $('#stats-detail').innerHTML = '<p class="muted small">Refreshing from platforms…</p>';
  try {
    state.statsDetail = await api.get(`/api/stats/post?id=${state.statsPostId}&refresh=1`);
    renderStatsDetail();
    toast('Stats refreshed', 'Numbers re-fetched (bypasses the 10-minute cache).', 'ok');
  } catch (e) {
    renderStatsDetail();
    toast('Refresh failed', e.message, 'err');
  }
});

// ================================================================ boot

async function loadPosts() { state.posts = await api.get('/api/posts'); }

async function boot() {
  // Returned from an OAuth callback redirect?
  const oauth = new URLSearchParams(location.search);
  if (oauth.get('oauth') === 'ok') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() =>
      toast('Account connected', `${oauth.get('n')} ${plat(oauth.get('platform')).name} account(s) added via browser sign-in.`, 'ok'), 400);
  }

  const data = await api.get('/api/platforms');
  state.platforms = data.active;
  state.blocked = data.blocked;
  state.mockMode = data.mockMode;

  const badge = $('#mode-badge');
  badge.textContent = data.mockMode ? 'mock mode — no API keys needed' : 'live mode';
  badge.classList.toggle('live', !data.mockMode);

  buildPresetSelect();

  initDesigner({
    onChange: () => { renderTargets(); updateHistoryButtons(); },
    renderLayerList,
    renderEditor,
  });
  await loadFonts();
  updateHistoryButtons();

  buildTemplates();
  syncBgInputs();
  renderPlatforms();

  await loadAccounts();
  await loadLibrary();
  await loadPosts();
  renderPosts();
  renderCharCounts();

  toast(
    data.mockMode ? 'Running in mock mode' : 'Running live',
    data.mockMode
      ? 'Every publish is simulated — including occasional transient failures, so you can watch the retry and backoff logic work. Add real keys in Accounts and restart with MOCK_MODE=0 to go live.'
      : 'Publishing will hit the real APIs.',
    data.mockMode ? 'warn' : 'ok',
  );
}

boot().catch((e) => toast('Startup error', e.message, 'err'));
