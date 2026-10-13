/**
 * Poster designer.
 *
 * The drawing code here deliberately mirrors server/render-scene.js line for
 * line: same wrap algorithm, same aspect-fill focal logic, same gradient and
 * shadow handling. That guarantee is what makes "what you see is what gets
 * published" true even when a scheduled post renders headlessly at 3am.
 */

export const PRESETS = [
  { id: 'square', label: 'Square 1:1', hint: 'FB / IG / LinkedIn feed', w: 1080, h: 1080 },
  { id: 'portrait', label: 'Portrait 4:5', hint: 'IG / FB — biggest feed footprint', w: 1080, h: 1350 },
  { id: 'landscape', label: 'Landscape 1.91:1', hint: 'FB / LinkedIn link post', w: 1200, h: 628 },
  { id: 'story', label: 'Story / Reel 9:16', hint: 'IG Story, Reel, TikTok, Shorts', w: 1080, h: 1920 },
  { id: 'youtube', label: 'YouTube 16:9', hint: 'Thumbnail / video frame', w: 1280, h: 720 },
];

export const TEMPLATES = [
  {
    id: 'bold-offer',
    label: 'Offer',
    bg: { type: 'gradient', stops: [{ at: 0, color: '#4f46e5' }, { at: 1, color: '#9333ea' }] },
    layers: [
      { type: 'rect', x: 0, y: 0.74, w: 1, h: 0.26, fill: { color: 'rgba(0,0,0,0.28)' } },
      { type: 'text', text: 'Up to 40% off', x: 0.07, y: 0.16, w: 0.86, h: 0.2, fontSize: 0.088, fontWeight: 800, color: '#ffffff', align: 'left', shadow: { blur: 22, offsetY: 6, color: 'rgba(0,0,0,.35)' } },
      { type: 'text', text: 'This weekend only', x: 0.07, y: 0.3, w: 0.86, h: 0.14, fontSize: 0.052, fontWeight: 500, color: 'rgba(255,255,255,.9)', align: 'left' },
      { type: 'text', text: 'SHOP NOW', x: 0.07, y: 0.815, w: 0.5, h: 0.08, fontSize: 0.036, fontWeight: 800, color: '#ffffff', align: 'left' },
    ],
  },
  {
    id: 'quote',
    label: 'Quote',
    bg: { type: 'solid', color: '#0f172a' },
    layers: [
      { type: 'rect', x: 0.08, y: 0.2, w: 0.008, h: 0.42, fill: { color: '#22d3ee' } },
      { type: 'text', text: 'Simplicity is the ultimate sophistication.', x: 0.13, y: 0.22, w: 0.78, h: 0.4, fontSize: 0.062, fontWeight: 600, color: '#e8ebf5', align: 'left', lineHeight: 1.3 },
      { type: 'text', text: '— Leonardo da Vinci', x: 0.13, y: 0.66, w: 0.7, h: 0.06, fontSize: 0.03, fontWeight: 500, color: '#98a1bd', align: 'left' },
    ],
  },
  {
    id: 'event',
    label: 'Event',
    bg: { type: 'gradient', stops: [{ at: 0, color: '#f97316' }, { at: 1, color: '#db2777' }] },
    layers: [
      { type: 'text', text: 'LIVE', x: 0.07, y: 0.12, w: 0.3, h: 0.06, fontSize: 0.032, fontWeight: 800, color: 'rgba(255,255,255,.85)', align: 'left' },
      { type: 'text', text: 'Webinar:\nGrowing on Social', x: 0.07, y: 0.2, w: 0.86, h: 0.34, fontSize: 0.082, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.12, shadow: { blur: 20, offsetY: 5, color: 'rgba(0,0,0,.3)' } },
      { type: 'rect', x: 0.07, y: 0.63, w: 0.86, h: 0.002, fill: { color: 'rgba(255,255,255,.4)' } },
      { type: 'text', text: 'Thursday · 8:00 PM Cairo', x: 0.07, y: 0.67, w: 0.86, h: 0.07, fontSize: 0.042, fontWeight: 600, color: '#ffffff', align: 'left' },
    ],
  },
  {
    id: 'product',
    label: 'Product',
    bg: { type: 'solid', color: '#f5f5f4' },
    layers: [
      { type: 'rect', x: 0, y: 0.62, w: 1, h: 0.38, fill: { color: '#111827' } },
      { type: 'text', text: 'New arrival', x: 0.07, y: 0.7, w: 0.86, h: 0.08, fontSize: 0.052, fontWeight: 800, color: '#ffffff', align: 'left' },
      { type: 'text', text: 'Handmade in Egypt', x: 0.07, y: 0.81, w: 0.86, h: 0.06, fontSize: 0.03, fontWeight: 500, color: '#98a1bd', align: 'left' },
    ],
  },
  {
    id: 'announce',
    label: 'Announce',
    bg: { type: 'gradient', stops: [{ at: 0, color: '#059669' }, { at: 1, color: '#0d9488' }] },
    layers: [
      { type: 'text', text: 'We are live.', x: 0.5, y: 0.38, w: 0.86, h: 0.16, fontSize: 0.095, fontWeight: 800, color: '#ffffff', align: 'center', shadow: { blur: 26, offsetY: 8, color: 'rgba(0,0,0,.3)' } },
      { type: 'text', text: 'Follow for updates', x: 0.5, y: 0.55, w: 0.86, h: 0.07, fontSize: 0.036, fontWeight: 500, color: 'rgba(255,255,255,.88)', align: 'center' },
    ],
  },
  {
    id: 'minimal',
    label: 'Minimal',
    bg: { type: 'solid', color: '#ffffff' },
    layers: [
      { type: 'rect', x: 0.07, y: 0.07, w: 0.86, h: 0.86, fill: { color: '#ffffff' }, stroke: { color: '#111827', width: 2 } },
      { type: 'text', text: 'Your message here', x: 0.5, y: 0.44, w: 0.74, h: 0.14, fontSize: 0.058, fontWeight: 700, color: '#111827', align: 'center' },
    ],
  },
];

