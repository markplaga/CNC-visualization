// Material-removal simulation on a height field.
// The stock surface is z = 0; carving lowers cells to negative z. The V-bit is
// modelled as a cone (tip at the programmed point) capped by a cylinder of the
// bit's diameter, and swept along each move by stamping at sub-cell spacing.
import { toolGeometry, rateOf } from './vcarve.js';

export class CarveSim {
  constructor(grid) {
    this.grid = grid;
    this.height = new Float32Array(grid.W * grid.H);
    this.program = null;
    this.reset();
  }

  setTool(tool) {
    const g = toolGeometry(tool);
    this.tanHalf = g.tanHalf;
    this.R = g.R;
  }

  setMachine(m) { this.machine = m; }

  setProgram(prog) {
    this.program = prog;
    this.reset();
  }

  reset() {
    this.height.fill(0);
    this.seg = 1;          // segment index currently being executed (from seg-1 to seg)
    this.segT = 0;         // seconds into the current segment
    this.time = 0;         // machine time elapsed
    this.done = !this.program || this.program.n < 2;
    this.pos = this.program ? [this.program.X[0], this.program.Y[0], this.program.Z[0]] : [0, 0, 20];
    this.dirty = true;
  }

  /** Lower the height field by a cone with its tip at (x, y, z). */
  stamp(x, y, z) {
    if (z >= 0) return;
    const { cell, W, H } = this.grid;
    const t = this.tanHalf;
    const r = Math.min(this.R, -z * t);
    const ci = x / cell - 0.5, cj = y / cell - 0.5, rc = r / cell;
    const i0 = Math.max(0, Math.ceil(ci - rc)), i1 = Math.min(W - 1, Math.floor(ci + rc));
    const j0 = Math.max(0, Math.ceil(cj - rc)), j1 = Math.min(H - 1, Math.floor(cj + rc));
    const r2 = r * r, inv = 1 / t, h = this.height;
    for (let j = j0; j <= j1; j++) {
      const dy = (j - cj) * cell;
      const dy2 = dy * dy;
      if (dy2 > r2) continue;
      const row = j * W;
      for (let i = i0; i <= i1; i++) {
        const dx = (i - ci) * cell;
        const d2 = dx * dx + dy2;
        if (d2 > r2) continue;
        const zt = z + Math.sqrt(d2) * inv;
        if (zt < h[row + i]) h[row + i] = zt;
      }
    }
    this.dirty = true;
  }

  /** Sweep the tool between two points (inclusive of the end point). */
  sweep(x0, y0, z0, x1, y1, z1) {
    if (z0 >= 0 && z1 >= 0) return;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const step = this.grid.cell * 0.5;
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= n; s++) {
      const f = s / n;
      this.stamp(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f);
    }
  }

  /**
   * Advance the machine by `dt` seconds of machine time, but stop early after
   * roughly `budget` stamps so the UI stays responsive. Returns true when the
   * program has finished.
   */
  advance(dt, budget = Infinity) {
    const P = this.program;
    if (!P || this.done) return true;
    let remaining = dt;
    let work = 0;
    while (remaining > 0 && this.seg < P.n && work < budget) {
      const i = this.seg;
      const segDur = P.time[i] - P.time[i - 1];
      const x0 = P.X[i - 1], y0 = P.Y[i - 1], z0 = P.Z[i - 1];
      const x1 = P.X[i], y1 = P.Y[i], z1 = P.Z[i];
      const fa = segDur > 0 ? this.segT / segDur : 1;
      const tEnd = Math.min(segDur, this.segT + remaining);
      const fb = segDur > 0 ? tEnd / segDur : 1;
      const ax = x0 + (x1 - x0) * fa, ay = y0 + (y1 - y0) * fa, az = z0 + (z1 - z0) * fa;
      const bx = x0 + (x1 - x0) * fb, by = y0 + (y1 - y0) * fb, bz = z0 + (z1 - z0) * fb;
      this.sweep(ax, ay, az, bx, by, bz);
      work += Math.hypot(bx - ax, by - ay) / (this.grid.cell * 0.5) + 1;
      remaining -= tEnd - this.segT;
      this.pos = [bx, by, bz];
      if (tEnd >= segDur) { this.seg++; this.segT = 0; } else this.segT = tEnd;
    }
    this.time = this.seg < P.n ? P.time[this.seg - 1] + this.segT : P.totalTime;
    if (this.seg >= P.n) this.done = true;
    return this.done;
  }

  /** Run the remaining program as fast as possible (in chunks). */
  runToEnd(onProgress) {
    return new Promise((resolve) => {
      const tick = () => {
        const t0 = performance.now();
        while (!this.done && performance.now() - t0 < 40) this.advance(1e9, 20000);
        onProgress && onProgress();
        if (this.done) resolve(); else requestAnimationFrame(tick);
      };
      tick();
    });
  }

  get progress() {
    const P = this.program;
    return P && P.totalTime > 0 ? Math.min(1, this.time / P.totalTime) : 0;
  }

  get currentRate() {
    const P = this.program;
    if (!P || this.done) return 0;
    return rateOf(P, this.seg, this.machine);
  }
}
