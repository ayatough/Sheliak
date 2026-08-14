// UI glue: editor → compile → engine, plus an analyser scope.

import './style.css';
import { AudioEngine, type EngineState } from './audio/engine.ts';
import { compile, type CompileResult } from './dsl/compile.ts';
import { phraseExpandedLines } from './dsl/phrase.ts';
import { GuiView } from './gui/view.ts';
import { DEFAULT_DOC } from './defaultDoc.ts';
import { browserTransport, DocFile } from './docFile.ts';

const DEBOUNCE_MS = 150;
/** Used to compile before the AudioContext exists; replaced by the real rate. */
const FALLBACK_SAMPLE_RATE = 48000;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const editor = $<HTMLTextAreaElement>('editor');
const playBtn = $<HTMLButtonElement>('play');
const statusEl = $<HTMLElement>('status');
const stateDot = $<HTMLElement>('state-dot');
const errorsEl = $<HTMLElement>('errors');
const tracksEl = $<HTMLElement>('tracks');
const loopViewEl = $<HTMLElement>('loopview');
const metaEl = $<HTMLElement>('meta');
const scope = $<HTMLCanvasElement>('scope');
const posEl = $<HTMLElement>('pos');
const viewTabs = $<HTMLElement>('view-tabs');
const versionEl = $<HTMLAnchorElement>('version');

/**
 * The file behind the document, when there is one. Without `sheliak serve` every
 * method on it is inert and the app behaves exactly as it always has: the
 * document is `defaultDoc.ts` and lives only in the textarea.
 */
const docFile = new DocFile({
  transport: browserTransport(),
  apply: (text) => {
    writeEditor(text);
    recompile();
  },
});

let lastValidPatchAt = 0; // monotonic counter of successful patch applications
/** Per-track expanded views, kept when a fence errors (last valid patch). */
const trackViews = new Map<number, { id: string; json: string }>();
let engineDetail = '';
let engineState: EngineState = 'idle';

const engine = new AudioEngine({
  onState: (state, detail) => {
    engineState = state;
    engineDetail = detail;
    stateDot.className = `dot ${state}`;
    renderStatus();
    if (state === 'ready') {
      // Recompile against the real sample rate before anything is scheduled.
      recompile(true);
    }
  },
  onPosition: (samples, loopLen) => {
    posEl.style.width = loopLen > 0 && engine.isPlaying ? `${((samples / loopLen) * 100).toFixed(1)}%` : '0%';
    gui.setPlayhead(samples, loopLen, engine.isPlaying);
  },
});

// ---------------------------------------------------------------------- gui

/**
 * Replaces the editor's text without stealing focus, the caret or the scroll
 * position — used by every write the person at the keyboard did not type: the
 * GUI's edits, and the file's own when `sheliak serve` is behind it.
 */
function writeEditor(doc: string): void {
  const { scrollTop, selectionStart, selectionEnd } = editor;
  const focused = document.activeElement === editor;
  editor.value = doc;
  editor.scrollTop = scrollTop;
  if (focused) editor.setSelectionRange(selectionStart, selectionEnd);
}

/**
 * The GUI is a projection: it reads the document, and every gesture hands back
 * a patched document. `setDoc` writes the textarea, then recompiles immediately
 * so the sound follows the knob.
 */
const gui = new GuiView(
  {
    seq: $<HTMLElement>('seq'),
    trackTabs: $<HTMLElement>('track-tabs'),
    params: $<HTMLElement>('params'),
    bars: $<HTMLInputElement>('loop-bars'),
    bpm: $<HTMLInputElement>('loop-bpm'),
    chordMode: $<HTMLButtonElement>('chord-mode'),
  },
  {
    getDoc: () => editor.value,
    setDoc: (doc: string) => {
      writeEditor(doc);
      // A GUI-originated change: recompile now, skipping the typing debounce.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      recompile();
    },
    hint: (message: string) => {
      guiHint = message;
      renderStatus();
    },
  },
);

let guiHint = '';

// ------------------------------------------------------------------ compile

function currentSampleRate(): number {
  return engine.sampleRate || FALLBACK_SAMPLE_RATE;
}

let lastResult: CompileResult | null = null;
let lastLoopSig = '';

function recompile(force = false): void {
  // Every path that changes the document ends here, so this is the one place
  // the file behind it has to be told. It ignores text it already has.
  docFile.changed(editor.value);
  const result = compile(editor.value, currentSampleRate());
  lastResult = result;

  // Send only the tracks that compiled clean; the rest keep their last patch.
  for (const track of result.tracks) {
    engine.sendPatch(track.track, track.params);
    trackViews.set(track.track, { id: track.id, json: JSON.stringify(track.expanded, null, 2) });
  }
  if (result.tracks.length > 0) lastValidPatchAt++;
  // Drop tracks the document no longer declares.
  engine.sendClearTracks(result.trackCount);
  for (const key of [...trackViews.keys()]) {
    if (key >= result.trackCount) trackViews.delete(key);
  }
  renderTracks(result);

  if (result.loop) {
    // Only re-send when the timing actually changed: swapping the loop resets
    // the scheduler cursor, and we do not want that on every keystroke.
    const sig = JSON.stringify(result.loop);
    if (force || sig !== lastLoopSig) {
      lastLoopSig = sig;
      engine.sendLoop(result.loop);
    }
    loopViewEl.textContent = formatLoop(result);
  }

  renderErrors(result);
  renderMeta(result);
  gui.render(result);
  renderStatus();
}

