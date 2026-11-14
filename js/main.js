import { SHAPES } from './headstone.js';
import { FONTS, SYMBOLS, makeGrid, buildDesign } from './design.js';
import { generateToolpaths, buildProgram, idealSurface, toolGeometry } from './vcarve.js';
import { CarveSim } from './simulator.js';
import { Viewer, STONES, FILLS } from './renderer.js';
import { exportGcode, parseGcode, formatTime } from './gcode.js';
import { collectSettings, applySettings, loadImage, saveLocal, readLocal, clearLocal } from './settings.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// state
const state = {
  lines: [
    { text: 'IN LOVING MEMORY OF', font: 'Cinzel', size: 11, y: 350, bold: false },
    { text: 'ELEANOR MAY HARTLEY', font: 'Cinzel', size: 30, y: 300, bold: true },
    { text: 'MARCH 3, 1931 – JUNE 18, 2019', font: 'Cinzel', size: 13, y: 245, bold: false },
    { text: 'Forever in our hearts', font: 'Great Vibes', size: 24, y: 170, bold: false },
  ],
  image: null,           // { img, name, src (data URL) }
  grid: null,
  design: null,          // { outlinePts, outline, carve }
  gen: null,             // toolpath generation result
  program: null,
  imported: null,        // { name, program }
  sim: null,
  playing: false,
  previewing: false,
  stoneKey: '',
};

const viewer = new Viewer($('canvas'));

// ---------------------------------------------------------------------------
// populate selects
function fillSelect(sel, map, value) {
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(map)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = typeof v === 'string' ? v : v.label;
    sel.appendChild(o);
  }
  if (value) sel.value = value;
}
fillSelect($('shape'), SHAPES, 'serpentine');
fillSelect($('stone'), STONES, 'black');
fillSelect($('symbol'), SYMBOLS, 'cross');
fillSelect($('fill'), FILLS, 'none');

// ---------------------------------------------------------------------------
// lettering editor
function renderLines() {
  const host = $('lines');
  host.innerHTML = '';
  state.lines.forEach((ln, idx) => {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = `
      <input class="text" type="text" placeholder="Text" aria-label="Line ${idx + 1} text">
      <button class="del small" title="Remove line">✕</button>
      <div class="opts">
        <label>Font <select class="font"></select></label>
        <label>Height mm <input class="size" type="number" min="2" max="300" step="0.5"></label>
        <label>Centre Y mm <input class="y" type="number" step="1"></label>
      </div>
      <label class="check" style="grid-column:1/3"><input class="bold" type="checkbox"> Bold</label>`;
    const text = row.querySelector('.text');
    const font = row.querySelector('.font');
    const size = row.querySelector('.size');
    const y = row.querySelector('.y');
    const bold = row.querySelector('.bold');
    fillSelect(font, FONTS, ln.font);
    text.value = ln.text; size.value = ln.size; y.value = ln.y; bold.checked = !!ln.bold;
    const upd = () => {
      ln.text = text.value; ln.font = font.value; ln.size = +size.value || 10;
      ln.y = +y.value || 0; ln.bold = bold.checked;
      schedule('design');
    };
    [text, font, size, y, bold].forEach(el => el.addEventListener('input', upd));
    row.querySelector('.del').addEventListener('click', () => {
      state.lines.splice(idx, 1); renderLines(); schedule('design');
    });
    host.appendChild(row);
  });
}
renderLines();
$('addLine').addEventListener('click', () => {
  const lowest = state.lines.reduce((m, l) => Math.min(m, l.y), +$('height').value);
  state.lines.push({ text: 'New line', font: 'Cinzel', size: 14, y: Math.max(40, lowest - 45), bold: false });
  renderLines(); schedule('design');
});

// ---------------------------------------------------------------------------
// config readers
const num = (id) => parseFloat($(id).value);

function stoneCfg() {
  return {
    shape: $('shape').value, width: num('width'), height: num('height'),
    thickness: num('thickness'), rise: num('rise'), corner: num('corner'), res: num('res'),
  };
}
function designCfg() {
  const s = stoneCfg();
  return {
    ...s,
    lines: state.lines.map(l => ({ ...l, weight: l.bold ? 700 : 400 })),
    symbol: $('symbol').value, symbolSize: num('symbolSize'), symbolY: num('symbolY'), symbolX: num('symbolX'),
    border: $('border').checked, borderInset: num('borderInset'), borderWidth: num('borderWidth'),
    image: state.image ? {
      img: state.image.img, width: num('imgW'), threshold: num('imgThr'),
      x: num('imgX'), y: num('imgY'), invert: $('imgInv').checked,
    } : null,
  };
}
function toolCfg() {
  return { angle: num('angle'), diameter: num('diameter') };
}
function cutCfg() {
  return {
    tool: toolCfg(), maxDepth: num('maxDepth'), passDepth: num('passDepth'),
    strategy: $('strategy').value, stepover: num('stepover'),
  };
}
function machineCfg() {
  return {
    feed: num('feed'), plunge: num('plunge'), rpm: num('rpm'), safeZ: num('safeZ'),
    rapid: num('rapid'), coolant: $('coolant').checked,
  };
}

