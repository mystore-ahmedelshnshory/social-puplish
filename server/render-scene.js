import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';
import { publicBaseUrl } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERS_DIR = path.join(__dirname, '..', 'data', 'renders');
fs.mkdirSync(RENDERS_DIR, { recursive: true });

/**
 * Server-side poster renderer (node-canvas).
 *
 * Why this exists separately from the browser canvas in the designer:
 * a scheduled post fires at 03:00 with no browser open, so the poster has to
 * be renderable headlessly on the server. The designer and this renderer share
 * ONE scene JSON format and mirror the same drawing rules, so what you see in
 * the preview is byte-for-byte what gets published.
 *
 * Scene format:
 *   { width, height, background: {type:'solid'|'gradient', ...}, layers: [ ... ] }
 *
 * Layer types: rect | image | text
 */

const imageCache = new Map();

async function resolveImage(src) {
  if (!src) return null;
  if (imageCache.has(src)) return imageCache.get(src);

  let img;
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not fetch image: HTTP ${res.status}`);
    img = await loadImage(Buffer.from(await res.arrayBuffer()));
  } else if (src.startsWith('data:')) {
    img = await loadImage(src);
  } else {
    let rel = src;
    if (rel.startsWith('/uploads/')) rel = path.join('data', 'uploads', rel.slice('/uploads/'.length));
    else if (rel.startsWith('/renders/')) rel = path.join('data', 'renders', rel.slice('/renders/'.length));
    const abs = path.isAbsolute(rel) ? rel : path.join(__dirname, '..', rel);
    if (!fs.existsSync(abs)) throw new Error(`Image not found: ${src}`);
    img = await loadImage(abs);
  }
  imageCache.set(src, img);
  return img;
}

/** Aspect-fill an image into a box, honouring a 0..1 focal point. */
function drawImageCover(ctx, img, x, y, w, h, focalX = 0.5, focalY = 0.5) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.min(Math.max((img.width - sw) * focalX, 0), img.width - sw);
  const sy = Math.min(Math.max((img.height - sh) * focalY, 0), img.height - sh);
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Greedy word wrap that respects explicit \n. Returns lines + used height. */
function wrapText(ctx, text, maxWidth, lineHeight) {
  const out = [];
  for (const hardLine of String(text).split('\n')) {
    const words = hardLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return { lines: out, height: out.length * lineHeight };
}

/**
 * Fraction-of-canvas -> pixels. A layer coordinate or font size in the range
 * [-1, 1] is treated as a fraction of the canvas (resolution-independent);
 * anything larger is already pixels (border widths, corner radii, shadows).
 * MUST stay identical to the copy in public/js/designer.js.
 */
const px = (v, total) => (typeof v === 'number' && Math.abs(v) <= 1.0001 ? v * total : v);

const DEFAULT_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Arabic", sans-serif';

function fontString(layer, height) {
  const style = layer.fontStyle === 'italic' ? 'italic ' : '';
  const weight = layer.fontWeight || 700;
  const family = layer.fontFamily || DEFAULT_FONT_STACK;
  const size = Math.round(px(layer.fontSize ?? 0.05, height));
  return `${style}${weight} ${size}px ${family}`;
}

export async function renderScene(scene, { format = 'jpeg', quality = 0.92 } = {}) {
  const width = Math.round(scene.width || 1080);
  const height = Math.round(scene.height || 1080);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ---- background -------------------------------------------------------
  const bg = scene.background || { type: 'solid', color: '#0f172a' };
  if (bg.type === 'gradient') {
    const g = ctx.createLinearGradient(
      bg.x0 ?? 0,
      bg.y0 ?? 0,
      bg.x1 ?? width,
      bg.y1 ?? height,
    );
    (bg.stops || [
      { at: 0, color: '#4f46e5' },
      { at: 1, color: '#06b6d4' },
    ]).forEach((s) => g.addColorStop(s.at, s.color));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg.color || '#0f172a';
  }
  ctx.fillRect(0, 0, width, height);

  // ---- layers -----------------------------------------------------------
  for (const layer of scene.layers || []) {
    if (layer.hidden) continue;

    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1;

    if (layer.shadow) {
      ctx.shadowColor = layer.shadow.color || 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = layer.shadow.blur ?? 18;
      ctx.shadowOffsetX = layer.shadow.offsetX ?? 0;
      ctx.shadowOffsetY = layer.shadow.offsetY ?? 6;
    }

    const x = px(layer.x ?? 0, width);
    const y = px(layer.y ?? 0, height);
    const w = px(layer.w ?? width, width);
    const h = px(layer.h ?? height, height);

    if (layer.type === 'rect') {
      if (layer.fill?.type === 'gradient') {
        const g = ctx.createLinearGradient(x, y, x + w, y + h);
        (layer.fill.stops || []).forEach((s) => g.addColorStop(s.at, s.color));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = layer.fill?.color || layer.color || '#ffffff';
      }
      if (layer.radius) roundedRectPath(ctx, x, y, w, h, layer.radius);
      else ctx.rect(x, y, w, h);
      ctx.fill();
      if (layer.stroke) {
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = layer.stroke.color;
        ctx.lineWidth = layer.stroke.width || 2;
        ctx.stroke();
      }
    } else if (layer.type === 'image') {
      const img = await resolveImage(layer.src);
      if (img) {
        if (layer.radius) {
          roundedRectPath(ctx, x, y, w, h, layer.radius);
          ctx.clip();
        }
        if (layer.fit === 'contain') {
          const scale = Math.min(w / img.width, h / img.height);
          const dw = img.width * scale;
          const dh = img.height * scale;
          ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        } else {
          drawImageCover(ctx, img, x, y, w, h, layer.focalX, layer.focalY);
        }
      }
    } else if (layer.type === 'text') {
      ctx.font = fontString(layer, height);
      ctx.textBaseline = 'top';

      const pad = layer.padding ?? 0;
      const maxWidth = px(layer.maxWidth ?? w - pad * 2, width);
      const lineHeight = px(layer.fontSize ?? 0.05, height) * (layer.lineHeight ?? 1.22);
      const { lines, height: blockHeight } = wrapText(ctx, layer.text || '', maxWidth, lineHeight);

      let ty = y + pad;
      if (layer.vAlign === 'middle') ty = y + (h - blockHeight) / 2;
      else if (layer.vAlign === 'bottom') ty = y + h - blockHeight - pad;

      for (const line of lines) {
        const measured = ctx.measureText(line).width;
        let tx = x + pad;
        if (layer.align === 'center') tx = x + (w - measured) / 2;
        else if (layer.align === 'right') tx = x + w - measured - pad;

        if (layer.stroke) {
          ctx.strokeStyle = layer.stroke.color || '#000000';
          ctx.lineWidth = layer.stroke.width || 4;
          ctx.lineJoin = 'round';
          ctx.strokeText(line, tx, ty);
        }
        if (layer.fill?.type === 'gradient') {
          const g = ctx.createLinearGradient(tx, ty, tx + measured, ty + lineHeight);
          (layer.fill.stops || []).forEach((s) => g.addColorStop(s.at, s.color));
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = layer.color || '#ffffff';
        }
        ctx.fillText(line, tx, ty);
        ty += lineHeight;
      }
    }

    ctx.restore();
  }

  // ---- encode -----------------------------------------------------------
  const buf =
    format === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', { quality });

  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const filename = `${hash}.${format === 'png' ? 'png' : 'jpg'}`;
  const outPath = path.join(RENDERS_DIR, filename);
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, buf);

  return {
    path: outPath,
    filename,
    // Served by the app itself. Instagram and TikTok fetch media from a PUBLIC
    // url, so in production this must be your real https domain, not localhost.
    publicUrl: `${publicBaseUrl()}/renders/${filename}`,
    bytes: buf.length,
    width,
    height,
    mime: format === 'png' ? 'image/png' : 'image/jpeg',
  };
}
