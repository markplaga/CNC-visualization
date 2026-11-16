// V-carve engine: distance field, toolpath generation and machine program.
//
// The key fact behind V-carving: a V-bit with included angle θ whose tip is
// at depth z cuts a circle of radius r = z·tan(θ/2) at the surface. If the
// tip is driven along the medial axis of a shape, at depth
//     z(p) = D(p) / tan(θ/2)        (D = distance to the nearest edge)
// the cone just touches the outline everywhere, giving crisp sloped walls
// and sharp corners. When z exceeds the allowed depth the bottom becomes
// flat and has to be cleared with extra offset passes.

const BIG = 1e12;

/** Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
 *  mask: Uint8Array, 1 = inside. Returns, for every inside cell, the squared
 *  distance (in cells) to the nearest outside cell. The area beyond the grid
 *  edge counts as outside. */
export function edtSquared(mask, W, H) {
  const PW = W + 2, PH = H + 2;
  const g = new Float64Array(PW * PH);
  for (let j = 0; j < PH; j++) {
    for (let i = 0; i < PW; i++) {
      const inside = i > 0 && j > 0 && i <= W && j <= H && mask[(j - 1) * W + (i - 1)];
      g[j * PW + i] = inside ? BIG : 0;
    }
  }
  const n = Math.max(PW, PH);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  // columns
  for (let i = 0; i < PW; i++) {
    for (let j = 0; j < PH; j++) f[j] = g[j * PW + i];
    edt1d(f, PH, d, v, z);
    for (let j = 0; j < PH; j++) g[j * PW + i] = d[j];
  }
  // rows
  for (let j = 0; j < PH; j++) {
    const o = j * PW;
    for (let i = 0; i < PW; i++) f[i] = g[o + i];
    edt1d(f, PW, d, v, z);
    for (let i = 0; i < PW; i++) g[o + i] = d[i];
  }
  const out = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) out[j * W + i] = mask[j * W + i] ? g[(j + 1) * PW + (i + 1)] : 0;
  return out;
}

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (mm) from each carve cell centre to the design edge. */
export function distanceField(carve, grid) {
  const { W, H, cell } = grid;
  const d2 = edtSquared(carve, W, H);
  const D = new Float32Array(W * H);
  let max = 0;
  const box = { i0: W, j0: H, i1: -1, j1: -1 };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!carve[k]) continue;
      const v = Math.max(0.05, Math.sqrt(d2[k]) - 0.5) * cell;
      D[k] = v;
      if (v > max) max = v;
      if (i < box.i0) box.i0 = i; if (i > box.i1) box.i1 = i;
      if (j < box.j0) box.j0 = j; if (j > box.j1) box.j1 = j;
    }
  }
  return { D, max, box };
}

/** Tool description helper. */
export function toolGeometry(tool) {
  const half = (tool.angle * Math.PI) / 360;
  const tanHalf = Math.tan(half);
  const R = tool.diameter / 2;
  const coneLen = R / tanHalf;
  return { tanHalf, R, coneLen };
}

/** The ideal finished surface for a V-bit (negative = below the face). */
export function idealSurface(df, grid, tool, maxDepth) {
  const { tanHalf } = toolGeometry(tool);
  const out = new Float32Array(df.D.length);
  for (let k = 0; k < out.length; k++) if (df.D[k] > 0) out[k] = -Math.min(df.D[k] / tanHalf, maxDepth);
  return out;
}

// ---------------------------------------------------------------------------
// Toolpath generation. A polyline is a flat array [x, y, z, x, y, z, ...] in mm.