// ---------------------------------------------------------------------------
// pipeline: stone -> design -> toolpath -> program
const LEVEL = { look: 0, machine: 1, toolpath: 2, design: 3, stone: 4 };
let pending = -1, timer = 0, runId = 0;

function schedule(kind) {
  autosave();
  pending = Math.max(pending, LEVEL[kind]);
  clearTimeout(timer);
  timer = setTimeout(() => { const k = pending; pending = -1; run(k); }, 300);
}

async function run(level) {
  const id = ++runId;
  $('busy').hidden = false;
  await new Promise(r => setTimeout(r, 20)); // let the label paint
  try {
    if (level >= LEVEL.design || !state.grid) {
      const s = stoneCfg();
      const grid = makeGrid(s.width, s.height, s.res);
      const design = await buildDesign(designCfg(), grid);
      if (id !== runId) return;
      const stoneChanged = !state.grid || level >= LEVEL.stone;
      const reframe = !state.grid || state.grid.widthMM !== grid.widthMM || state.grid.heightMM !== grid.heightMM;
      state.design = design;
      if (stoneChanged || !state.sim || state.grid.W !== grid.W || state.grid.H !== grid.H) {
        state.grid = grid;
        state.sim = new CarveSim(grid);
        viewer.buildStone(grid, design.outlinePts, design.outline, design.carve, s.thickness, state.sim.height);
        if (reframe) viewer.frame();
        applyLook();
      } else {
        viewer.setDesignMask(design.carve);
      }
      state.imported = null;
      $('useGen').hidden = true;
    }
    if (level >= LEVEL.toolpath || !state.gen) {
      state.gen = generateToolpaths(state.design.carve, state.grid, cutCfg());
      viewer.setTool(toolCfg());
    }
    if (level >= LEVEL.machine || !state.program) {
      state.program = buildProgram(state.gen.passes, machineCfg());
    }
    if (level >= LEVEL.machine) loadProgram(state.imported ? state.imported.program : state.program);
    applyLook();
  } catch (err) {
    console.error(err);
    showWarnings([`Error: ${err.message}`]);
  } finally {
    if (id === runId) $('busy').hidden = true;
  }
}

function loadProgram(P) {
  const sim = state.sim;
  sim.setTool(toolCfg());
  sim.setMachine(machineCfg());
  sim.setProgram(P);
  setPlaying(false);
  state.previewing = false;
  viewer.heightChanged();
  viewer.setToolpath(P, state.gen ? state.gen.maxDepth : num('maxDepth'));
  viewer.setToolPos(P.X[0], P.Y[0], P.Z[0]);
  updateStats();
  updateReadout();
}

function applyLook() {
  autosave();
  viewer.setStone($('stone').value);
  viewer.setFill($('fill').value, { color: $('fillColor').value, metal: $('fillMetal').checked });
  if (viewer.faceMat) viewer.faceMat.uniforms.uFillDepth.value = num('fillDepth');
  viewer.setLayout($('showLayout').checked);
  viewer.showToolpath($('showPath').checked);
  viewer.showTool($('showTool').checked);
}

