// Rasterises the headstone outline and the carved design (text, symbol,
// border, artwork) onto the simulation grid.
import { outlinePoints, outlinePath2D } from './headstone.js';
import { edtSquared } from './vcarve.js';

export const FONTS = {
  'Cinzel': 'Cinzel (Roman capitals)',
  'Cinzel Decorative': 'Cinzel Decorative',
  'EB Garamond': 'EB Garamond',
  'Playfair Display': 'Playfair Display',
  'Great Vibes': 'Great Vibes (script)',
  'Pinyon Script': 'Pinyon Script',
  'Times New Roman': 'Times New Roman',
  'Arial': 'Arial (sans)',
};

export const SYMBOLS = {
  none: 'None',
  cross: 'Latin cross',
  celtic: 'Celtic cross',
  heart: 'Heart',
  hearts: 'Two hearts',
  star: 'Star of David',
  dove: 'Dove',
  rose: 'Rose',
};

/** Grid shared by the design, the V-carve engine and the simulator. */
export function makeGrid(widthMM, heightMM, cell) {
  const W = Math.max(8, Math.ceil(widthMM / cell));
  const H = Math.max(8, Math.ceil(heightMM / cell));
  return { cell, W, H, widthMM, heightMM };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** ctx transform so that drawing uses mm with y pointing up. */
function yUp(ctx, grid) {
  const s = 1 / grid.cell;
  ctx.setTransform(s, 0, 0, -s, 0, grid.H);
}
/** ctx transform in mm with y pointing down (needed for text). */
function yDown(ctx, grid) {
  const s = 1 / grid.cell;
  ctx.setTransform(s, 0, 0, s, 0, grid.H - grid.heightMM * s);
}

/** Copy canvas alpha into a bottom-up Uint8Array (row 0 = y 0). */
function readAlpha(ctx, grid) {
  const { W, H } = grid;
  const data = ctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const src = (H - 1 - j) * W * 4;
    const dst = j * W;
    for (let i = 0; i < W; i++) out[dst + i] = data[src + i * 4 + 3];
  }
  return out;
}

export async function ensureFonts(lines) {
  if (!document.fonts) return;
  const fams = new Set(lines.map(l => l.font));
  await Promise.all([...fams].map(f => document.fonts.load(`100px "${f}"`, 'AaBb0123').catch(() => {})));
}

/**
 * Build the outline (stock) and design (carve) masks.
 * Returns { outlinePts, outline (Uint8 0..255 AA), carve (Uint8 0/1) }.
 */
export async function buildDesign(cfg, grid) {
  const { W, H } = grid;
  const pts = outlinePoints(cfg.shape, cfg.width, cfg.height, cfg.rise, cfg.corner);
  const outlinePath = outlinePath2D(pts);

  // --- stock outline -------------------------------------------------------
  const oc = makeCanvas(W, H);
  const octx = oc.getContext('2d', { willReadFrequently: true });
  yUp(octx, grid);
  octx.fillStyle = '#fff';
  octx.fill(outlinePath);
  const outline = readAlpha(octx, grid);

  // --- design --------------------------------------------------------------
  await ensureFonts(cfg.lines);
  const dc = makeCanvas(W, H);
  const ctx = dc.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';

  // symbol
  if (cfg.symbol && cfg.symbol !== 'none') {
    yUp(ctx, grid);
    drawSymbol(ctx, cfg.symbol, cfg.width / 2 + (cfg.symbolX || 0), cfg.symbolY, cfg.symbolSize);
  }

  // text
  for (const line of cfg.lines) {
    if (!line.text || !line.text.trim()) continue;
    yDown(ctx, grid);
    drawTextLine(ctx, line, cfg);
  }

  // artwork
  if (cfg.image && cfg.image.img) {
    drawArtwork(ctx, grid, cfg);
  }

  let carveAlpha = readAlpha(ctx, grid);

  // border (computed from the outline's distance field: exact constant inset)
  if (cfg.border) {
    const inside = new Uint8Array(W * H);
    for (let k = 0; k < inside.length; k++) inside[k] = outline[k] >= 128 ? 1 : 0;
    const d2 = edtSquared(inside, W, H);
    const a = cfg.borderInset / grid.cell, b = (cfg.borderInset + cfg.borderWidth) / grid.cell;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!inside[k]) continue;
        const d = Math.sqrt(d2[k]) - 0.5;
        if (d >= a && d <= b) carveAlpha[k] = 255;
      }
    }
  }

  const carve = new Uint8Array(W * H);
  for (let k = 0; k < carve.length; k++) carve[k] = carveAlpha[k] >= 128 && outline[k] >= 200 ? 1 : 0;

  return { outlinePts: pts, outline, carve };
}

