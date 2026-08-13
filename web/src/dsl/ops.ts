// The operation set (docs/workstreams.md §7).
//
// Everything reachable from the GUI or from an agent is in this file. A state
// that no operation here can produce does not appear in the text — which is
// what makes round-trip correctness (§8) a property a test can fail rather than
// a claim.
//
// Each operation exists twice, deliberately:
//
//   applyModel  the meaning of the operation, over the parsed phrase
//   applyText   the same operation as the smallest possible text patch
//
// Invariant 1 is that the two agree: `parse(applyText(doc, op))` equals
// `applyModel(parse(doc), op)`. `applyText` gets there by asking `applyModel`
// what the result is and then writing only the bytes that differ — a cell write
// is one character, a detail entry is one line — so the two can only disagree
// about *where* the change lands, which is exactly where span arithmetic goes
// wrong. `ops.test.ts` checks both halves.

import { formatPhrase, formatPhraseParts } from './format.ts';
import {
  canonicalRowOrder,
  cellCoords,
  formatAddress,
  matchesAddress,
  parseAddress,
  type Address,
  type DetailEntry,
  type GestureKey,
  type Gestures,
  type GlissSpec,
  type Phrase,
  type PhraseNote,
  type PhraseRow,
} from './phrase.ts';
import {
  labelNamespace,
  resolveRowLabel,
  transposeLabel,
  keyToPitchClass,
  SCALES,
} from './pitch.ts';
import {
  loadPhrase,
  replaceDetailBlock,
  replaceGridBlock,
  replaceLines,
  replacePhraseBody,
  replaceSpan,
  setFenceAttr,
  setLoopLine,
  loopLines,
  type EditResult,
} from './edit.ts';
import { ErrorSink } from './errors.ts';

// ------------------------------------------------------------------------ ops

export type Op =
  | { kind: 'note.add'; row: string; onset: number; length: number }
  | { kind: 'note.remove'; address: string }
  | { kind: 'note.movePitch'; address: string; row: string }
  | { kind: 'note.moveTime'; address: string; onset: number }
  | { kind: 'note.resize'; address: string; length: number }
  | { kind: 'note.insertRun'; from: string; to: string; onset: number; cells: number }
  | { kind: 'group.merge'; addresses: string[] }
  | { kind: 'group.detach'; address: string }
  | { kind: 'row.add'; row: string }
  | { kind: 'row.remove'; row: string }
  | { kind: 'detail.set'; address: string; key: GestureKey; value: number | GlissSpec }
  | { kind: 'detail.clear'; address: string; key: GestureKey }
  | { kind: 'phrase.transpose'; steps: number }
  | { kind: 'phrase.setKey'; key: string; scale: string }
  | { kind: 'loop.bind'; track: string; phrase: string };

export type OpResult = { ok: true; phrase: Phrase } | { ok: false; reason: string };

const fail = (reason: string): OpResult => ({ ok: false, reason });

// -------------------------------------------------------------------- model

/** Apply an operation to the parsed phrase. Total: it never half-applies. */
export function applyModel(phrase: Phrase, op: Op): OpResult {
  switch (op.kind) {
    case 'note.add':
      return noteAdd(phrase, op.row, op.onset, op.length);
    case 'note.remove':
      return noteRemove(phrase, op.address);
    case 'note.movePitch':
      return noteMovePitch(phrase, op.address, op.row);
    case 'note.moveTime':
      return noteMoveTime(phrase, op.address, op.onset);
    case 'note.resize':
      return noteResize(phrase, op.address, op.length);
    case 'note.insertRun':
      return noteInsertRun(phrase, op.from, op.to, op.onset, op.cells);
    case 'group.merge':
      return groupMerge(phrase, op.addresses);
    case 'group.detach':
      return groupDetach(phrase, op.address);
    case 'row.add':
      return rowAdd(phrase, op.row);
    case 'row.remove':
      return rowRemove(phrase, op.row);
    case 'detail.set':
      return detailSet(phrase, op.address, op.key, op.value);
    case 'detail.clear':
      return detailClear(phrase, op.address, op.key);
    case 'phrase.transpose':
      return phraseTranspose(phrase, op.steps);
    case 'phrase.setKey':
      return phraseSetKey(phrase, op.key, op.scale);
    case 'loop.bind':
      return fail('loop.bind edits the loop fence, not a phrase');
  }
}

