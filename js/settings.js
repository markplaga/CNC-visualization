// Save / load all simulator settings as JSON (file download, file upload, and
// an automatic copy in this browser's localStorage).

export const SETTINGS_APP = 'vbit-headstone-sim';
export const SETTINGS_VERSION = 1;
const STORAGE_KEY = `${SETTINGS_APP}:settings`;

/** Every form control in the panel and view that has an id, except file pickers. */
function controls() {
  return [...document.querySelectorAll('#panel [id], #view [id]')]
    .filter(el => (el.tagName === 'INPUT' || el.tagName === 'SELECT') && el.type !== 'file');
}

export function collectSettings(state) {
  const values = {};
  for (const el of controls()) values[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  return {
    app: SETTINGS_APP,
    version: SETTINGS_VERSION,
    savedAt: new Date().toISOString(),
    controls: values,
    lines: state.lines.map(l => ({ ...l })),
    image: state.image && state.image.src ? { name: state.image.name, src: state.image.src } : null,
  };
}

/**
 * Apply a settings object to the form and state. Unknown control ids are
 * ignored, and select values that no longer exist keep the current choice.
 * Resolves once any embedded image has loaded. Throws on a foreign file.
 */
export async function applySettings(data, state) {
  if (!data || typeof data !== 'object' || data.app !== SETTINGS_APP) {
    throw new Error('This is not a V-Bit Headstone Simulator settings file.');
  }
  const byId = new Map(controls().map(el => [el.id, el]));
  for (const [id, v] of Object.entries(data.controls || {})) {
    const el = byId.get(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.tagName === 'SELECT') {
      if ([...el.options].some(o => o.value === String(v))) el.value = String(v);
    } else el.value = String(v);
  }
  if (Array.isArray(data.lines)) {
    state.lines = data.lines
      .filter(l => l && typeof l === 'object')
      .map(l => ({
        text: String(l.text ?? ''), font: String(l.font || 'Cinzel'),
        size: +l.size || 10, y: +l.y || 0, bold: !!l.bold,
      }));
  }
  state.image = null;
  if (data.image && typeof data.image.src === 'string' && data.image.src.startsWith('data:image/')) {
    state.image = await loadImage(data.image.src, data.image.name || 'image');
  }
}

export function loadImage(src, name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, name, src });
    img.onerror = () => reject(new Error('Could not read the image.'));
    img.src = src;
  });
}

// --- automatic browser copy -------------------------------------------------
export function saveLocal(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectSettings(state)));
  } catch {
    // storage full or blocked (e.g. a large image): retry without the image
    try {
      const s = collectSettings(state); s.image = null;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch { /* unavailable */ }
  }
}

export function readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearLocal() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* unavailable */ }
}