let scene = null;
let selected = -1;
let past = [];
let future = [];
let lastPushKey = '';
let lastPushAt = 0;
let resize = null;

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Snapshot before a mutation. Same-key bursts inside 800ms coalesce, so a
 *  drag or a run of typing is ONE undo step instead of fifty. */
function pushHistory(key = '') {
  if (!scene) return;
  const ts = Date.now();
  if (key && key === lastPushKey && ts - lastPushAt < 800) return;
  past.push(clone(scene));
  if (past.length > 60) past.shift();
  future.length = 0;
  lastPushKey = key;
  lastPushAt = ts;
}

export function undo() {
  if (!past.length) return false;
  future.push(clone(scene));
  scene = past.pop();
  afterHistoryJump();
  return true;
}

export function redo() {
  if (!future.length) return false;
  past.push(clone(scene));
  scene = future.pop();
  afterHistoryJump();
  return true;
}

export const historyState = () => ({ undo: past.length, redo: future.length });

function afterHistoryJump() {
  canvas.width = scene.width;
  canvas.height = scene.height;
  selected = Math.min(selected, scene.layers.length - 1);
  renderLayerList();
  renderEditor();
  commit();
}
let canvas, ctx;
let drag = null;
let onChange = () => {};
let activeTemplate = null;

const imgCache = new Map();
function loadImg(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  const p = new Promise((res) => {
    img.onload = () => res(img);
    img.onerror = () => res(null);
  });
  imgCache.set(src, p);
  return p;
}

// Fractions of canvas size -> pixels, so a scene is resolution-independent
// and re-renders correctly at every export preset.
const px = (v, total) => (Math.abs(v) <= 1.0001 && typeof v === 'number' ? v * total : v);

export const DEFAULT_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Arabic", sans-serif';

function fontString(l, W, H) {
  const size = Math.round(px(l.fontSize ?? 0.05, H));
  const style = l.fontStyle === 'italic' ? 'italic ' : '';
  return `${style}${l.fontWeight || 700} ${size}px ${l.fontFamily || DEFAULT_FONT_STACK}`;
}