export function generateToolpaths(carve, grid, opts) {
  const t0 = performance.now();
  const { tanHalf, coneLen } = toolGeometry(opts.tool);
  const warnings = [];
  let maxDepth = opts.maxDepth;
  if (maxDepth > coneLen) {
    warnings.push(`Max depth ${opts.maxDepth.toFixed(1)} mm exceeds the cutting length of the cone (${coneLen.toFixed(1)} mm); limited to ${coneLen.toFixed(1)} mm.`);
    maxDepth = coneLen;
  }
  const df = distanceField(carve, grid);
  if (df.max <= 0) return { passes: [], df, maxDepth, warnings: ['Nothing to carve.'], stats: {} };

  const Lcap = maxDepth * tanHalf;          // distance where the flat bottom starts
  const zOf = (D) => -Math.min(D / tanHalf, maxDepth);
  const step = Math.max(grid.cell * 0.5, opts.stepover);
  let polys = [];

  if (opts.strategy === 'raster') {
    polys = rasterPaths(df, grid, step, zOf);
  } else {
    if (opts.strategy === 'offset') {
      for (let L = step; L < df.max; L += step) polys.push(...contourPolys(df, grid, L, zOf));
    } else if (df.max > Lcap) {
      // flat-bottom clearing with the V-bit tip, starting at the flat boundary
      for (let L = Lcap; L < df.max; L += step) polys.push(...contourPolys(df, grid, L, zOf));
    }
    polys.push(...medialAxisPolys(df, grid, zOf));
  }

  polys = polys.map(p => simplify(p, 0.01)).filter(p => p.length >= 6);
  const deepest = polys.reduce((m, p) => { for (let i = 2; i < p.length; i += 3) m = Math.min(m, p[i]); return m; }, 0);

  // depth passes
  const passDepth = opts.passDepth > 0 ? opts.passDepth : Infinity;
  const nPasses = Math.max(1, Math.ceil(-deepest / passDepth - 1e-6));
  const passes = [];
  for (let p = 1; p <= nPasses; p++) {
    const lim = Math.min(p * passDepth, -deepest);
    const prev = (p - 1) * passDepth;
    let out = [];
    for (const poly of polys) out.push(...clipPass(poly, prev, lim));
    out = out.filter(q => q.length >= 6);
    if (opts.strategy !== 'raster') out = orderPolys(out);
    passes.push({ limit: lim, polys: out });
  }

  return {
    passes, df, maxDepth, warnings,
    stats: { computeMs: performance.now() - t0, deepest: -deepest, maxWidth: df.max * 2 },
  };
}

/** Keep the part of a polyline that is deeper than `prev`, clamped to `lim`. */
function clipPass(poly, prev, lim) {
  const out = [];
  let cur = null;
  const n = poly.length / 3;
  const deep = (i) => -poly[i * 3 + 2] > prev + 1e-4;
  for (let i = 0; i < n; i++) {
    const keep = deep(i) || (i > 0 && deep(i - 1)) || (i < n - 1 && deep(i + 1));
    if (keep) {
      if (!cur) { cur = []; out.push(cur); }
      cur.push(poly[i * 3], poly[i * 3 + 1], Math.max(poly[i * 3 + 2], -lim));
    } else cur = null;
  }
  return out;
}

// --- raster ----------------------------------------------------------------
function rasterPaths(df, grid, step, zOf) {
  const { W, cell } = grid;
  const { D, box } = df;
  const rowStep = Math.max(1, Math.round(step / cell));
  const polys = [];
  let flip = false;
  for (let j = box.j0; j <= box.j1; j += rowStep) {
    const runs = [];
    let cur = null;
    for (let i = box.i0; i <= box.i1 + 1; i++) {
      const v = i <= box.i1 ? D[j * W + i] : 0;
      if (v > 0) {
        if (!cur) { cur = []; runs.push(cur); }
        cur.push((i + 0.5) * cell, (j + 0.5) * cell, zOf(v));
      } else cur = null;
    }
    if (flip) { runs.reverse(); runs.forEach(reversePoly); }
    polys.push(...runs);
    flip = !flip;
  }
  return polys;
}

// --- marching squares contours --------------------------------------------
// Segment table: corners a=(i,j) b=(i+1,j) c=(i+1,j+1) d=(i,j+1);
// edges 0=ab(bottom) 1=bc(right) 2=dc(top) 3=ad(left)
const MS = {
  1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]],
  8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]],
};