function clonePhrase(p: Phrase): Phrase {
  return {
    ...p,
    rows: p.rows.map((r) => ({ ...r, cells: [...r.cells] })),
    notes: p.notes.map((n) => ({ ...n })),
    detail: p.detail.map((e) => ({ ...e, address: { ...e.address }, gestures: { ...e.gestures } })),
    cellCols: [...p.cellCols],
    barCols: [...p.barCols],
  };
}

/** Notes are kept in onset-then-row order so the formatter tags them stably. */
function sortNotes(notes: PhraseNote[]): PhraseNote[] {
  return [...notes].sort((a, b) => a.onset - b.onset || a.row - b.row);
}

function rowIndex(phrase: Phrase, label: string): number {
  return phrase.rows.findIndex((r) => r.label === label);
}

/** Cells a note occupies, as a half-open range. */
function occupies(note: PhraseNote): [number, number] {
  return [note.onset, note.onset + note.length];
}

function overlaps(phrase: Phrase, row: number, from: number, to: number, except?: PhraseNote): boolean {
  return phrase.notes.some((n) => {
    if (n === except || n.row !== row) return false;
    const [a, b] = occupies(n);
    return a < to && from < b;
  });
}

/** Resolve an address against the phrase. */
export function notesAt(phrase: Phrase, addressText: string): { address: Address; notes: PhraseNote[] } | null {
  const sink = new ErrorSink();
  const address = parseAddress(addressText, { line: 0, col: 0 }, sink);
  if (!address) return null;
  return { address, notes: phrase.notes.filter((n) => matchesAddress(phrase, n, address)) };
}

function single(phrase: Phrase, addressText: string): { note: PhraseNote } | { reason: string } {
  const found = notesAt(phrase, addressText);
  if (!found) return { reason: `malformed address "${addressText}"` };
  if (found.notes.length === 0) return { reason: `"${addressText}" names no note` };
  if (found.notes.length > 1) {
    return { reason: `"${addressText}" names ${found.notes.length} notes — this operation takes one` };
  }
  return { note: found.notes[0] as PhraseNote };
}

// ------------------------------------------------------------------- note ops

function noteAdd(phrase: Phrase, label: string, onset: number, length: number): OpResult {
  const row = rowIndex(phrase, label);
  if (row < 0) return fail(`no row "${label}" in this phrase`);
  if (!Number.isInteger(onset) || onset < 0 || onset >= phrase.totalCells) {
    return fail(`onset ${onset} is outside the grid (0..${phrase.totalCells - 1})`);
  }
  if (!Number.isInteger(length) || length < 1 || onset + length > phrase.totalCells) {
    return fail(`length ${length} does not fit at cell ${onset}`);
  }
  if (overlaps(phrase, row, onset, onset + length)) return fail(`row "${label}" already sounds there`);

  const next = clonePhrase(phrase);
  next.notes = sortNotes([...next.notes, { row, onset, length, tag: freeTag(next, onset) }]);
  return { ok: true, phrase: next };
}

function noteRemove(phrase: Phrase, addressText: string): OpResult {
  const found = notesAt(phrase, addressText);
  if (!found) return fail(`malformed address "${addressText}"`);
  if (found.notes.length === 0) return fail(`"${addressText}" names no note`);

  const next = clonePhrase(phrase);
  const doomed = new Set(found.notes.map((n) => noteKey(n)));
  next.notes = next.notes.filter((n) => !doomed.has(noteKey(n)));
  // An entry that named only the removed notes would be an orphan, and an
  // orphan is an error rather than something to ignore (§9).
  next.detail = next.detail.filter((e) => next.notes.some((n) => matchesAddress(next, n, e.address)));
  return { ok: true, phrase: next };
}

function noteMovePitch(phrase: Phrase, addressText: string, label: string): OpResult {
  const found = single(phrase, addressText);
  if ('reason' in found) return fail(found.reason);
  const row = rowIndex(phrase, label);
  if (row < 0) return fail(`no row "${label}" in this phrase`);
  if (row === found.note.row) return { ok: true, phrase };
  const [from, to] = occupies(found.note);
  if (overlaps(phrase, row, from, to)) return fail(`row "${label}" already sounds there`);

  const next = clonePhrase(phrase);
  const moved = pick(next, found.note);
  moved.row = row;
  moved.tag = freeTag(next, moved.onset, moved);
  next.notes = sortNotes(next.notes);
  rewriteMovedAddresses(phrase, found.note, next, moved);
  return { ok: true, phrase: next };
}

