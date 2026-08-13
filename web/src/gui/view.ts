// Thin DOM binding for the sequencer grid and the parameter panel.
//
// All decisions live in sequencer.ts / ops.ts / schema.ts / panel.ts / edit.ts;
// this file only turns them into elements and pointer handlers. Every gesture
// ends in an operation handed to `ops.applyText`, whose patched document goes
// to `host.setDoc` and comes back re-parsed — the GUI never holds state the
// markdown does not.

import type { CompileResult, CompiledTrack } from '../dsl/compile.ts';
import { setLoopAttr } from '../dsl/edit.ts';
import { applyText, type Op } from '../dsl/ops.ts';
import type { Phrase } from '../dsl/phrase.ts';
import {
  projectPhrase,
  noteAt,
  tapOp,
  movePitchOp,
  resizeOp,
  groupOp,
  clamp,
  type SeqGrid,
} from './sequencer.ts';
import { buildPanel, type FieldSpec, type PanelSection } from './schema.ts';
import { toSlider, fromSlider, displayValue, writeField, fieldStatus } from './panel.ts';

export interface GuiHost {
  getDoc(): string;
  /** Replace the document text and run the (immediate) recompile. */
  setDoc(doc: string): void;
  hint(message: string): void;
}

export interface GuiElements {
  seq: HTMLElement;
  trackTabs: HTMLElement;
  params: HTMLElement;
  bars: HTMLInputElement;
  bpm: HTMLInputElement;
  chordMode: HTMLButtonElement;
}

/** Pixels of vertical travel per row when dragging a note to another pitch. */
const PX_PER_ROW = 22;
const DRAG_THRESHOLD = 6;
/** Slider writeback rate while dragging. */
const WRITE_INTERVAL_MS = 33;

export class GuiView {
  private result: CompileResult | null = null;
  private selectedTrack = 0;
  private chordMode = false;
  /** Set while a control is being manipulated, to defer rebuilds. */
  private dragging = false;
  private pendingResult: CompileResult | null = null;

  constructor(
    private readonly el: GuiElements,
    private readonly host: GuiHost,
  ) {
    this.el.chordMode.addEventListener('click', () => {
      this.chordMode = !this.chordMode;
      this.el.chordMode.classList.toggle('on', this.chordMode);
      this.host.hint(this.chordMode ? 'chord mode: tap a note to join or leave the group at its onset' : '');
    });
    this.el.bars.addEventListener('change', () => this.setLoopAttr('bars', this.el.bars.value));
    this.el.bpm.addEventListener('change', () => this.setLoopAttr('bpm', this.el.bpm.value));
  }

  /** Re-render from a fresh compile result (deferred while dragging). */
  render(result: CompileResult): void {
    if (this.dragging) {
      this.pendingResult = result;
      return;
    }
    this.result = result;
    this.renderSequencer();
    this.renderTrackTabs();
    this.renderParams();

    if (result.loopMeta) {
      if (document.activeElement !== this.el.bars) this.el.bars.value = String(result.loopMeta.bars);
      if (document.activeElement !== this.el.bpm) this.el.bpm.value = String(result.loopMeta.bpm);
    }
  }

  private endDrag(): void {
    this.dragging = false;
    if (this.pendingResult) {
      const pending = this.pendingResult;
      this.pendingResult = null;
      this.render(pending);
    }
  }

  // ------------------------------------------------------------- sequencer

  private renderSequencer(): void {
    const result = this.result;
    if (!result) return;
    const seq = this.el.seq;
    seq.textContent = '';

    const bound = new Map((result.loopMeta?.lines ?? []).map((l) => [l.track, l]));

    for (let track = 0; track < result.trackCount; track++) {
      const id = this.trackId(track);
      const line = bound.get(track);
      const phrase = line ? result.phrases[line.phraseId] : undefined;

      if (!line) {
        seq.appendChild(this.noteRow(id, 'no loop line — add `' + id + ': <phrase id>` to the loop fence'));
        continue;
      }
      if (!phrase) {
        seq.appendChild(this.noteRow(id, `phrase "${line.phraseId}" does not parse — fix it as text`));
        continue;
      }
      seq.appendChild(this.buildPhrase(id, phrase));
    }
  }

  /** A muted stand-in for a track with nothing playable to show. */
  private noteRow(id: string, message: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'seq-row';
    const label = document.createElement('div');
    label.className = 'seq-label muted';
    label.textContent = id;
    const text = document.createElement('div');
    text.className = 'seq-label muted';
    text.textContent = message;
    row.append(label, text);
    return row;
  }