export function contourPolys(df, grid, L, zOf) {
  const { W, cell } = grid;
  const { D, box } = df;
  const i0 = Math.max(0, box.i0 - 1), j0 = Math.max(0, box.j0 - 1);
  const i1 = Math.min(grid.W - 2, box.i1 + 1), j1 = Math.min(grid.H - 2, box.j1 + 1);
  const pts = new Map();      // edgeKey -> [x, y]
  const adj = new Map();      // edgeKey -> [edgeKey, edgeKey?]
  const z = zOf(L);

  const edgePoint = (key, i, j, e) => {
    if (pts.has(key)) return;
    let ia, ja, ib, jb;
    switch (e) {
      case 0: ia = i; ja = j; ib = i + 1; jb = j; break;
      case 1: ia = i + 1; ja = j; ib = i + 1; jb = j + 1; break;
      case 2: ia = i; ja = j + 1; ib = i + 1; jb = j + 1; break;
      default: ia = i; ja = j; ib = i; jb = j + 1;
    }
    const fa = D[ja * W + ia], fb = D[jb * W + ib];
    const t = (L - fa) / (fb - fa);
    pts.set(key, [(ia + t * (ib - ia) + 0.5) * cell, (ja + t * (jb - ja) + 0.5) * cell]);
  };
  const link = (a, b) => {
    let la = adj.get(a); if (!la) adj.set(a, la = []); la.push(b);
    let lb = adj.get(b); if (!lb) adj.set(b, lb = []); lb.push(a);
  };

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const a = D[j * W + i], b = D[j * W + i + 1], c = D[(j + 1) * W + i + 1], d = D[(j + 1) * W + i];
      const code = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
      if (code === 0 || code === 15) continue;
      let segs = MS[code];
      if (code === 5 || code === 10) {
        const centre = (a + b + c + d) / 4 > L;
        segs = (code === 5) === centre ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      }
      const keys = [
        (j * W + i) * 2, (j * W + i + 1) * 2 + 1, ((j + 1) * W + i) * 2, (j * W + i) * 2 + 1,
      ];
      for (const [e1, e2] of segs) {
        edgePoint(keys[e1], i, j, e1);
        edgePoint(keys[e2], i, j, e2);
        link(keys[e1], keys[e2]);
      }
    }
  }

  // chain segments into polylines
  const used = new Set();
  const polys = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const chain = [start];
    used.add(start);
    for (let dir = 0; dir < 2; dir++) {
      let cur = dir === 0 ? start : chain[0];
      for (;;) {
        const nb = (adj.get(cur) || []).find(k => !used.has(k));
        if (nb === undefined) break;
        used.add(nb);
        if (dir === 0) chain.push(nb); else chain.unshift(nb);
        cur = nb;
      }
    }
    // closed loop?
    const first = chain[0], last = chain[chain.length - 1];
    const closed = chain.length > 2 && (adj.get(last) || []).includes(first);
    const poly = [];
    for (const k of chain) { const p = pts.get(k); poly.push(p[0], p[1], z); }
    if (closed) poly.push(poly[0], poly[1], z);
    polys.push(poly);
  }
  return polys;
}

// --- medial axis ----------------------------------------------------------
export function medialAxisPolys(df, grid, zOf) {
  const { W, H, cell } = grid;
  const { D, box } = df;
  const S = new Uint8Array(W * H);
  const thr = 0.3 * cell;
  const i0 = Math.max(1, box.i0), i1 = Math.min(W - 2, box.i1);
  const j0 = Math.max(1, box.j0), j1 = Math.min(H - 2, box.j1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * W + i;
      const v = D[k];
      if (v <= 0) continue;
      // local maximum across at least one of the four directions
      const pairs = [[k - 1, k + 1, 1], [k - W, k + W, 1], [k - W - 1, k + W + 1, Math.SQRT2], [k - W + 1, k + W - 1, Math.SQRT2]];
      for (const [p, q, len] of pairs) {
        const a = D[p], b = D[q];
        if (v >= a && v >= b && v - (a + b) / 2 > thr * len) { S[k] = 1; break; }
      }
      // narrow strokes (1-2 cells wide) are always part of the axis
      if (!S[k] && v <= cell * 0.6) S[k] = 1;
    }
  }
  thin(S, W, j0, j1, i0, i1);
  return skeletonToPolys(S, D, grid, zOf, i0, i1, j0, j1);
}