function noteMoveTime(phrase: Phrase, addressText: string, onset: number): OpResult {
  const found = single(phrase, addressText);
  if ('reason' in found) return fail(found.reason);
  if (!Number.isInteger(onset) || onset < 0 || onset + found.note.length > phrase.totalCells) {
    return fail(`onset ${onset} does not fit a ${found.note.length}-cell note`);
  }
  if (onset === found.note.onset) return { ok: true, phrase };
  if (overlaps(phrase, found.note.row, onset, onset + found.note.length, found.note)) {
    return fail('another note is already there');
  }

  const next = clonePhrase(phrase);
  const moved = pick(next, found.note);
  moved.onset = onset;
  moved.tag = freeTag(next, onset, moved);
  next.notes = sortNotes(next.notes);
  rewriteMovedAddresses(phrase, found.note, next, moved);
  return { ok: true, phrase: next };
}

function noteResize(phrase: Phrase, addressText: string, length: number): OpResult {
  const found = single(phrase, addressText);
  if ('reason' in found) return fail(found.reason);
  if (!Number.isInteger(length) || length < 1) return fail('a note is at least one cell long');
  if (found.note.onset + length > phrase.totalCells) return fail('the note would run past the end of the grid');
  if (overlaps(phrase, found.note.row, found.note.onset, found.note.onset + length, found.note)) {
    return fail('another note is in the way');
  }
  const next = clonePhrase(phrase);
  pick(next, found.note).length = length;
  return { ok: true, phrase: next };
}

/**
 * A run along the scale: one note per cell, stepping through the rows that lie
 * between the two endpoints in pitch order. A glissando whose notes actually
 * exist (§4) is written this way rather than as a `gliss` gesture.
 */
function noteInsertRun(phrase: Phrase, fromLabel: string, toLabel: string, onset: number, cells: number): OpResult {
  const order = canonicalRowOrder(phrase);
  const fromAt = order.indexOf(rowIndex(phrase, fromLabel));
  const toAt = order.indexOf(rowIndex(phrase, toLabel));
  if (fromAt < 0) return fail(`no row "${fromLabel}" in this phrase`);
  if (toAt < 0) return fail(`no row "${toLabel}" in this phrase`);
  if (!Number.isInteger(cells) || cells < 1) return fail('a run is at least one cell long');
  if (onset < 0 || onset + cells > phrase.totalCells) return fail('the run does not fit in the grid');

  const next = clonePhrase(phrase);
  const added: PhraseNote[] = [];
  for (let k = 0; k < cells; k++) {
    const t = cells === 1 ? 0 : k / (cells - 1);
    const row = order[Math.round(fromAt + (toAt - fromAt) * t)] as number;
    const at = onset + k;
    if (overlaps(next, row, at, at + 1)) {
      return fail(`row "${(phrase.rows[row] as PhraseRow).label}" already sounds at cell ${at}`);
    }
    const note = { row, onset: at, length: 1, tag: 'o' };
    added.push(note);
    next.notes = sortNotes([...next.notes, note]);
  }
  for (const note of added) note.tag = freeTag(next, note.onset, note);
  return { ok: true, phrase: next };
}

// ------------------------------------------------------------------ group ops

function groupMerge(phrase: Phrase, addresses: string[]): OpResult {
  if (addresses.length < 2) return fail('merging takes at least two addresses');
  const members: PhraseNote[] = [];
  for (const addressText of addresses) {
    const found = notesAt(phrase, addressText);
    if (!found) return fail(`malformed address "${addressText}"`);
    if (found.notes.length === 0) return fail(`"${addressText}" names no note`);
    members.push(...found.notes);
  }
  const onset = (members[0] as PhraseNote).onset;
  if (members.some((n) => n.onset !== onset)) return fail('a group is confined to one onset (§3)');

  const next = clonePhrase(phrase);
  const keys = new Set(members.map(noteKey));
  const tag = freeTagFor(next, onset, keys);
  for (const note of next.notes) if (keys.has(noteKey(note))) note.tag = tag;
  return { ok: true, phrase: next };
}

