// Thin DOM binding for the sequencer grid and the parameter panel.
//
// All decisions live in sequencer.ts / schema.ts / panel.ts / edit.ts; this file
// only turns them into elements and pointer handlers. Every gesture ends in a
// text patch handed to `host.setDoc`, which re-renders everything from the
// re-parsed document — the GUI never holds state the markdown does not.

import type { CompileResult, CompiledTrack } from '../dsl/compile.ts';
import { setLoopLine, appendLoopLine, setLoopAttr, loopLines } from '../dsl/edit.ts';
import { formatNote } from '../dsl/format.ts';
import {
  parseGridLine,
  renderGridLine,
  emptyGridLine,
  cellText,
  toggleCell,
  transposeCell,
  setTieCell,
  resampleLine,
  type GridLine,
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
  tieMode: HTMLButtonElement;
}

/** Pixels of vertical travel per semitone when dragging a cell. */
const PX_PER_SEMITONE = 11;
const DRAG_THRESHOLD = 6;
/** Slider writeback rate while dragging. */
const WRITE_INTERVAL_MS = 33;

export class GuiView {
  private result: CompileResult | null = null;
  private selectedTrack = 0;
  private tieMode = false;
  /** Set while a control is being manipulated, to defer rebuilds. */
  private dragging = false;
  private pendingResult: CompileResult | null = null;
  /** Last note the user placed per track, so taps repeat their pitch. */
  private lastNote = new Map<number, number[]>();