function wrap(text, maxWidth, lineHeight) {
  const out = [];
  for (const hard of String(text).split('\n')) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const cand = `${line} ${words[i]}`;
      if (ctx.measureText(cand).width <= maxWidth) line = cand;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return { lines: out, height: out.length * lineHeight };
}

function roundRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

async function draw() {
  if (!scene || !ctx) return;
  const W = scene.width, H = scene.height;

  const bg = scene.background;
  if (bg.type === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    bg.stops.forEach((s) => g.addColorStop(s.at, s.color));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg.color;
  }
  ctx.fillRect(0, 0, W, H);

  for (const l of scene.layers) {
    if (l.hidden) continue;
    ctx.save();
    ctx.globalAlpha = l.opacity ?? 1;
    if (l.shadow) {
      ctx.shadowColor = l.shadow.color || 'rgba(0,0,0,.45)';
      ctx.shadowBlur = l.shadow.blur ?? 18;
      ctx.shadowOffsetY = l.shadow.offsetY ?? 6;
    }

    const x = px(l.x ?? 0, W), y = px(l.y ?? 0, H);
    const w = px(l.w ?? 1, W), h = px(l.h ?? 1, H);

    if (l.type === 'rect') {
      ctx.fillStyle = l.fill?.color || '#ffffff';
      if (l.radius) roundRect(x, y, w, h, l.radius); else ctx.rect(x, y, w, h);
      ctx.fill();
      if (l.stroke) {
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = l.stroke.color;
        ctx.lineWidth = l.stroke.width || 2;
        ctx.stroke();
      }
    } else if (l.type === 'image') {
      const img = await loadImg(l.src);
      if (img) {
        if (l.radius) { roundRect(x, y, w, h, l.radius); ctx.clip(); }
        const scale = Math.max(w / img.width, h / img.height);
        const sw = w / scale, sh = h / scale;
        const sx = Math.min(Math.max((img.width - sw) * (l.focalX ?? 0.5), 0), img.width - sw);
        const sy = Math.min(Math.max((img.height - sh) * (l.focalY ?? 0.5), 0), img.height - sh);
        ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,.08)';
        ctx.fillRect(x, y, w, h);
      }
    } else if (l.type === 'text') {
      ctx.font = fontString(l, W, H);
      ctx.textBaseline = 'top';
      const fontSize = px(l.fontSize ?? 0.05, H);
      const lineHeight = fontSize * (l.lineHeight ?? 1.22);
      const { lines, height: bh } = wrap(l.text || '', w, lineHeight);
      let ty = y;
      if (l.vAlign === 'middle') ty = y + (h - bh) / 2;
      else if (l.vAlign === 'bottom') ty = y + h - bh;

      for (const line of lines) {
        const m = ctx.measureText(line).width;
        let tx = x;
        if (l.align === 'center') tx = x + (w - m) / 2;
        else if (l.align === 'right') tx = x + w - m;
        if (l.stroke) {
          ctx.strokeStyle = l.stroke.color || '#000';
          ctx.lineWidth = l.stroke.width || 4;
          ctx.lineJoin = 'round';
          ctx.strokeText(line, tx, ty);
        }
        ctx.fillStyle = l.color || '#ffffff';
        ctx.fillText(line, tx, ty);
        ty += lineHeight;
      }
    }
    ctx.restore();
  }

  // selection outline + resize handles (drawn last, never exported)
  if (selected >= 0 && scene.layers[selected]) {
    const l = scene.layers[selected];
    const x = px(l.x ?? 0, W), y = px(l.y ?? 0, H), w = px(l.w ?? 1, W), h = px(l.h ?? 1, H);
    ctx.save();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = Math.max(2, W / 540);
    ctx.setLineDash([W / 90, W / 130]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    const hs = handleSize(W);
    ctx.fillStyle = '#22d3ee';
    for (const c of corners(x, y, w, h)) ctx.fillRect(c.x - hs / 2, c.y - hs / 2, hs, hs);
    ctx.restore();
  }
}

function commit() { draw(); onChange(scene); }

function toLocal(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * scene.width,
    y: ((e.clientY - r.top) / r.height) * scene.height,
  };
}

