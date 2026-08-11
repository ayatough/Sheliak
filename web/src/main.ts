// UI glue: editor → compile → engine, plus an analyser scope.

import './style.css';
import { AudioEngine, type EngineState } from './audio/engine.ts';
import { compile, type CompileResult } from './dsl/compile.ts';
import { DEFAULT_DOC } from './defaultDoc.ts';

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
const expandedEl = $<HTMLElement>('expanded');
const loopViewEl = $<HTMLElement>('loopview');
const metaEl = $<HTMLElement>('meta');
const scope = $<HTMLCanvasElement>('scope');
const posEl = $<HTMLElement>('pos');

let lastValidPatchAt = 0; // monotonic counter of successful patch applications
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
  },
});

// ------------------------------------------------------------------ compile

function currentSampleRate(): number {
  return engine.sampleRate || FALLBACK_SAMPLE_RATE;
}

let lastResult: CompileResult | null = null;
let lastLoopSig = '';

function recompile(force = false): void {
  const result = compile(editor.value, currentSampleRate());
  lastResult = result;

  if (result.patch) {
    engine.sendPatch(result.patch.params);
    lastValidPatchAt++;
    expandedEl.textContent = JSON.stringify(result.patch.expanded, null, 2);
  } else if (force) {
    expandedEl.textContent = expandedEl.textContent || '(パッチ未確定)';
  }

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
  renderStatus();
}

function formatLoop(result: CompileResult): string {
  const loop = result.loop;
  if (!loop) return '';
  const meta = result.loopMeta;
  const head = meta
    ? `# ${meta.id || 'loop'}  track=${meta.trackId}  bars=${meta.bars}  bpm=${meta.bpm}\n` +
      `# cells=${meta.cells} (${meta.cellsPerBeat}/beat)  sampleRate=${currentSampleRate()}\n`
    : '';
  const lines = loop.events.map(
    (e) =>
      `${String(e.offsetSamples).padStart(8)}  ${e.kind === 0 ? 'on ' : 'off'}  note=${e.note}` +
      (e.kind === 0 ? `  vel=${e.velocity}` : ''),
  );
  return `${head}lengthSamples = ${loop.lengthSamples}\n${lines.join('\n')}`;
}

// ------------------------------------------------------------------- render

function renderErrors(result: CompileResult): void {
  if (result.errors.length === 0) {
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    return;
  }
  errorsEl.hidden = false;
  const keepsPlaying = !result.patch && lastValidPatchAt > 0;
  const items = result.errors
    .map(
      (e) =>
        `<li><span class="loc">${e.line}:${e.col}</span>${escapeHtml(e.message)}</li>`,
    )
    .join('');
  const hint = keepsPlaying ? '<div class="hint">直前の有効なパッチで再生を継続中 (playing last valid patch)</div>' : '';
  errorsEl.innerHTML = `${hint}<ul>${items}</ul>`;
}

function renderMeta(result: CompileResult): void {
  const bits: string[] = [];
  if (result.loopMeta) bits.push(`${result.loopMeta.bpm}bpm`, `${result.loopMeta.bars}bar`);
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
  if (!isError && lastResult && !lastResult.patch && lastValidPatchAt > 0) {
    text += ' — playing last valid patch';
  }
  statusEl.textContent = text;
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

  if (lastResult?.patch) engine.sendPatch(lastResult.patch.params);
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

// ---------------------------------------------------------------- scope

let scopeRunning = false;

function startScope(): void {
  if (scopeRunning) return;
  const analyser = engine.analyser;
  if (!analyser) return;
  const ctx2d = scope.getContext('2d');
  if (!ctx2d) return;

  scopeRunning = true;
  sizeScope();
  const data = new Uint8Array(analyser.fftSize);

  const draw = () => {
    const a = engine.analyser;
    if (!a) {
      scopeRunning = false;
      return;
    }
    a.getByteTimeDomainData(data);

    const w = scope.width;
    const h = scope.height;
    ctx2d.fillStyle = '#161a21';
    ctx2d.fillRect(0, 0, w, h);

    ctx2d.strokeStyle = '#262c37';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();

    ctx2d.strokeStyle = '#6fd3c7';
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

editor.value = DEFAULT_DOC;
sizeScope();
recompile(true);
renderStatus();
