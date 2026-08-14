// The file-backed document. What is worth testing here is the loop-breaking:
// with a watcher pushing changes in and the editor pushing changes out, the
// easy mistake is for one write to bounce forever, or for a queued local edit
// to overwrite something the other editor just saved.

import { describe, it, expect } from 'vitest';
import { DocFile, type DocPayload, type DocTransport } from './docFile.ts';

/** A transport with no timers and no network, recording everything it is told. */
function fake(initial: DocPayload | null) {
  const saved: string[] = [];
  let push: ((payload: DocPayload) => void) | undefined;
  const transport: DocTransport = {
    load: async () => initial,
    save: async (text) => {
      saved.push(text);
    },
    onRemote: (handler) => {
      push = handler;
    },
  };
  return {
    transport,
    saved,
    /** Simulates the file changing under us. */
    remote(text: string) {
      push?.({ path: initial?.path ?? '/song.md', text });
    },
  };
}

/** Runs timers inline, so `changed()` writes back on the spot. */
function immediate() {
  return {
    setTimer: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimer: () => {},
  };
}

function docFile(initial: DocPayload | null, applied: string[] = []) {
  const io = fake(initial);
  const doc = new DocFile({ transport: io.transport, apply: (t) => applied.push(t), ...immediate() });
  return { doc, io, applied };
}

describe('without a file behind it', () => {
  it('reports nothing to adopt and stays inert', async () => {
    const { doc, io } = docFile(null);
    expect(await doc.start()).toBeNull();
    expect(doc.path).toBeNull();
    doc.changed('anything at all');
    await doc.flush();
    expect(io.saved).toEqual([]);
  });
});

describe('with a file behind it', () => {
  const initial = { path: '/songs/demo.md', text: 'one' };

  it('hands back the file and remembers where it came from', async () => {
    const { doc } = docFile(initial);
    expect(await doc.start()).toBe('one');
    expect(doc.path).toBe('/songs/demo.md');
  });

  it('writes a local edit back', async () => {
    const { doc, io } = docFile(initial);
    await doc.start();
    doc.changed('two');
    expect(io.saved).toEqual(['two']);
  });

  it('does not write text the file already has', async () => {
    const { doc, io } = docFile(initial);
    await doc.start();
    doc.changed('one');
    expect(io.saved).toEqual([]);
  });

  it('does not write the same text twice', async () => {
    const { doc, io } = docFile(initial);
    await doc.start();
    doc.changed('two');
    doc.changed('two');
    expect(io.saved).toEqual(['two']);
  });

  it('applies a change made by another editor', async () => {
    const { doc, io, applied } = docFile(initial);
    await doc.start();
    io.remote('from vim');
    expect(applied).toEqual(['from vim']);
  });

  it('ignores its own write coming back through the watcher', async () => {
    // The round trip: without this the page and the file would trade the same
    // text forever, each one seeing the other's echo as a new change.
    const { doc, io, applied } = docFile(initial);
    await doc.start();
    doc.changed('two');
    io.remote('two');
    expect(applied).toEqual([]);
  });

  it('drops a queued local edit when the file moves under it', async () => {
    // Otherwise the debounce would fire after the external change and quietly
    // undo it — the one data-losing outcome in the whole exchange.
    const io = fake(initial);
    const applied: string[] = [];
    let fire: (() => void) | undefined;
    const doc = new DocFile({
      transport: io.transport,
      apply: (t) => applied.push(t),
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {
        fire = undefined;
      },
    });
    await doc.start();
    doc.changed('typed in the browser');
    io.remote('saved in vim');
    fire?.();
    await doc.flush();
    expect(applied).toEqual(['saved in vim']);
    expect(io.saved).toEqual([]);
  });

  it('flushes a pending edit on demand', async () => {
    const io = fake(initial);
    const doc = new DocFile({
      transport: io.transport,
      apply: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await doc.start();
    doc.changed('two');
    expect(io.saved).toEqual([]);
    await doc.flush();
    expect(io.saved).toEqual(['two']);
  });
});