function groupDetach(phrase: Phrase, addressText: string): OpResult {
  const found = single(phrase, addressText);
  if ('reason' in found) return fail(found.reason);
  const next = clonePhrase(phrase);
  const note = pick(next, found.note);
  note.tag = freeTag(next, note.onset, note);
  return { ok: true, phrase: next };
}

// -------------------------------------------------------------------- row ops

function rowAdd(phrase: Phrase, label: string): OpResult {
  if (rowIndex(phrase, label) >= 0) return fail(`row "${label}" is already there`);
  const namespace = labelNamespace(label);
  if (!namespace) return fail(`"${label}" is not a row label`);
  if (namespace !== phrase.namespace) {
    return fail(`this phrase is in the ${phrase.namespace} namespace — "${label}" is ${namespace}`);
  }
  const tonic = keyToPitchClass(phrase.key) ?? 0;
  const resolved = resolveRowLabel(label, { tonic, scale: phrase.scale });
  if (!resolved.ok) return fail(resolved.reason);

  const next = clonePhrase(phrase);
  next.rows.push({
    label,
    namespace,
    midi: resolved.midi,
    line: 0,
    labelCol: 0,
    cells: new Array<string>(phrase.totalCells).fill('.'),
  });
  return { ok: true, phrase: next };
}

function rowRemove(phrase: Phrase, label: string): OpResult {
  const row = rowIndex(phrase, label);
  if (row < 0) return fail(`no row "${label}" in this phrase`);
  if (phrase.notes.some((n) => n.row === row)) return fail(`row "${label}" still has notes`);
  if (phrase.rows.length === 1) return fail('a phrase needs at least one row');

  const next = clonePhrase(phrase);
  next.rows.splice(row, 1);
  next.notes = next.notes.map((n) => ({ ...n, row: n.row > row ? n.row - 1 : n.row }));
  next.detail = next.detail.filter((e) => e.address.row !== label);
  return { ok: true, phrase: next };
}

// ----------------------------------------------------------------- detail ops

function detailSet(phrase: Phrase, addressText: string, key: GestureKey, value: number | GlissSpec): OpResult {
  const found = notesAt(phrase, addressText);
  if (!found) return fail(`malformed address "${addressText}"`);
  if (found.notes.length === 0) return fail(`"${addressText}" names no note`);
  if (key === 'roll' && found.address.group === null) {
    return fail('roll applies to a group — give the address a group tag, e.g. 1.1a');
  }
  if (key === 'gliss') {
    if (typeof value === 'number') return fail('gliss takes { to, cells, curve }');
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`${key} takes a number`);
  }

  const next = clonePhrase(phrase);
  const existing = next.detail.find((e) => e.address.text === found.address.text);
  if (existing) {
    (existing.gestures as Record<string, unknown>)[key] = value;
  } else {
    next.detail.push({
      address: found.address,
      gestures: { [key]: value } as Gestures,
      line: 0,
      col: 0,
    });
  }
  return { ok: true, phrase: next };
}

function detailClear(phrase: Phrase, addressText: string, key: GestureKey): OpResult {
  const sink = new ErrorSink();
  const address = parseAddress(addressText, { line: 0, col: 0 }, sink);
  if (!address) return fail(`malformed address "${addressText}"`);

  const next = clonePhrase(phrase);
  const entry = next.detail.find((e) => e.address.text === address.text);
  if (!entry || entry.gestures[key] === undefined) return fail(`"${address.text}" has no ${key}`);
  delete (entry.gestures as Record<string, unknown>)[key];
  next.detail = next.detail.filter((e) => Object.keys(e.gestures).length > 0);
  return { ok: true, phrase: next };
}

// ----------------------------------------------------------------- phrase ops

