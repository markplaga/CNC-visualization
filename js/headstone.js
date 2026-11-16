// Headstone outline profiles. All units are millimetres.
// The stone lies face-up on the machine bed: X runs left→right across the
// face, Y runs from the base (y = 0) up to the top of the stone.

export const SHAPES = {
  serpentine: 'Serpentine',
  arch: 'Segmental arch',
  roman: 'Half-round (Roman)',
  gothic: 'Gothic (pointed)',
  peak: 'Peak / gable',
  rounded: 'Square, rounded corners',
  flat: 'Square top',
  heart: 'Heart',
};

const SEG = 96;

/**
 * Returns the outline as an array of [x, y] points (counter-clockwise,
 * starting at the bottom-left corner). The polygon is not explicitly closed.
 */
export function outlinePoints(shape, w, h, rise = 60, corner = 25) {
  rise = Math.max(0, Math.min(rise, h * 0.8));
  const pts = [[0, 0], [w, 0]];

  switch (shape) {
    case 'flat':
      pts.push([w, h], [0, h]);
      break;

    case 'rounded': {
      const r = Math.max(0, Math.min(corner, w / 2, h / 2));
      pts.push([w, h - r]);
      arc(pts, w - r, h - r, r, 0, Math.PI / 2);
      arc(pts, r, h - r, r, Math.PI / 2, Math.PI);
      break;
    }

    case 'arch': {
      if (rise < 0.5) { pts.push([w, h], [0, h]); break; }
      const hs = h - rise;
      const R = (w * w / 4 + rise * rise) / (2 * rise);
      const cy = h - R;
      const a0 = Math.atan2(hs - cy, w / 2);
      pts.push([w, hs]);
      arc(pts, w / 2, cy, R, a0, Math.PI - a0);
      break;
    }

    case 'roman': {
      const r = w / 2;
      const hs = Math.max(0, h - r);
      pts.push([w, hs]);
      arc(pts, r, hs, r, 0, Math.PI);
      break;
    }

    case 'gothic': {
      // Two circular arcs meeting at a point. Rise must be >= w/2 for a true
      // pointed arch; otherwise we fall back to the minimum.
      const rr = Math.max(rise, w * 0.5);
      const hs = Math.max(h * 0.15, h - rr);
      const top = hs + rr;
      const c = (w * w / 4 + rr * rr) / w; // radius, centres at (w-c, hs) and (c, hs)
      pts.push([w, hs]);
      // right arc: centre (w - c, hs), from angle 0 to apex
      const aR = Math.atan2(top - hs, w / 2 - (w - c));
      arc(pts, w - c, hs, c, 0, aR);
      // left arc: centre (c, hs), from apex to angle PI
      const aL = Math.atan2(top - hs, w / 2 - c);
      arc(pts, c, hs, c, aL, Math.PI);
      break;
    }

    case 'peak': {
      const hs = h - rise;
      pts.push([w, hs], [w / 2, h], [0, hs]);
      break;
    }

    case 'serpentine': {
      const hs = h - rise;
      for (let i = 0; i <= SEG; i++) {
        const t = 1 - i / SEG;
        const f = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
        pts.push([t * w, hs + rise * f]);
      }
      break;
    }

    case 'heart': {
      // Parametric heart scaled to fill the box, truncated flat at the base so
      // the stone can stand.
      const cut = -9;
      const left = [], right = [];
      for (let i = 0; i <= 400; i++) {
        const t = (i / 400) * 2 * Math.PI;
        const x = 16 * Math.sin(t) ** 3;
        const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        if (y < cut) continue;
        (t <= Math.PI ? right : left).push([x, y]);
      }
      // left (t: ~2pi..) then right (t: 0..) runs clockwise: left base -> top -> right base
      const cw = left.concat(right);
      const xs = cw.map(p => p[0]), ys = cw.map(p => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys);
      const sx = w / (maxX - minX), sy = h / (maxY - cut);
      const ccw = cw.reverse().map(([x, y]) => [(x - minX) * sx, (y - cut) * sy]);
      pts.length = 0;
      pts.push([ccw[0][0], 0], ...ccw, [ccw[ccw.length - 1][0], 0]);
      return dedupe(ensureCCW(pts));
    }

    default:
      pts.push([w, h], [0, h]);
  }
  return dedupe(pts);
}

function arc(pts, cx, cy, r, a0, a1) {
  const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) / Math.PI) * SEG));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  const a = out[0], b = out[out.length - 1];
  if (out.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) out.pop();
  return out;
}

function ensureCCW(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s < 0 ? pts.reverse() : pts;
}

export function outlinePath2D(pts) {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}