// ---------------------------------------------------------------------------
// stats & warnings
function updateStats() {
  const P = state.sim.program;
  const g = state.gen;
  const { coneLen } = toolGeometry(toolCfg());
  const rows = [];
  if (state.imported) {
    rows.push(['Program', state.imported.name]);
  } else if (g) {
    rows.push(['Strategy', $('strategy').selectedOptions[0].textContent]);
    rows.push(['Depth passes', g.passes.length]);
    rows.push(['Toolpath segments', g.passes.reduce((s, p) => s + p.polys.length, 0).toLocaleString()]);
    rows.push(['Deepest cut', `${(g.stats.deepest || 0).toFixed(2)} mm`]);
    rows.push(['Widest stroke', `${(g.stats.maxWidth || 0).toFixed(1)} mm`]);
  }
  rows.push(['Cutting distance', `${(P.cutLength / 1000).toFixed(2)} m`]);
  rows.push(['Rapid distance', `${(P.rapidLength / 1000).toFixed(2)} m`]);
  rows.push(['Estimated run time', formatTime(P.totalTime)]);
  rows.push(['Bit cone length', `${coneLen.toFixed(2)} mm`]);
  rows.push(['Grid', `${state.grid.W} × ${state.grid.H} cells`]);
  $('stats').innerHTML = '<table>' + rows.map(([a, b]) => `<tr><td>${a}</td><td>${escapeHtml(String(b))}</td></tr>`).join('') + '</table>';

  const warn = [...(g && !state.imported ? g.warnings : [])];
  if (g && g.stats.deepest > 0 && num('passDepth') > 2) warn.push('Stone is usually carved in shallow passes (0.5–2 mm) to protect the bit.');
  showWarnings(warn);
}
function showWarnings(list) {
  $('warnings').innerHTML = list.map(w => `<div>⚠ ${escapeHtml(w)}</div>`).join('');
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// simulation controls
function speedFactor() { return Math.pow(10, (num('speed') / 100) * 3.4); } // 1x .. ~2500x
function updateSpeedLabel() {
  const s = speedFactor();
  $('speedLbl').textContent = (s < 10 ? s.toFixed(1) : Math.round(s)) + '×';
}
updateSpeedLabel();
$('speed').addEventListener('input', () => { updateSpeedLabel(); autosave(); });

function setPlaying(on) {
  state.playing = on;
  $('play').textContent = on ? '❚❚ Pause' : (state.sim && state.sim.time > 0 && !state.sim.done ? '▶ Resume' : '▶ Carve');
  $('play').classList.toggle('running', on);
}

$('play').addEventListener('click', () => {
  const sim = state.sim;
  if (!sim) return;
  if (state.previewing || sim.done) { sim.reset(); state.previewing = false; viewer.heightChanged(); }
  setPlaying(!state.playing);
});
$('reset').addEventListener('click', () => {
  if (!state.sim) return;
  state.sim.reset(); state.previewing = false;
  setPlaying(false); viewer.heightChanged(); syncTool(); updateReadout();
});
$('finish').addEventListener('click', async () => {
  const sim = state.sim;
  if (!sim) return;
  if (state.previewing) { sim.reset(); state.previewing = false; }
  setPlaying(false);
  $('busy').hidden = false; $('busy').textContent = 'Carving…';
  await sim.runToEnd(() => { viewer.heightChanged(); syncTool(); updateReadout(); });
  $('busy').hidden = true; $('busy').textContent = 'Computing toolpath…';
  setPlaying(false);
});
$('preview').addEventListener('click', () => {
  if (!state.sim || !state.gen) return;
  setPlaying(false);
  const ideal = idealSurface(state.gen.df, state.grid, toolCfg(), state.gen.maxDepth);
  state.sim.reset();
  state.sim.height.set(ideal);
  state.previewing = true;
  viewer.heightChanged();
  updateReadout('Ideal V-carve result (not simulated)');
});
$('frame').addEventListener('click', () => viewer.frame());

function syncTool() {
  const p = state.sim.pos;
  viewer.setToolPos(p[0], p[1], p[2]);
}
function updateReadout(msg) {
  const sim = state.sim;
  if (!sim || !sim.program) return;
  $('bar').style.width = (sim.progress * 100).toFixed(2) + '%';
  if (msg) { $('readout').textContent = msg; return; }
  const p = sim.pos;
  $('readout').textContent = `${formatTime(sim.time)} / ${formatTime(sim.program.totalTime)}  ·  X${p[0].toFixed(1)} Y${p[1].toFixed(1)} Z${p[2].toFixed(2)}`;
}

let last = performance.now();
let frameCount = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const sim = state.sim;
  if (sim && state.playing) {
    sim.advance(dt * speedFactor(), 60000);
    if (++frameCount % 2 === 0 || sim.done) viewer.heightChanged();
    syncTool();
    updateReadout();
    if (sim.done) setPlaying(false);
  }
  viewer.render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault(); $('play').click();
  }
});