  private buildPhrase(trackId: string, phrase: Phrase): HTMLElement {
    const grid = projectPhrase(phrase, trackId);
    const box = document.createElement('div');
    box.className = 'seq-phrase';

    const head = document.createElement('div');
    head.className = 'seq-row';
    const who = document.createElement('div');
    who.className = 'seq-label';
    who.textContent = trackId;
    const what = document.createElement('div');
    what.className = 'seq-label muted';
    // Key and scale mean nothing to a kit, so a percussion phrase omits them.
    const tuning = phrase.namespace === 'percussion' ? '' : `${phrase.key} ${phrase.scale}  `;
    what.textContent = `${phrase.id}  ${tuning}${phrase.res}`;
    head.append(who, what);
    box.appendChild(head);

    grid.rows.forEach((row, r) => {
      const line = document.createElement('div');
      line.className = 'seq-row';
      const label = document.createElement('div');
      label.className = 'seq-label';
      label.textContent = row.label;
      line.appendChild(label);
      line.appendChild(this.buildCells(phrase, grid, r));
      box.appendChild(line);
    });

    return box;
  }

  private buildCells(phrase: Phrase, grid: SeqGrid, r: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'seq-cells';
    wrap.style.setProperty('--cells', String(grid.totalCells));

    const row = grid.rows[r];
    if (!row) return wrap;

    row.cells.forEach((cell, index) => {
      const el = document.createElement('div');
      el.className = `cell ${cell.kind}`;
      if (index % grid.cellsPerBeat === 0) el.classList.add('beat');
      if (cell.kind === 'onset') {
        // A tag other than `o` means the note shares its onset with another
        // group — worth seeing, since that is what `roll` acts on.
        if (cell.tag !== 'o') el.classList.add('chord');
        el.textContent = cell.tag === 'o' ? '' : cell.tag;
      } else if (cell.kind === 'hold') {
        el.textContent = '';
      }
      this.bindCell(el, phrase, grid, r, index);
      wrap.appendChild(el);
    });

    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    wrap.appendChild(playhead);
    return wrap;
  }