function phraseTranspose(phrase: Phrase, steps: number): OpResult {
  if (!Number.isInteger(steps)) return fail('transpose takes whole degrees or semitones');
  if (phrase.namespace === 'percussion') return fail('percussion rows have no pitch to transpose');
  if (steps === 0) return { ok: true, phrase };

  const tonic = keyToPitchClass(phrase.key) ?? 0;
  const next = clonePhrase(phrase);
  const renamed = new Map<string, string>();
  for (const row of next.rows) {
    const label = transposeLabel(row.label, steps, phrase.scale);
    if (label === null) return fail(`row "${row.label}" cannot move by ${steps}`);
    const resolved = resolveRowLabel(label, { tonic, scale: phrase.scale });
    if (!resolved.ok) return fail(resolved.reason);
    renamed.set(row.label, label);
    row.label = label;
    row.midi = resolved.midi;
  }
  if (new Set(next.rows.map((r) => r.label)).size !== next.rows.length) {
    return fail('transposing would collapse two rows onto one label');
  }
  // Addresses name the row as written, so they move with it.
  for (const entry of next.detail) {
    if (entry.address.row === null) continue;
    const label = renamed.get(entry.address.row);
    if (label !== undefined) {
      entry.address = { ...entry.address, row: label };
      entry.address.text = formatAddress(entry.address);
    }
  }
  return { ok: true, phrase: next };
}

function phraseSetKey(phrase: Phrase, key: string, scale: string): OpResult {
  const tonic = keyToPitchClass(key);
  if (tonic === null) return fail(`"${key}" is not a pitch class like C, Eb or F#`);
  if (!SCALES[scale]) return fail(`unknown scale "${scale}"`);

  const next = clonePhrase(phrase);
  next.key = key;
  next.scale = scale;
  for (const row of next.rows) {
    const resolved = resolveRowLabel(row.label, { tonic, scale });
    if (!resolved.ok) return fail(resolved.reason);
    row.midi = resolved.midi;
  }
  return { ok: true, phrase: next };
}

// -------------------------------------------------------------------- helpers

function noteKey(note: PhraseNote): string {
  return `${note.row}:${note.onset}`;
}

/** The same note inside a cloned phrase. */
function pick(phrase: Phrase, like: PhraseNote): PhraseNote {
  return phrase.notes.find((n) => n.row === like.row && n.onset === like.onset) as PhraseNote;
}

/** A tag no other group at this onset is using. */
function freeTag(phrase: Phrase, onset: number, except?: PhraseNote): string {
  return freeTagFor(phrase, onset, new Set(except ? [noteKey(except)] : []));
}

function freeTagFor(phrase: Phrase, onset: number, ignore: Set<string>): string {
  const taken = new Set(
    phrase.notes.filter((n) => n.onset === onset && !ignore.has(noteKey(n))).map((n) => n.tag),
  );
  for (let c = 97; c <= 122; c++) {
    const tag = String.fromCharCode(c);
    if (!taken.has(tag)) return tag;
  }
  return 'o';
}

/**
 * §7 rule 4: an entry that named the note we just moved has to follow it. When
 * the entry named that note alone the address is rewritten in place; when it
 * named others too the entry stays where it is and the moved note gains one of
 * its own, so nothing else changes meaning.
 */
function rewriteMovedAddresses(before: Phrase, was: PhraseNote, after: Phrase, now: PhraseNote): void {
  const extra: DetailEntry[] = [];
  for (const entry of after.detail) {
    if (!matchesAddress(before, was, entry.address)) continue;
    if (matchesAddress(after, now, entry.address)) continue;

    const others = before.notes.filter((n) => n !== was && matchesAddress(before, n, entry.address));
    const at = cellCoords(after, now.onset);
    const label = (after.rows[now.row] as PhraseRow).label;
    if (others.length === 0) {
      const moved: Address = {
        bar: entry.address.bar === null ? null : at.bar,
        beat: entry.address.beat === null ? null : at.beat,
        tick: entry.address.tick === null ? null : at.tick,
        group: entry.address.group === null ? null : now.tag,
        row: entry.address.row === null ? null : label,
        specificity: entry.address.specificity,
        text: '',
      };
      moved.text = formatAddress(moved);
      entry.address = moved;
      continue;
    }
    const own: Address = {
      bar: at.bar,
      beat: at.beat,
      tick: at.tick,
      group: now.tag,
      row: label,
      specificity: 5,
      text: '',
    };
    own.text = formatAddress(own);
    extra.push({ address: own, gestures: { ...entry.gestures }, line: 0, col: 0 });
  }
  after.detail.push(...extra);
}

// --------------------------------------------------------------------- text