/** Zhang–Suen thinning restricted to a box. */
function thin(S, W, j0, j1, i0, i1) {
  const del = [];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (let sub = 0; sub < 2; sub++) {
      del.length = 0;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * W + i;
          if (!S[k]) continue;
          // neighbours P2..P9 clockwise from north (north = +y)
          const p2 = S[k + W], p3 = S[k + W + 1], p4 = S[k + 1], p5 = S[k - W + 1];
          const p6 = S[k - W], p7 = S[k - W - 1], p8 = S[k - 1], p9 = S[k + W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let s = 0; s < 8; s++) if (!seq[s] && seq[s + 1]) A++;
          if (A !== 1) continue;
          if (sub === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else if (p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(k);
        }
      }
      for (const k of del) S[k] = 0;
      if (del.length) changed = true;
    }
  }
}

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function skeletonToPolys(S, D, grid, zOf, i0, i1, j0, j1) {
  const { W, cell } = grid;
  const nbrs = (k) => {
    const out = [];
    for (let d = 0; d < 8; d++) {
      const [dx, dy] = DIRS[d];
      const q = k + dx + dy * W;
      if (!S[q]) continue;
      if (d & 1) { // diagonal: skip if an orthogonal path exists
        if (S[k + dx] || S[k + dy * W]) continue;
      }
      out.push([q, d]);
    }
    return out;
  };
  const visited = new Uint8Array(S.length); // bitmask per direction
  const mark = (k, d, q) => { visited[k] |= 1 << d; visited[q] |= 1 << ((d + 4) & 7); };
  const point = (k, poly) => {
    const i = k % W, j = (k - i) / W;
    poly.push((i + 0.5) * cell, (j + 0.5) * cell, zOf(D[k]));
  };
  const walk = (k, first) => {
    const poly = [];
    point(k, poly);
    let [q, d] = first;
    mark(k, d, q);
    for (;;) {
      point(q, poly);
      const nb = nbrs(q).filter(([, dd]) => !(visited[q] & (1 << dd)));
      const deg = nbrs(q).length;
      if (deg !== 2 || nb.length === 0) break;
      const [r, dd] = nb[0];
      mark(q, dd, r);
      q = r;
    }
    return poly;
  };

  const polys = [];
  const lone = [];
  // start at endpoints / junctions first
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const k = j * W + i;
    if (!S[k]) continue;
    const nb = nbrs(k);
    if (nb.length === 0) { lone.push(k); continue; }
    if (nb.length === 2) continue;
    for (const e of nb) if (!(visited[k] & (1 << e[1]))) polys.push(walk(k, e));
  }
  // remaining simple loops
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const k = j * W + i;
    if (!S[k]) continue;
    for (const e of nbrs(k)) if (!(visited[k] & (1 << e[1]))) polys.push(walk(k, e));
  }
  // isolated dots: tiny plunge
  for (const k of lone) {
    const p = []; point(k, p); p.push(p[0] + 0.01, p[1], p[2]); polys.push(p);
  }
  return polys;
}

// --- polyline utilities ----------------------------------------------------
function reversePoly(p) {
  const n = p.length / 3;
  for (let a = 0, b = n - 1; a < b; a++, b--) {
    for (let c = 0; c < 3; c++) { const t = p[a * 3 + c]; p[a * 3 + c] = p[b * 3 + c]; p[b * 3 + c] = t; }
  }
}

/** Remove points that lie within `tol` of the line through their neighbours. */
export function simplify(p, tol) {
  const n = p.length / 3;
  if (n < 3) return p;
  const out = [p[0], p[1], p[2]];
  let ax = p[0], ay = p[1], az = p[2];
  for (let i = 1; i < n - 1; i++) {
    const bx = p[i * 3], by = p[i * 3 + 1], bz = p[i * 3 + 2];
    const cx = p[i * 3 + 3], cy = p[i * 3 + 4], cz = p[i * 3 + 5];
    // distance of b from segment a-c
    const ux = cx - ax, uy = cy - ay, uz = cz - az;
    const L2 = ux * ux + uy * uy + uz * uz;
    let dist;
    if (L2 < 1e-12) dist = Math.hypot(bx - ax, by - ay, bz - az);
    else {
      const t = ((bx - ax) * ux + (by - ay) * uy + (bz - az) * uz) / L2;
      dist = Math.hypot(ax + t * ux - bx, ay + t * uy - by, az + t * uz - bz);
    }
    if (dist > tol || (out.length / 3) % 64 === 0) { out.push(bx, by, bz); ax = bx; ay = by; az = bz; }
  }
  out.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
  return out;
}