  /**
   * Tap toggles a note (or joins a group in chord mode); a vertical drag moves
   * it to another row, a horizontal one changes how long it holds.
   */
  private bindCell(el: HTMLElement, phrase: Phrase, grid: SeqGrid, row: number, cell: number): void {
    el.addEventListener('pointerdown', (ev: PointerEvent) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const width = Math.max(el.getBoundingClientRect().width, 1);
      const note = noteAt(grid, row, cell);
      let moved = false;
      el.setPointerCapture(ev.pointerId);
      this.dragging = true;
      el.classList.add('dragging');

      let pending: Op | null = null;

      const onMove = (m: PointerEvent) => {
        if (!note) return;
        const dx = m.clientX - startX;
        const dy = startY - m.clientY;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        moved = true;
        if (Math.abs(dy) >= Math.abs(dx)) {
          const steps = Math.round(dy / PX_PER_ROW);
          pending = movePitchOp(phrase, grid, row, cell, steps);
          this.host.hint(steps === 0 ? '' : `move ${steps > 0 ? 'up' : 'down'} ${Math.abs(steps)} row`);
        } else {
          const cells = clamp(note.length + Math.round(dx / width), 1, grid.totalCells - note.onset);
          pending = resizeOp(phrase, grid, row, cell, cells);
          this.host.hint(`${cells} cell${cells === 1 ? '' : 's'}`);
        }
      };

      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.classList.remove('dragging');
        this.host.hint('');
        this.dragging = false;

        const op = moved
          ? pending
          : this.chordMode
            ? groupOp(phrase, grid, row, cell)
            : tapOp(phrase, grid, row, cell);
        if (op) this.commit(phrase.id, op);
        else this.endDrag();
      };

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  private commit(phraseId: string, op: Op): void {
    this.dragging = false;
    this.pendingResult = null;
    const r = applyText(this.host.getDoc(), phraseId, op);
    if (!r.ok) {
      this.host.hint(r.reason);
      if (this.result) this.render(this.result);
      return;
    }
    this.host.setDoc(r.doc);
  }

  private setLoopAttr(key: string, value: string): void {
    const r = setLoopAttr(this.host.getDoc(), key, value);
    if (!r.ok) {
      this.host.hint(r.reason);
      return;
    }
    this.host.setDoc(r.doc);
  }

  /** Highlight the playing column; cheap — one transform per row. */
  setPlayhead(samples: number, loopLen: number, playing: boolean): void {
    this.el.seq.classList.toggle('playing', playing && loopLen > 0);
    if (!playing || loopLen <= 0) return;
    const t = samples / loopLen;
    for (const wrap of Array.from(this.el.seq.querySelectorAll<HTMLElement>('.seq-cells'))) {
      const cells = Number(wrap.style.getPropertyValue('--cells')) || 0;
      if (cells <= 0) continue;
      wrap.style.setProperty('--pcol', String(Math.min(cells - 1, Math.floor(t * cells))));
    }
  }

  // ----------------------------------------------------------- param panel

  private trackId(track: number): string {
    const t = this.result?.tracks.find((x) => x.track === track);
    return t ? t.id : `track${track}`;
  }

  private renderTrackTabs(): void {
    const result = this.result;
    if (!result) return;
    const tabs = this.el.trackTabs;
    tabs.textContent = '';
    if (this.selectedTrack >= result.trackCount) this.selectedTrack = 0;

    for (let track = 0; track < result.trackCount; track++) {
      const compiled = result.tracks.some((t) => t.track === track);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = this.trackId(track);
      btn.className = track === this.selectedTrack ? 'on' : '';
      if (!compiled) btn.classList.add('broken');
      btn.addEventListener('click', () => {
        this.selectedTrack = track;
        this.renderTrackTabs();
        this.renderParams();
      });
      tabs.appendChild(btn);
    }
  }

  private renderParams(): void {
    const result = this.result;
    const params = this.el.params;
    params.textContent = '';
    if (!result) return;

    const track = result.tracks.find((t) => t.track === this.selectedTrack);
    if (!track) {
      const p = document.createElement('div');
      p.className = 'gui-hint';
      p.textContent = 'this fence has errors — fix the text to edit it here';
      params.appendChild(p);
      return;
    }

    const compiled = true;
    for (const section of buildPanel(track.ir)) {
      params.appendChild(this.buildSection(section, track, compiled));
    }
  }

  private buildSection(section: PanelSection, track: CompiledTrack, compiled: boolean): HTMLElement {
    const box = document.createElement('div');
    box.className = 'psection';
    const h = document.createElement('h4');
    h.textContent = section.label;
    box.appendChild(h);
    for (const spec of section.fields) box.appendChild(this.buildField(spec, track, compiled));
    return box;
  }

  private buildField(spec: FieldSpec, track: CompiledTrack, compiled: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('label');
    label.textContent = spec.label;
    row.appendChild(label);

    const status = fieldStatus(this.host.getDoc(), track.track, spec, compiled);
    const value = document.createElement('div');
    value.className = 'val';

    const setValueText = (v: number | string | boolean) => {
      value.textContent = '';
      if (status.musical && status.text) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = status.text;
        value.appendChild(badge);
      }
      value.appendChild(document.createTextNode(displayValue(spec, v)));
    };

    const write = (v: number | string | boolean) => {
      const r = writeField(this.host.getDoc(), track.track, spec, v);
      if (!r.ok) {
        this.host.hint(r.reason);
        return;
      }
      this.host.setDoc(r.doc);
    };

    if (spec.kind === 'enum') {
      const sel = document.createElement('select');
      for (const opt of spec.options ?? []) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === spec.value) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = !status.editable;
      sel.addEventListener('change', () => write(sel.value));
      row.appendChild(sel);
      value.textContent = status.text ?? '(default)';
    } else if (spec.kind === 'toggle') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `toggle${spec.value ? ' on' : ''}`;
      btn.textContent = spec.value ? 'on' : 'off';
      btn.disabled = !status.editable;
      btn.addEventListener('click', () => write(!spec.value));
      row.appendChild(btn);
      value.textContent = status.text ?? '(default)';
    } else {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1000';
      slider.step = '1';
      slider.value = String(Math.round(toSlider(spec, Number(spec.value)) * 1000));
      slider.disabled = !status.editable;
      setValueText(spec.value);

      let last = 0;
      let pending: number | null = null;
      const flush = () => {
        if (pending === null) return;
        const v = pending;
        pending = null;
        last = Date.now();
        write(v);
      };
      slider.addEventListener('pointerdown', () => {
        this.dragging = true;
      });
      slider.addEventListener('input', () => {
        const v = fromSlider(spec, Number(slider.value) / 1000);
        setValueText(v);
        pending = v;
        // Throttle to ~30Hz: the DSP smooths params, so this feels continuous.
        if (Date.now() - last >= WRITE_INTERVAL_MS) flush();
      });
      const finish = () => {
        flush();
        this.endDrag();
      };
      slider.addEventListener('change', finish);
      slider.addEventListener('pointerup', finish);
      slider.addEventListener('pointercancel', finish);
      row.appendChild(slider);
    }

    row.appendChild(value);
    if (!status.editable) {
      row.classList.add('disabled');
      if (status.reason) row.title = status.reason;
    }
    return row;
  }
}