  constructor(
    private readonly el: GuiElements,
    private readonly host: GuiHost,
  ) {
    this.el.tieMode.addEventListener('click', () => {
      this.tieMode = !this.tieMode;
      this.el.tieMode.classList.toggle('on', this.tieMode);
      this.host.hint(this.tieMode ? 'tie mode: tap a cell to extend the note before it' : '');
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

    const bars = result.loopMeta?.bars ?? 1;
    const refs = loopLines(this.host.getDoc());

    for (let track = 0; track < result.trackCount; track++) {
      const id = this.trackId(track);
      const ref = refs.find((r) => r.trackId === id);
      const row = document.createElement('div');
      row.className = 'seq-row';

      const label = document.createElement('div');
      label.className = 'seq-label';
      label.textContent = id;
      row.appendChild(label);

      if (!ref) {
        // Declared synth with no loop line yet.
        label.classList.add('muted');
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'seq-add';
        add.textContent = `+ add a loop line for ${id}`;
        add.addEventListener('click', () => this.addLine(id, bars));
        row.appendChild(add);
        seq.appendChild(row);
        continue;
      }

      const line = parseGridLine(`${id}:${ref.cellsText}`, bars);
      if (!line || line.cellsPerBeat === 0) {
        label.classList.add('muted');
        const warn = document.createElement('div');
        warn.className = 'seq-label muted';
        warn.textContent = 'this line does not fit the grid — edit it as text';
        row.appendChild(warn);
        seq.appendChild(row);
        continue;
      }

      row.appendChild(this.buildCells(track, line));
      row.appendChild(this.buildResolution(line));
      seq.appendChild(row);
    }
  }

  private buildCells(track: number, line: GridLine): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'seq-cells';
    wrap.style.setProperty('--cells', String(line.cells.length));
    wrap.dataset['track'] = String(track);

    line.cells.forEach((cell, index) => {
      const el = document.createElement('div');
      el.className = `cell ${cell.kind}`;
      if (cell.notes.length > 1) el.classList.add('chord');
      if (index % line.cellsPerBeat === 0) el.classList.add('beat');
      el.textContent = '';
      if (cell.kind === 'note') {
        if (cell.notes.length > 1) {
          for (const n of cell.notes) {
            const s = document.createElement('span');
            s.className = 'stack';
            s.textContent = formatNote(n, cell.raw.includes('b'));
            el.appendChild(s);
          }
        } else {
          el.textContent = cellText(cell);
        }
      } else if (cell.kind === 'tie') {
        el.textContent = '~';
      }
      this.bindCell(el, track, line, index);
      wrap.appendChild(el);
    });

    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    wrap.appendChild(playhead);
    return wrap;
  }

  /** Tap = toggle (or tie), vertical drag on a note = transpose. */
  private bindCell(el: HTMLElement, track: number, line: GridLine, index: number): void {
    el.addEventListener('pointerdown', (ev: PointerEvent) => {
      ev.preventDefault();
      const cell = line.cells[index];
      if (!cell) return;
      const startY = ev.clientY;
      const canTranspose = cell.kind === 'note';
      let moved = false;
      let semis = 0;
      el.setPointerCapture(ev.pointerId);
      this.dragging = true;
      el.classList.add('dragging');

      const onMove = (m: PointerEvent) => {
        if (!canTranspose) return;
        const dy = startY - m.clientY;
        if (!moved && Math.abs(dy) < DRAG_THRESHOLD) return;
        moved = true;
        const next = Math.round(dy / PX_PER_SEMITONE);
        if (next === semis) return;
        semis = next;
        // Live feedback without touching the document yet.
        const preview = transposeCell(line, index, semis).cells[index];
        if (preview) {
          el.textContent = '';
          if (preview.notes.length > 1) {
            for (const n of preview.notes) {
              const s = document.createElement('span');
              s.className = 'stack';
              s.textContent = formatNote(n);
              el.appendChild(s);
            }
          } else {
            el.textContent = cellText(preview);
          }
        }
        this.host.hint(semis === 0 ? '' : `transpose ${semis > 0 ? '+' : ''}${semis}st`);
      };

      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.classList.remove('dragging');
        this.host.hint('');

        let next: GridLine;
        if (moved && semis !== 0) {
          next = transposeCell(line, index, semis);
          const notes = next.cells[index]?.notes;
          if (notes?.length) this.lastNote.set(track, notes);
        } else if (this.tieMode) {
          next = setTieCell(line, index);
          if (next === line) this.host.hint('only a cell with a note before it can be tied');
        } else {
          next = toggleCell(line, index, this.lastNote.get(track));
          const notes = next.cells[index]?.notes;
          if (notes?.length) this.lastNote.set(track, notes);
        }
        this.dragging = false;
        if (next !== line) this.commitLine(next);
        else this.endDrag();
      };

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  private buildResolution(line: GridLine): HTMLElement {
    const sel = document.createElement('select');
    sel.className = 'res-select';
    for (const [label, value] of [
      ['1/8', 2],
      ['1/16', 4],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      if (line.cellsPerBeat === value) opt.selected = true;
      sel.appendChild(opt);
    }
    if (line.cellsPerBeat !== 2 && line.cellsPerBeat !== 4) {
      const opt = document.createElement('option');
      opt.value = String(line.cellsPerBeat);
      opt.textContent = `1/${line.cellsPerBeat * 4}`;
      opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const r = resampleLine(line, Number(sel.value));
      if (!r.ok) {
        this.host.hint(r.reason);
        // Put the select back where it was; the text is unchanged.
        if (this.result) this.render(this.result);
        return;
      }
      this.commitLine(r.line);
    });
    return sel;
  }

  private commitLine(line: GridLine): void {
    this.dragging = false;
    this.pendingResult = null;
    const r = setLoopLine(this.host.getDoc(), line.trackId, renderGridLine(line, this.labelPad()));
    if (!r.ok) {
      this.host.hint(r.reason);
      return;
    }
    this.host.setDoc(r.doc);
  }

  private labelPad(): number {
    const ids = loopLines(this.host.getDoc()).map((l) => l.trackId.length);
    return Math.max(0, ...ids) + 2;
  }

  private addLine(trackId: string, bars: number): void {
    const line = emptyGridLine(trackId, bars);
    const r = appendLoopLine(this.host.getDoc(), renderGridLine(line, this.labelPad()));
    if (!r.ok) {
      this.host.hint(r.reason);
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