function drawTextLine(ctx, line, cfg) {
  const fam = `"${line.font}", serif`;
  // calibrate: letter height = cap height of "H" (or x-height-ish for scripts)
  ctx.font = `100px ${fam}`;
  const m = ctx.measureText('H');
  const capAt100 = (m.actualBoundingBoxAscent || 70);
  let px = (line.size * 100) / capAt100;
  ctx.font = `${line.weight || 400} ${px}px ${fam}`;
  try { ctx.letterSpacing = `${(line.spacing || 0)}px`; } catch { /* unsupported */ }
  let width = ctx.measureText(line.text).width;
  const maxW = cfg.width * (cfg.textMaxWidth || 0.86);
  if (width > maxW) {
    px *= maxW / width;
    ctx.font = `${line.weight || 400} ${px}px ${fam}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const capH = (capAt100 * px) / 100;
  const x = cfg.width / 2 + (line.x || 0);
  const yBase = cfg.height - line.y + capH / 2; // y-down canvas coords
  ctx.fillText(line.text, x, yBase);
  try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
}

function drawArtwork(ctx, grid, cfg) {
  const im = cfg.image;
  const wmm = im.width;
  const hmm = (wmm * im.img.height) / im.img.width;
  const pw = Math.max(1, Math.round(wmm / grid.cell));
  const ph = Math.max(1, Math.round(hmm / grid.cell));
  const tmp = makeCanvas(pw, ph);
  const t = tmp.getContext('2d', { willReadFrequently: true });
  t.drawImage(im.img, 0, 0, pw, ph);
  const d = t.getImageData(0, 0, pw, ph);
  const px = d.data;
  for (let k = 0; k < px.length; k += 4) {
    const lum = 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
    let on = px[k + 3] > 128 && lum < im.threshold;
    if (im.invert) on = px[k + 3] > 128 && !on;
    px[k] = px[k + 1] = px[k + 2] = 255;
    px[k + 3] = on ? 255 : 0;
  }
  t.putImageData(d, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const cx = (cfg.width / 2 + im.x) / grid.cell;
  const cy = grid.H - im.y / grid.cell;
  ctx.drawImage(tmp, Math.round(cx - pw / 2), Math.round(cy - ph / 2));
}

// ---------------------------------------------------------------------------
// Symbols, drawn in a y-up mm coordinate system centred on (cx, cy) with an
// overall height of `s` mm.
function drawSymbol(ctx, kind, cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s / 100, s / 100); // symbols authored in a 100-unit box centred at 0
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (kind) {
    case 'cross': latinCross(ctx, 1); break;
    case 'celtic': {
      latinCross(ctx, 0.85);
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.arc(0, 14, 24, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'heart': heart(ctx, 0, 0, 1, true); break;
    case 'hearts': {
      ctx.lineWidth = 6;
      heart(ctx, -16, 0, 0.72, false);
      heart(ctx, 16, -4, 0.72, false);
      break;
    }
    case 'star': {
      ctx.lineWidth = 7;
      for (const rot of [0, Math.PI]) {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = rot + Math.PI / 2 + (i * 2 * Math.PI) / 3;
          const x = 48 * Math.cos(a), y = 48 * Math.sin(a);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath(); ctx.stroke();
      }
      break;
    }
    case 'dove': dove(ctx); break;
    case 'rose': rose(ctx); break;
  }
  ctx.restore();
}

function latinCross(ctx, k) {
  const t = 12 * k; // half thickness
  const top = 50, bottom = -50, armY = 18, arm = 32 * k;
  ctx.beginPath();
  ctx.moveTo(-t, bottom); ctx.lineTo(t, bottom); ctx.lineTo(t, armY - t);
  ctx.lineTo(arm, armY - t); ctx.lineTo(arm, armY + t); ctx.lineTo(t, armY + t);
  ctx.lineTo(t, top); ctx.lineTo(-t, top); ctx.lineTo(-t, armY + t);
  ctx.lineTo(-arm, armY + t); ctx.lineTo(-arm, armY - t); ctx.lineTo(-t, armY - t);
  ctx.closePath(); ctx.fill();
}

function heart(ctx, x, y, k, fill) {
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * Math.PI * 2;
    const hx = 16 * Math.sin(t) ** 3;
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const px = x + hx * 3 * k, py = y + (hy + 2) * 3 * k;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  fill ? ctx.fill() : ctx.stroke();
}

function dove(ctx) {
  // Stylised dove in flight (filled silhouette).
  ctx.beginPath();
  ctx.moveTo(-46, 4);                       // beak
  ctx.quadraticCurveTo(-36, 16, -24, 12);   // head top
  ctx.quadraticCurveTo(-12, 40, 10, 48);    // up to front wing tip
  ctx.quadraticCurveTo(4, 26, 8, 12);
  ctx.quadraticCurveTo(24, 36, 46, 40);     // back wing tip
  ctx.quadraticCurveTo(30, 18, 22, 4);
  ctx.quadraticCurveTo(36, 0, 50, -14);     // tail
  ctx.lineTo(40, -22);
  ctx.quadraticCurveTo(22, -12, 8, -12);
  ctx.quadraticCurveTo(-20, -14, -30, -2);
  ctx.quadraticCurveTo(-38, 0, -46, 4);
  ctx.closePath();
  ctx.fill();
  // eye (cut back out)
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(-32, 7, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

function rose(ctx) {
  ctx.lineWidth = 4.5;
  // bloom: spiral of petals
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI * 5.5;
    const r = 2 + t * 1.55;
    const x = r * Math.cos(t), y = 22 + r * Math.sin(t) * 0.85;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  // outer cup
  ctx.beginPath();
  ctx.moveTo(-30, 26); ctx.quadraticCurveTo(-30, -2, 0, -6); ctx.quadraticCurveTo(30, -2, 30, 26);
  ctx.stroke();
  // stem
  ctx.beginPath(); ctx.moveTo(0, -6); ctx.quadraticCurveTo(-4, -28, 2, -50); ctx.stroke();
  // leaves
  leaf(ctx, -2, -26, -1);
  leaf(ctx, 1, -38, 1);
}

function leaf(ctx, x, y, dir) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + dir * 10, y + 14, x + dir * 24, y + 8);
  ctx.quadraticCurveTo(x + dir * 12, y - 4, x, y);
  ctx.fill();
}