/** Greedy nearest-neighbour ordering (with reversal) to cut down air moves. */
function orderPolys(polys) {
  if (polys.length < 2) return polys;
  const n = polys.length;
  const cs = 25; // mm buckets
  const buckets = new Map();
  const key = (x, y) => `${Math.floor(x / cs)},${Math.floor(y / cs)}`;
  const ends = polys.map(p => [p[0], p[1], p[p.length - 3], p[p.length - 2]]);
  const add = (idx) => {
    const e = ends[idx];
    for (const [x, y] of [[e[0], e[1]], [e[2], e[3]]]) {
      const kk = key(x, y);
      let b = buckets.get(kk); if (!b) buckets.set(kk, b = new Set()); b.add(idx);
    }
  };
  for (let i = 0; i < n; i++) add(i);
  const used = new Uint8Array(n);
  const out = [];
  let cx = 0, cy = 0;
  for (let c = 0; c < n; c++) {
    let best = -1, bestD = Infinity, bestRev = false;
    const bx = Math.floor(cx / cs), by = Math.floor(cy / cs);
    let stopAt = 400;
    for (let r = 0; r <= stopAt; r++) {
      for (let gx = bx - r; gx <= bx + r; gx++) for (let gy = by - r; gy <= by + r; gy++) {
        if (Math.max(Math.abs(gx - bx), Math.abs(gy - by)) !== r) continue;
        const b = buckets.get(`${gx},${gy}`);
        if (!b) continue;
        for (const idx of b) {
          const e = ends[idx];
          const d0 = (e[0] - cx) ** 2 + (e[1] - cy) ** 2;
          const d1 = (e[2] - cx) ** 2 + (e[3] - cy) ** 2;
          if (d0 < bestD) { bestD = d0; best = idx; bestRev = false; }
          if (d1 < bestD) { bestD = d1; best = idx; bestRev = true; }
        }
      }
      // scan one extra ring after the first hit so a closer end isn't missed
      if (best >= 0 && stopAt === 400) stopAt = r + 1;
    }
    if (best < 0) { best = used.indexOf(0); bestRev = false; }
    used[best] = 1;
    const e = ends[best];
    for (const [x, y] of [[e[0], e[1]], [e[2], e[3]]]) buckets.get(key(x, y))?.delete(best);
    const p = polys[best];
    if (bestRev) reversePoly(p);
    out.push(p);
    cx = p[p.length - 3]; cy = p[p.length - 2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Machine program: a flat list of moves.  type 0 = rapid, 1 = feed, 2 = plunge.

export function buildProgram(passes, m) {
  const X = [], Y = [], Z = [], T = [];
  const push = (x, y, z, t) => { X.push(x); Y.push(y); Z.push(z); T.push(t); };
  push(0, 0, m.safeZ, 0);
  for (const pass of passes) {
    for (const p of pass.polys) {
      push(p[0], p[1], m.safeZ, 0);
      push(p[0], p[1], Math.min(p[2] + 1, m.safeZ), 0); // rapid to just above
      push(p[0], p[1], p[2], 2);
      for (let i = 3; i < p.length; i += 3) push(p[i], p[i + 1], p[i + 2], 1);
      push(p[p.length - 3], p[p.length - 2], m.safeZ, 0);
    }
  }
  push(0, 0, m.safeZ, 0);
  return finishProgram({ X, Y, Z, T }, m);
}

/** Convert arrays to typed arrays and compute cumulative machine time. */
export function finishProgram(prog, m) {
  const n = prog.X.length;
  const P = {
    X: Float32Array.from(prog.X), Y: Float32Array.from(prog.Y), Z: Float32Array.from(prog.Z),
    T: Uint8Array.from(prog.T), F: prog.F ? Float32Array.from(prog.F) : null,
    time: new Float64Array(n), n,
  };
  let t = 0, cut = 0, rapid = 0;
  for (let i = 1; i < n; i++) {
    const len = Math.hypot(P.X[i] - P.X[i - 1], P.Y[i] - P.Y[i - 1], P.Z[i] - P.Z[i - 1]);
    const rate = rateOf(P, i, m);
    t += (len / rate) * 60;
    P.time[i] = t;
    if (P.T[i] === 0) rapid += len; else cut += len;
  }
  P.totalTime = t; P.cutLength = cut; P.rapidLength = rapid;
  return P;
}

export function rateOf(P, i, m) {
  if (P.T[i] === 0) return m.rapid;
  if (P.F && P.F[i] > 0) return P.F[i];
  return P.T[i] === 2 ? m.plunge : m.feed;
}