/**
 * Apply an operation to the document. The phrase is re-parsed, the model does
 * the thinking, and only the bytes that differ are written.
 */
export function applyText(doc: string, phraseId: string, op: Op): EditResult {
  if (op.kind === 'loop.bind') return bindLoopLine(doc, op.track, op.phrase);

  const loaded = loadPhrase(doc, phraseId);
  if (!loaded) return { ok: false, reason: `no \`\`\`phrase fence with id "${phraseId}" that parses` };
  const { fence, phrase } = loaded;

  const result = applyModel(phrase, op);
  if (!result.ok) return { ok: false, reason: result.reason };

  if (op.kind === 'phrase.setKey') {
    // The one operation whose target is a token in the info string.
    const withKey = setFenceAttr(doc, fence, 'key', op.key);
    if (!withKey.ok) return withKey;
    const again = phraseFenceOf(withKey.doc, phraseId);
    if (!again) return { ok: false, reason: 'the phrase fence vanished' };
    return setFenceAttr(withKey.doc, again, 'scale', op.scale);
  }

  const before = formatPhraseParts(phrase);
  const after = formatPhraseParts(result.phrase);

  // A body that is not already canonical has no stable geometry to patch, so
  // the operation rewrites it — which is what rule 1 asks for anyway.
  if (fence.body !== formatPhrase(phrase)) {
    return replacePhraseBody(doc, fence, formatPhrase(result.phrase));
  }

  // Detail first: it sits below the grid, so its line numbers survive a grid
  // rewrite done afterwards, but not the other way round.
  let out = doc;
  if (!sameLines(before.detail, after.detail)) {
    if (before.detail.length === after.detail.length) {
      for (let i = 0; i < after.detail.length; i++) {
        if (before.detail[i] === after.detail[i]) continue;
        const entry = phrase.detail[i] as DetailEntry;
        const patched = patchLine(out, entry.line, before.detail[i] as string, after.detail[i] as string);
        if (!patched.ok) return patched;
        out = patched.doc;
      }
    } else {
      const patched = replaceDetailBlock(out, phrase, after.detail);
      if (!patched.ok) return patched;
      out = patched.doc;
    }
  }

  if (!sameLines(before.grid, after.grid)) {
    const grid = gridStart(phrase);
    if (before.grid.length !== after.grid.length) {
      const patched = replaceGridBlock(out, phrase, after.grid);
      if (!patched.ok) return patched;
      out = patched.doc;
    } else {
      for (let i = 0; i < after.grid.length; i++) {
        if (before.grid[i] === after.grid[i]) continue;
        const patched = patchLine(out, grid + i, before.grid[i] as string, after.grid[i] as string);
        if (!patched.ok) return patched;
        out = patched.doc;
      }
    }
  }

  return { ok: true, doc: out };
}

function phraseFenceOf(doc: string, id: string) {
  return loadPhrase(doc, id)?.fence;
}

function gridStart(phrase: Phrase): number {
  return phrase.gridLine ?? (phrase.rows[0] as PhraseRow).line;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Replace only what changed on one line. Equal-length lines — every cell write
 * — come out as one span per differing run, so a note placement touches exactly
 * as many characters as it changed.
 */
function patchLine(doc: string, line: number, before: string, after: string): EditResult {
  if (before === after) return { ok: true, doc };
  if (before.length !== after.length) return replaceLines(doc, line, line, [after]);

  let out = doc;
  let i = 0;
  while (i < before.length) {
    if (before[i] === after[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < before.length && before[end] !== after[end]) end++;
    const patched = replaceSpan(out, { line, col: i + 1, endCol: end + 1 }, after.slice(i, end));
    if (!patched.ok) return patched;
    out = patched.doc;
    i = end;
  }
  return { ok: true, doc: out };
}

/** `loop.bind`: point one track's line at a phrase id. */
function bindLoopLine(doc: string, trackId: string, phraseId: string): EditResult {
  const refs = loopLines(doc);
  const ref = refs.find((l) => l.trackId === trackId);
  if (!ref) return { ok: false, reason: `no loop line for "${trackId}"` };
  const pad = Math.max(...refs.map((l) => l.trackId.length)) + 2;
  return setLoopLine(doc, trackId, `${`${trackId}:`.padEnd(pad)}${phraseId}`);
}