// ---------------------------------------------------------------------------
// inputs → pipeline
const groups = {
  stone: ['shape', 'width', 'height', 'thickness', 'rise', 'corner', 'res'],
  design: ['symbol', 'symbolSize', 'symbolY', 'symbolX', 'border', 'borderInset', 'borderWidth', 'imgW', 'imgThr', 'imgX', 'imgY', 'imgInv'],
  toolpath: ['angle', 'diameter', 'maxDepth', 'passDepth', 'strategy', 'stepover'],
  machine: ['feed', 'plunge', 'rpm', 'safeZ', 'rapid', 'coolant'],
};
for (const [kind, ids] of Object.entries(groups)) {
  for (const id of ids) $(id).addEventListener('input', () => schedule(kind));
}
const SWATCHES = [
  ['#f2f0ea', 'White', false], ['#111111', 'Black', false], ['#d4a645', 'Gold', true],
  ['#c9ccd2', 'Silver', true], ['#9a6a3a', 'Bronze', true], ['#8e1b1b', 'Red', false],
  ['#1f4e9c', 'Blue', false], ['#2f6b3a', 'Green', false], ['#6b6f75', 'Grey', false],
];
for (const [hex, name, metal] of SWATCHES) {
  const b = document.createElement('button');
  b.className = 'swatch'; b.title = name; b.style.background = hex;
  b.setAttribute('aria-label', name);
  b.addEventListener('click', () => {
    $('fillColor').value = hex; $('fillMetal').checked = metal; $('fill').value = 'custom'; applyLook();
  });
  $('swatches').appendChild(b);
}
for (const id of ['fillColor', 'fillMetal']) {
  $(id).addEventListener('input', () => { $('fill').value = 'custom'; applyLook(); });
}
for (const id of ['stone', 'fill', 'fillDepth', 'showLayout', 'showPath', 'showTool']) {
  $(id).addEventListener('input', applyLook);
}

$('imageFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadImage(reader.result, file.name)
    .then((im) => { state.image = im; schedule('design'); })
    .catch(() => showWarnings(['Could not read that image.']));
  reader.readAsDataURL(file);
});
$('imgClear').addEventListener('click', () => { state.image = null; $('imageFile').value = ''; schedule('design'); });

// ---------------------------------------------------------------------------
// files
function download(name, data, type) {
  const a = document.createElement('a');
  a.href = typeof data === 'string' && data.startsWith('data:') ? data : URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

$('exportG').addEventListener('click', () => {
  if (!state.program) return;
  const s = stoneCfg(), t = toolCfg();
  const g = exportGcode(state.program, machineCfg(), {
    title: state.lines.map(l => l.text).find(t => t.trim()) || 'headstone',
    toolLabel: `${t.angle}° V-bit, Ø${t.diameter} mm`,
    stock: `${s.width} x ${s.height} x ${s.thickness} mm ${$('shape').selectedOptions[0].textContent}`,
  });
  download('headstone-vcarve.nc', g, 'text/plain');
});

$('loadG').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const P = parseGcode(await file.text(), machineCfg());
    state.imported = { name: file.name, program: P };
    $('useGen').hidden = false;
    loadProgram(P);
  } catch (err) {
    showWarnings([`G-code: ${err.message}`]);
  }
  e.target.value = '';
});
$('useGen').addEventListener('click', () => {
  state.imported = null; $('useGen').hidden = true;
  loadProgram(state.program);
});

$('shot').addEventListener('click', () => {
  viewer.render();
  download('headstone.png', viewer.renderer.domElement.toDataURL('image/png'));
});

// ---------------------------------------------------------------------------
// settings: save / load / remember
let autosaveTimer = 0, restoring = false;
function autosave() {
  if (restoring) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveLocal(state), 500);
}

async function restore(data) {
  restoring = true;
  try {
    await applySettings(data, state);
  } finally {
    restoring = false;
  }
  $('imageFile').value = '';
  renderLines();
  updateSpeedLabel();
  applyLook();
  pending = -1; clearTimeout(timer);
  await run(LEVEL.stone);
}

$('saveSettings').addEventListener('click', () => {
  const data = collectSettings(state);
  const first = (state.lines.find(l => l.text.trim()) || {}).text || 'headstone';
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'headstone';
  download(`${slug}.headstone.json`, JSON.stringify(data, null, 2), 'application/json');
});
$('loadSettings').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await restore(JSON.parse(await file.text()));
    saveLocal(state);
  } catch (err) {
    showWarnings([`Settings: ${err instanceof SyntaxError ? 'file is not valid JSON.' : err.message}`]);
  }
});
$('resetSettings').addEventListener('click', () => {
  if (!confirm('Reset all settings to the defaults? Your current design will be cleared.')) return;
  clearLocal();
  location.reload();
});

// expose for debugging / automation
window.cncSim = { state, viewer, run };

// start: restore the last session in this browser, if any
const saved = readLocal();
if (saved) {
  restore(saved).catch((err) => { console.warn('Could not restore saved settings', err); run(LEVEL.stone); });
} else {
  run(LEVEL.stone);
}