const handleSize = (W) => Math.max(14, W / 60);
const corners = (x, y, w, h) => [
  { k: 'nw', x, y },
  { k: 'ne', x: x + w, y },
  { k: 'sw', x, y: y + h },
  { k: 'se', x: x + w, y: y + h },
];

function handleAt(p) {
  if (selected < 0 || !scene.layers[selected]) return null;
  const l = scene.layers[selected];
  const x = px(l.x ?? 0, scene.width), y = px(l.y ?? 0, scene.height);
  const w = px(l.w ?? 1, scene.width), h = px(l.h ?? 1, scene.height);
  const hs = handleSize(scene.width) * 0.9;
  for (const c of corners(x, y, w, h)) {
    if (Math.abs(p.x - c.x) <= hs && Math.abs(p.y - c.y) <= hs) return c.k;
  }
  return null;
}

function hitTest(p) {
  for (let i = scene.layers.length - 1; i >= 0; i--) {
    const l = scene.layers[i];
    if (l.hidden) continue;
    const x = px(l.x ?? 0, scene.width), y = px(l.y ?? 0, scene.height);
    const w = px(l.w ?? 1, scene.width), h = px(l.h ?? 1, scene.height);
    if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return i;
  }
  return -1;
}

function bindCanvas() {
  canvas.addEventListener('pointerdown', (e) => {
    const p = toLocal(e);
    const corner = handleAt(p);
    if (corner) {
      const l = scene.layers[selected];
      pushHistory('resize');
      resize = {
        corner,
        orig: {
          x: px(l.x ?? 0, scene.width),
          y: px(l.y ?? 0, scene.height),
          w: px(l.w ?? 1, scene.width),
          h: px(l.h ?? 1, scene.height),
        },
      };
      canvas.setPointerCapture(e.pointerId);
      draw();
      return;
    }
    const idx = hitTest(p);
    selected = idx;
    if (idx >= 0) {
      pushHistory('drag');
      const l = scene.layers[idx];
      drag = { idx, startX: p.x, startY: p.y, origX: px(l.x ?? 0, scene.width), origY: px(l.y ?? 0, scene.height) };
      canvas.setPointerCapture(e.pointerId);
    }
    renderLayerList();
    renderEditor();
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toLocal(e);
    if (resize) {
      const l = scene.layers[selected];
      const r0 = resize.orig;
      const right = r0.x + r0.w;
      const bottom = r0.y + r0.h;
      const min = Math.max(8, scene.width * 0.02);
      let x = r0.x, y = r0.y, w = r0.w, h = r0.h;
      const c = resize.corner;
      if (c.includes('w')) { x = Math.min(p.x, right - min); w = right - x; }
      if (c.includes('e')) { w = Math.max(min, p.x - r0.x); }
      if (c.includes('n')) { y = Math.min(p.y, bottom - min); h = bottom - y; }
      if (c.includes('s')) { h = Math.max(min, p.y - r0.y); }
      l.x = x / scene.width;
      l.y = y / scene.height;
      l.w = w / scene.width;
      l.h = h / scene.height;
      draw();
      return;
    }
    if (!drag) return;
    const l = scene.layers[drag.idx];
    l.x = (drag.origX + (p.x - drag.startX)) / scene.width;
    l.y = (drag.origY + (p.y - drag.startY)) / scene.height;
    draw();
  });

  const endDrag = () => {
    if (drag || resize) {
      drag = null;
      resize = null;
      renderEditor();
      commit();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Wheel over a selected layer resizes it — handy for quick fitting.
  canvas.addEventListener('wheel', (e) => {
    if (selected < 0) return;
    e.preventDefault();
    pushHistory('wheel');
    const l = scene.layers[selected];
    const f = e.deltaY < 0 ? 1.05 : 0.952;
    if (l.type === 'text') l.fontSize = Math.max(0.008, Math.min(0.4, (l.fontSize ?? 0.05) * f));
    else { l.w = Math.max(0.02, (l.w ?? 1) * f); l.h = Math.max(0.02, (l.h ?? 1) * f); }
    renderEditor();
    commit();
  }, { passive: false });
}

// ------------------------------------------------------------ layer panels

let renderLayerList = () => {};
let renderEditor = () => {};

export function initDesigner(opts) {
  canvas = document.getElementById('stage');
  ctx = canvas.getContext('2d');
  onChange = opts.onChange || (() => {});
  renderLayerList = opts.renderLayerList || (() => {});
  renderEditor = opts.renderEditor || (() => {});

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (undo()) opts.onChange?.(); }
    else if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); if (redo()) opts.onChange?.(); }
    else if (e.key.toLowerCase() === 'y') { e.preventDefault(); if (redo()) opts.onChange?.(); }
  });

  applyTemplate(TEMPLATES[0], PRESETS[0]);
  bindCanvas();
}