function formatLoop(result: CompileResult): string {
  const loop = result.loop;
  if (!loop) return '';
  const meta = result.loopMeta;
  const names = new Map(result.tracks.map((t) => [t.track, t.id]));
  let head = '';
  if (meta) {
    head =
      `# ${meta.id || 'loop'}  bars=${meta.bars}  bpm=${meta.bpm}  sampleRate=${currentSampleRate()}\n` +
      meta.lines
        .map(
          (l) =>
            `#   [${l.track}] ${l.trackId}: ${l.phraseId} ×${l.repeats} (1/${l.cellsPerBeat * 4} grid)\n`,
        )
        .join('');
  }

  // The expanded view for phrases (docs/workstreams.md §5): what each note ends
  // up sounding like, and which detail entry decided it.
  const expanded = Object.values(result.phrases)
    .map((phrase) => [`# phrase ${phrase.id}`, ...phraseExpandedLines(phrase).map((l) => `#   ${l}`)].join('\n'))
    .join('\n');

  const lines = loop.events.map((e) => {
    const who = names.get(e.track) ?? `track${e.track}`;
    return (
      `${String(e.offsetSamples).padStart(8)}  ${e.kind === 0 ? 'on ' : 'off'}  ` +
      `${who.padEnd(6)} note=${e.note}` +
      (e.kind === 0 ? `  vel=${round3(e.velocity)}` : '') +
      (e.legato ? `  glide=${round3(e.glideS)}s legato` : '')
    );
  });
  return `${head}${expanded ? `${expanded}\n` : ''}lengthSamples = ${loop.lengthSamples}\n${lines.join('\n')}`;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** One collapsible expanded-parameter panel per track, labelled by id. */
function renderTracks(result: CompileResult): void {
  const failed = new Set<number>();
  for (let t = 0; t < result.trackCount; t++) {
    if (!result.tracks.some((x) => x.track === t)) failed.add(t);
  }

  const parts: string[] = [];
  for (let t = 0; t < result.trackCount; t++) {
    const view = trackViews.get(t);
    const id = view?.id ?? `track${t}`;
    const stale = failed.has(t) ? '<span class="stale">⚠ last valid</span>' : '';
    const body = view ? escapeHtml(view.json) : '(not compiled yet)';
    parts.push(
      `<details class="expanded"><summary><span class="badge">${t}</span>${escapeHtml(id)}${stale}</summary>` +
        `<pre>${body}</pre></details>`,
    );
  }
  if (parts.length === 0) {
    parts.push('<details class="expanded"><summary>expanded parameters</summary><pre>(no synth fence)</pre></details>');
  }
  tracksEl.innerHTML = parts.join('');
}

// ------------------------------------------------------------------- render

function renderErrors(result: CompileResult): void {
  if (result.errors.length === 0) {
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    return;
  }
  errorsEl.hidden = false;
  const keepsPlaying = result.tracks.length < result.trackCount && lastValidPatchAt > 0;
  const items = result.errors
    .map(
      (e) =>
        `<li><span class="loc">${e.line}:${e.col}</span>${escapeHtml(e.message)}</li>`,
    )
    .join('');
  const hint = keepsPlaying ? '<div class="hint">still playing the last valid patch</div>' : '';
  errorsEl.innerHTML = `${hint}<ul>${items}</ul>`;
}

function renderMeta(result: CompileResult): void {
  const bits: string[] = [];
  if (result.loopMeta) bits.push(`${result.loopMeta.bpm}bpm`, `${result.loopMeta.bars}bar`);
  bits.push(`${result.tracks.length}/${result.trackCount} track${result.trackCount === 1 ? '' : 's'}`);
  if (engine.sampleRate) bits.push(`${engine.sampleRate}Hz`);
  bits.push(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`);
  metaEl.textContent = bits.join('  ·  ');
}

function renderStatus(): void {
  let text: string;
  let isError = false;
  switch (engineState) {
    case 'idle':
      text = engine.isPlaying ? 'starting…' : 'stopped — click Play to start audio';
      break;
    case 'loading':
      text = engineDetail || 'loading…';
      break;
    case 'ready':
      text = `${engine.isPlaying ? 'playing' : 'stopped'} — ${engineDetail}`;
      break;
    case 'error':
      text = engineDetail || 'audio error';
      isError = true;
      break;
  }
  if (!isError && lastResult && lastResult.tracks.length < lastResult.trackCount && lastValidPatchAt > 0) {
    text += ' — playing last valid patch';
  }
  statusEl.textContent = guiHint ? `${text} — ${guiHint}` : text;
  statusEl.classList.toggle('error', isError);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

// ----------------------------------------------------------------- transport

let starting = false;

async function togglePlay(): Promise<void> {
  if (engine.isPlaying) {
    engine.setPlaying(false);
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('on');
    renderStatus();
    return;
  }

  playBtn.textContent = '■ Stop';
  playBtn.classList.add('on');

  if (!engine.isReady) {
    if (starting) return;
    starting = true;
    playBtn.disabled = true;
    try {
      // Must happen inside the user gesture.
      await engine.start();
    } catch {
      playBtn.textContent = '▶ Play';
      playBtn.classList.remove('on');
      playBtn.disabled = false;
      starting = false;
      renderStatus();
      return;
    }
    playBtn.disabled = false;
    starting = false;
  }

  for (const track of lastResult?.tracks ?? []) engine.sendPatch(track.track, track.params);
  if (lastResult) engine.sendClearTracks(lastResult.trackCount);
  if (lastResult?.loop) engine.sendLoop(lastResult.loop);
  engine.setPlaying(true);
  renderStatus();
  startScope();
}

playBtn.addEventListener('click', () => {
  void togglePlay();
});

// ------------------------------------------------------------- hot reload

let timer: number | undefined;
editor.addEventListener('input', () => {
  if (timer !== undefined) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    recompile();
  }, DEBOUNCE_MS);
});

// ------------------------------------------------------------- view tabs

// Mobile: one pane at a time. Desktop CSS ignores these classes.
function selectView(which: 'md' | 'gui'): void {
  for (const btn of Array.from(viewTabs.querySelectorAll<HTMLButtonElement>('button'))) {
    btn.classList.toggle('on', btn.dataset['view'] === which);
  }
  $<HTMLElement>('pane-md').classList.toggle('active', which === 'md');
  $<HTMLElement>('pane-gui').classList.toggle('active', which === 'gui');
  if (which === 'gui') sizeScope();
}

viewTabs.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('button');
  const which = btn?.dataset['view'];
  if (which === 'md' || which === 'gui') selectView(which);
});

// ---------------------------------------------------------------- scope

let scopeRunning = false;

// The scope is drawn on a canvas, so it cannot inherit the palette the way the
// rest of the interface does. Read the same custom properties instead of
// copying their values here, where a retheme would not find them.
function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function startScope(): void {
  if (scopeRunning) return;
  const analyser = engine.analyser;
  if (!analyser) return;
  const ctx2d = scope.getContext('2d');
  if (!ctx2d) return;

  scopeRunning = true;
  sizeScope();
  const data = new Uint8Array(analyser.fftSize);
  const paint = themeColor('--panel', '#111411');
  const rule = themeColor('--line', '#2c302c');
  const trace = themeColor('--accent', '#e5a900');

  const draw = () => {
    const a = engine.analyser;
    if (!a) {
      scopeRunning = false;
      return;
    }
    a.getByteTimeDomainData(data);

    const w = scope.width;
    const h = scope.height;
    ctx2d.fillStyle = paint;
    ctx2d.fillRect(0, 0, w, h);

    ctx2d.strokeStyle = rule;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();

    ctx2d.strokeStyle = trace;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const step = data.length / w;
    for (let x = 0; x < w; x++) {
      const v = ((data[Math.floor(x * step)] ?? 128) - 128) / 128;
      const y = h / 2 - v * (h / 2 - 4);
      if (x === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();

    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

// ------------------------------------------------------------------- boot

function sizeScope(): void {
  const rect = scope.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  scope.width = Math.max(1, Math.round(rect.width * dpr));
  scope.height = Math.max(1, Math.round(rect.height * dpr));
}

window.addEventListener('resize', sizeScope);

/**
 * The version stamp, when the site was built with one. Two channels share one
 * deployment — the root is the latest release, `/next/` is the tip of `main` —
 * and without this they are indistinguishable at a glance, which is how someone
 * ends up reporting a bug against a build nobody has released.
 */
function renderVersion(): void {
  const channel = import.meta.env['VITE_SITE_CHANNEL'];
  const version = import.meta.env['VITE_SITE_VERSION'];
  if (!version) return;
  versionEl.hidden = false;
  versionEl.textContent = channel === 'dev' ? `next · ${version}` : version;
  versionEl.classList.toggle('dev', channel === 'dev');
  versionEl.title =
    channel === 'dev' ? 'the tip of main — a working copy, not a release' : 'the latest release';
}

renderVersion();
editor.value = DEFAULT_DOC;
selectView('gui');
sizeScope();
recompile(true);
renderStatus();

// Asked for unconditionally: the answer is what decides whether this session is
// backed by a file. Nothing is served in the published app, and `start()`
// resolves null there without the boot above having waited for it.
void docFile.start().then((text) => {
  if (text === null) return;
  writeEditor(text);
  recompile(true);
  renderMetaFile();
});

function renderMetaFile(): void {
  const name = docFile.path?.split('/').pop();
  if (name) document.title = `${name} — Sheliak`;
  const head = document.querySelector('.pane-head span');
  if (name && head) head.textContent = name;
}
