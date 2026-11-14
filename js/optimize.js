// Toolpath optimisation: reorders cuts and removes needless air moves.
//
//  1. Cut letter by letter: every depth pass of one letter (connected region
//     of the design) is finished before moving to the next, instead of
//     travelling across the whole stone once per pass.
//  2. Nearest-neighbour ordering (with reversal) from wherever the bit is.
//  3. Linking: when the next cut starts close by, the bit feeds straight
//     there without lifting, but only if that move is proven not to gouge:
//     at every sample along it the bit must be no deeper than the finished
//     V-carve surface (so its cone stays inside the letter).
//  4. A low retract (clearance) height between cuts. The stone face is flat,
//     so only the very first and last moves use the full safe Z.
import { toolGeometry, finishProgram } from './vcarve.js';

/** Label 8-connected regions of the carve mask. 0 = background. */
export function labelRegions(carve, W, H) {
  const lab = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  let n = 0;
  for (let k = 0; k < carve.length; k++) {
    if (!carve[k] || lab[k]) continue;
    n++;
    let sp = 0;
    stack[sp++] = k; lab[k] = n;
    while (sp) {
      const c = stack[--sp];
      const i = c % W, j = (c - i) / W;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= H) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= W) continue;
          const q = jj * W + ii;
          if (carve[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
    }
  }
  return { lab, count: n };
}

function regionOf(lab, grid, x, y) {
  const { W, H, cell } = grid;
  const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
  for (let r = 0; r <= 2; r++) {
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const v = lab[j * W + i];
      if (v) return v;
    }
  }
  return 0;
}

/** Greedy nearest-neighbour order. Returns oriented polylines and end point. */
function nnOrder(polys, sx, sy) {
  const n = polys.length;
  const used = new Uint8Array(n);
  const out = [];
  let cx = sx, cy = sy;
  // bucket the end points so each pick is roughly O(1)
  const cs = 20;
  const buckets = new Map();
  const key = (gx, gy) => gx * 100003 + gy;
  const addPt = (x, y, idx) => {
    const k = key(Math.floor(x / cs), Math.floor(y / cs));
    let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(idx);
  };
  for (let i = 0; i < n; i++) {
    const p = polys[i];
    addPt(p[0], p[1], i); addPt(p[p.length - 3], p[p.length - 2], i);
  }
  for (let c = 0; c < n; c++) {
    let best = -1, bestD = Infinity, rev = false;
    const bx = Math.floor(cx / cs), by = Math.floor(cy / cs);
    let stopAt = Infinity;
    for (let r = 0; r <= stopAt && r < 2000; r++) {
      for (let gx = bx - r; gx <= bx + r; gx++) {
        const edge = gx === bx - r || gx === bx + r;
        for (let gy = by - r; gy <= by + r; gy += edge ? 1 : 2 * r || 1) {
          const b = buckets.get(key(gx, gy));
          if (!b) continue;
          for (const idx of b) {
            if (used[idx]) continue;
            const p = polys[idx];
            const d0 = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
            const d1 = (p[p.length - 3] - cx) ** 2 + (p[p.length - 2] - cy) ** 2;
            if (d0 < bestD) { bestD = d0; best = idx; rev = false; }
            if (d1 < bestD) { bestD = d1; best = idx; rev = true; }
          }
        }
      }
      if (best >= 0 && stopAt === Infinity) stopAt = r + 1;
    }
    if (best < 0) { best = used.indexOf(0); rev = false; }
    used[best] = 1;
    const p = rev ? reversed(polys[best]) : polys[best];
    out.push(p);
    cx = p[p.length - 3]; cy = p[p.length - 2];
  }
  return { order: out, x: cx, y: cy };
}

function reversed(p) {
  const n = p.length / 3, q = new Array(p.length);
  for (let i = 0; i < n; i++) {
    const s = (n - 1 - i) * 3;
    q[i * 3] = p[s]; q[i * 3 + 1] = p[s + 1]; q[i * 3 + 2] = p[s + 2];
  }
  return q;
}