export function applyTemplate(tpl, preset) {
  if (scene) pushHistory('template');
  activeTemplate = tpl.id;
  scene = {
    width: preset.w,
    height: preset.h,
    background: JSON.parse(JSON.stringify(tpl.bg)),
    layers: JSON.parse(JSON.stringify(tpl.layers)),
  };
  selected = -1;
  canvas.width = preset.w;
  canvas.height = preset.h;
  renderLayerList();
  renderEditor();
  commit();
}

export function setPreset(preset) {
  pushHistory('preset');
  scene.width = preset.w;
  scene.height = preset.h;
  canvas.width = preset.w;
  canvas.height = preset.h;
  commit();
}

export function addTextLayer() {
  pushHistory('struct');
  scene.layers.push({
    type: 'text',
    text: 'New headline',
    x: 0.08, y: 0.42, w: 0.84, h: 0.12,
    fontSize: 0.06, fontWeight: 700, color: '#ffffff', align: 'center',
  });
  selected = scene.layers.length - 1;
  renderLayerList(); renderEditor(); commit();
}

export function addRectLayer() {
  scene.layers.push({ type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.2, fill: { color: 'rgba(0,0,0,0.35)' } });
  selected = scene.layers.length - 1;
  renderLayerList(); renderEditor(); commit();
}

export async function addImageLayer(src) {
  pushHistory('struct');
  scene.layers.push({ type: 'image', src, x: 0, y: 0, w: 1, h: 1, focalX: 0.5, focalY: 0.5 });
  selected = scene.layers.length - 1;
  await loadImg(src);
  renderLayerList(); renderEditor(); commit();
}

export function selectLayer(i) { selected = i; renderLayerList(); renderEditor(); draw(); }
export function getSelected() { return selected; }

export function updateSelected(patch) {
  if (selected < 0 || !scene.layers[selected]) return;
  pushHistory('input:' + Object.keys(patch).join(','));
  Object.assign(scene.layers[selected], patch);
  commit();
}

export function moveSelected(dir) {
  if (selected < 0) return;
  pushHistory('struct');
  const i = selected;
  const j = i + dir;
  if (j < 0 || j >= scene.layers.length) return;
  [scene.layers[i], scene.layers[j]] = [scene.layers[j], scene.layers[i]];
  selected = j;
  renderLayerList(); commit();
}

export function deleteSelected() {
  if (selected < 0) return;
  pushHistory('struct');
  scene.layers.splice(selected, 1);
  selected = Math.min(selected, scene.layers.length - 1);
  renderLayerList(); renderEditor(); commit();
}

export function setBackground(bg) {
  pushHistory('bg');
  scene.background = { ...scene.background, ...bg };
  commit();
}

export function getScene() {
  return scene ? JSON.parse(JSON.stringify(scene)) : null;
}

export function setScene(s) {
  pushHistory('load');
  scene = JSON.parse(JSON.stringify(s));
  canvas.width = scene.width;
  canvas.height = scene.height;
  selected = -1;
  renderLayerList(); renderEditor(); commit();
}

export function getActiveTemplate() { return activeTemplate; }

/** Client-side PNG export (the server can also render the same scene). */
export function exportPNG() {
  const prev = selected;
  selected = -1;
  draw();
  return new Promise((resolve) => {
    setTimeout(() => {
      canvas.toBlob((blob) => {
        selected = prev;
        draw();
        resolve(blob);
      }, 'image/png');
    }, 30);
  });
}
