import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';
import { getPlatform } from './platforms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROC_DIR = path.join(__dirname, '..', 'data', 'processed');
fs.mkdirSync(PROC_DIR, { recursive: true });

/**
 * Media auto-fix: make an image conform to a platform's hard rules BEFORE it
 * is published, instead of just rejecting the post.
 *
 * Instagram is the reason this exists. Its API refuses, outright:
 *   - non-JPEG images            -> re-encode (flattening alpha onto white)
 *   - aspect ratios outside 4:5 .. 1.91:1  -> center-crop into the window
 *   - widths outside 320..1080px -> scale into range
 *   - files over 8 MB            -> step quality/size down until under
 *
 * Facebook and LinkedIn get the size cap and a PNG/JPEG normalisation only.
 * Video transcoding is deliberately out of scope — it needs ffmpeg-class
 * tooling and per-platform codec matrices; images cover the poster workflow.
 *
 * The original file is never mutated: a fixed copy lands in data/processed/
 * and only THAT job publishes the copy, so the same post can send a 4:5 crop
 * to Instagram and the untouched original to Telegram.
 */

const mapUrlToPath = (url) => {
  if (!url || !url.startsWith('/')) return null;
  if (url.startsWith('/uploads/')) return path.join(__dirname, '..', 'data', 'uploads', url.slice('/uploads/'.length));
  if (url.startsWith('/renders/')) return path.join(__dirname, '..', 'data', 'renders', url.slice('/renders/'.length));
  if (url.startsWith('/processed/')) return path.join(PROC_DIR, url.slice('/processed/'.length));
  return null;
};

function toCanvas(img, w, h) {
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

export async function fixImageForPlatform(item, platformId) {
  const spec = getPlatform(platformId);
  const notes = [];
  if (!spec || item.type !== 'image') return { item, changed: false, notes };

  const constraints = spec.constraints || {};
  let srcPath = item.path || mapUrlToPath(item.url);
  if (!srcPath || !fs.existsSync(srcPath)) {
    return { item, changed: false, notes: ['Image is not on local disk — auto-fix skipped.'] };
  }

  let img = await loadImage(srcPath);
  let w = img.width;
  let h = img.height;
  let changed = false;

  // 1 — aspect window (center crop)
  if (constraints.aspectMin && constraints.aspectMax) {
    const ar = w / h;
    if (ar < constraints.aspectMin - 0.005 || ar > constraints.aspectMax + 0.005) {
      const target = Math.min(Math.max(ar, constraints.aspectMin), constraints.aspectMax);
      let cw = w;
      let ch = h;
      if (ar > target) cw = Math.round(h * target);
      else ch = Math.round(w / target);
      const cx = Math.round((w - cw) / 2);
      const cy = Math.round((h - ch) / 2);
      const c = createCanvas(cw, ch);
      c.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      img = c;
      w = cw;
      h = ch;
      changed = true;
      notes.push(`center-cropped to ${target.toFixed(2)}:1 (${cw}×${ch}) — ${spec.name}'s allowed window is ${constraints.aspectMin.toFixed(2)}–${constraints.aspectMax.toFixed(2)}:1`);
    }
  }

  // 2 — width bounds
  const MINW = 320;
  const MAXW = 1080;
  if (w > MAXW || w < MINW) {
    const scale = w > MAXW ? MAXW / w : MINW / w;
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    img = toCanvas(img, nw, nh);
    w = nw;
    h = nh;
    changed = true;
    notes.push(`resized to ${nw}×${nh} — ${spec.name} requires widths of ${MINW}–${MAXW}px`);
  }

  // 3 — format: honour hard platform requirements, otherwise keep the family
  const needsJpeg = (constraints.imageFormat || []).length === 1 && constraints.imageFormat[0] === 'JPEG';
  const isJpeg = (item.mime || '') === 'image/jpeg';
  const outFormat = needsJpeg || isJpeg ? 'jpeg' : 'png';

  // 4 — nothing changed and already under the cap? Ship the original bytes.
  const capBytes = (spec.limits.imageMb || 8) * 1024 * 1024;
  if (!changed && (item.bytes || 0) <= capBytes && outFormat === (isJpeg ? 'jpeg' : 'png')) {
    return { item, changed: false, notes };
  }

  // 5 — encode, stepping quality/size down until under the cap.
  // loadImage() yields an Image (no toBuffer), so PNG output goes via a canvas.
  let quality = 0.92;
  let buf;
  let guard = 0;
  do {
    buf = outFormat === 'jpeg' ? flattenToJpeg(img, w, h, quality) : encodePng(img, w, h);
    if (buf.length <= capBytes || guard >= 5) break;
    if (quality > 0.6) quality -= 0.15;
    else {
      const nw = Math.round(w * 0.85);
      const nh = Math.round(h * 0.85);
      img = toCanvas(img, nw, nh);
      w = nw;
      h = nh;
    }
    guard += 1;
  } while (buf.length > capBytes);

  const becameJpeg = outFormat === 'jpeg' && !isJpeg;
  if (becameJpeg) {
    changed = true;
    notes.push(`re-encoded ${(item.mime || '').split('/')[1]?.toUpperCase() || 'image'} → JPEG (alpha flattened onto white) — ${spec.name} accepts JPEG only via API`);
  }
  if (guard > 0) {
    changed = true;
    notes.push(`compressed to ${(buf.length / 1048576).toFixed(2)} MB (cap ${spec.limits.imageMb} MB)`);
  }

  if (!changed) return { item, changed: false, notes };

  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const filename = `fix-${platformId}-${hash}.${outFormat === 'jpeg' ? 'jpg' : 'png'}`;
  const outPath = path.join(PROC_DIR, filename);
  fs.writeFileSync(outPath, buf);

  return {
    item: {
      ...item,
      path: outPath,
      url: `/processed/${filename}`,
      mime: outFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
      bytes: buf.length,
      width: w,
      height: h,
    },
    changed: true,
    notes,
  };
}

/** PNG output: loadImage() returns an Image without toBuffer — draw first. */
function encodePng(imgOrCanvas, w, h) {
  if (typeof imgOrCanvas.toBuffer === 'function' && imgOrCanvas.width === w && imgOrCanvas.height === h) {
    return imgOrCanvas.toBuffer('image/png');
  }
  return toCanvas(imgOrCanvas, w, h).toBuffer('image/png');
}

/** JPEG has no alpha channel: composite over white so transparency never
 *  becomes a black box on the platform side. */
function flattenToJpeg(canvasOrImg, w, h, quality) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvasOrImg, 0, 0, w, h);
  return c.toBuffer('image/jpeg', { quality });
}