/** Order all cuts according to the options. */
function sequence(gen, grid, carve, opt, sx, sy) {
  const passes = gen.passes;
  if (!opt.byRegion) {
    const seq = [];
    let x = sx, y = sy;
    for (const pass of passes) {
      const r = nnOrder(pass.polys, x, y);
      seq.push(...r.order); x = r.x; y = r.y;
    }
    return seq;
  }
  const { lab, count } = labelRegions(carve, grid.W, grid.H);
  // groups[region] = array per pass
  const groups = new Map();
  passes.forEach((pass, pi) => {
    for (const p of pass.polys) {
      const reg = regionOf(lab, grid, p[0], p[1]);
      let g = groups.get(reg);
      if (!g) groups.set(reg, g = passes.map(() => []));
      g[pi].push(p);
    }
  });
  void count;
  const seq = [];
  let x = sx, y = sy;
  const left = new Set(groups.keys());
  while (left.size) {
    // nearest region: closest end point of any cut in its first pass
    let bestReg = -1, bestD = Infinity;
    for (const reg of left) {
      const g = groups.get(reg);
      const first = g.find(a => a.length) || [];
      for (const p of first) {
        const d = Math.min((p[0] - x) ** 2 + (p[1] - y) ** 2, (p[p.length - 3] - x) ** 2 + (p[p.length - 2] - y) ** 2);
        if (d < bestD) { bestD = d; bestReg = reg; }
      }
    }
    if (bestReg < 0) bestReg = left.values().next().value;
    left.delete(bestReg);
    for (const polys of groups.get(bestReg)) {
      if (!polys.length) continue;
      const r = nnOrder(polys, x, y);
      seq.push(...r.order); x = r.x; y = r.y;
    }
  }
  return seq;
}

/**
 * Build an optimised machine program.
 * opt: { byRegion, link, linkDist, retract }
 */
export function buildOptimizedProgram(gen, grid, carve, tool, m, opt) {
  const { tanHalf } = toolGeometry(tool);
  const D = gen.df.D;
  const { W, H, cell } = grid;
  const maxDepth = gen.maxDepth;

  /** Finished V-carve depth (mm, positive) allowed at (x, y). */
  const allowed = (x, y) => {
    const fi = x / cell - 0.5, fj = y / cell - 0.5;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    let d = Infinity;
    for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
      const i = i0 + di, j = j0 + dj;
      d = Math.min(d, i < 0 || j < 0 || i >= W || j >= H ? 0 : D[j * W + i]);
    }
    return Math.min(d / tanHalf, maxDepth);
  };
  const linkSafe = (ax, ay, az, bx, by, bz) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len > opt.linkDist) return false;
    const n = Math.max(1, Math.ceil(len / (cell * 0.5)));
    for (let s = 0; s <= n; s++) {
      const f = s / n;
      const z = az + (bz - az) * f;
      if (z >= 0) continue;
      if (-z > allowed(ax + (bx - ax) * f, ay + (by - ay) * f) + 0.02) return false;
    }
    return true;
  };

  const seq = sequence(gen, grid, carve, opt, 0, 0);
  const clear = Math.max(0.2, Math.min(opt.retract, m.safeZ));
  const X = [], Y = [], Z = [], T = [];
  const push = (x, y, z, t) => { X.push(x); Y.push(y); Z.push(z); T.push(t); };
  push(0, 0, m.safeZ, 0);
  let links = 0, lifts = 0;
  let prev = null;
  for (const p of seq) {
    const x0 = p[0], y0 = p[1], z0 = p[2];
    if (prev && opt.link && linkSafe(prev[0], prev[1], prev[2], x0, y0, z0)) {
      push(x0, y0, z0, z0 < prev[2] - 0.05 && Math.hypot(x0 - prev[0], y0 - prev[1]) < 0.05 ? 2 : 1);
      links++;
    } else {
      const travelZ = prev ? clear : m.safeZ;
      if (prev) { push(prev[0], prev[1], clear, 0); lifts++; }
      push(x0, y0, travelZ, 0);
      const above = Math.min(z0 + 0.5, clear);
      if (above < travelZ) push(x0, y0, above, 0);
      push(x0, y0, z0, 2);
    }
    for (let i = 3; i < p.length; i += 3) push(p[i], p[i + 1], p[i + 2], 1);
    prev = [p[p.length - 3], p[p.length - 2], p[p.length - 1]];
  }
  if (prev) push(prev[0], prev[1], m.safeZ, 0);
  push(0, 0, m.safeZ, 0);
  const P = finishProgram({ X, Y, Z, T }, m);
  P.optStats = { links, lifts: lifts + (seq.length ? 1 : 0), cuts: seq.length };
  return P;
}
