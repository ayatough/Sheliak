// The document, when it is a file on disk.
//
// The app normally opens `defaultDoc.ts` and keeps the song in a textarea, which
// is why composing meant copy-paste: nothing the browser holds outlives a
// reload. Under `sheliak serve` there is a real file behind it, and this is the
// two-way link — the file's contents at boot, the file's changes while you edit
// it in your own editor, and the GUI's changes written back.
//
// It is written against injected transports rather than `fetch` and
// `import.meta.hot` directly, because the interesting part is the loop-breaking:
// a change this client wrote must not come back as a change to apply, or every
// keystroke would fight the file watcher.

/** Matches the JSON `sheliak serve` answers `GET /__sheliak/doc` with. */
export interface DocPayload {
  path: string;
  text: string;
}

export interface DocTransport {
  /** Resolves null when nothing is serving a file — the published app, or plain `npm run dev`. */
  load(): Promise<DocPayload | null>;
  save(text: string): Promise<void>;
  /** Registers a listener for changes made to the file by anything else. */
  onRemote(handler: (payload: DocPayload) => void): void;
}

export interface DocFileOptions {
  transport: DocTransport;
  /** Called with text that arrived from disk and should replace the editor's. */
  apply(text: string): void;
  /** Milliseconds of quiet before a local edit is written back. */
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

const DEFAULT_DEBOUNCE_MS = 400;

/**
 * Keeps a textarea and a file in step.
 *
 * Both directions are guarded by the same one-line rule: **text equal to what we
 * last exchanged is not a change.** That is what stops the round trip — our own
 * write coming back through the watcher — without timestamps or version numbers,
 * neither of which would survive the user editing both sides at once anyway.
 */
export class DocFile {
  private readonly opts: DocFileOptions;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (handle: number) => void;

  /** The last text known to be on disk, whichever side put it there. */
  private synced: string | null = null;
  private timer: number | undefined;
  private pending: string | null = null;

  /** Absolute path of the file being served, once known. */
  path: string | null = null;

  constructor(opts: DocFileOptions) {
    this.opts = opts;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  }

  /**
   * Loads the file, if one is being served. Returns its text, or null when the
   * app is running without a file behind it — in which case every other method
   * here is inert and the caller keeps its own document.
   */
  async start(): Promise<string | null> {
    const payload = await this.opts.transport.load();
    if (payload === null) return null;
    this.path = payload.path;
    this.synced = payload.text;
    this.opts.transport.onRemote((incoming) => {
      // Our own write, arriving back through the watcher.
      if (incoming.text === this.synced) return;
      this.synced = incoming.text;
      // A local edit still queued is now stale: the file moved under it, and
      // writing it would undo what the other editor just did.
      this.cancelPending();
      this.opts.apply(incoming.text);
    });
    return payload.text;
  }

  /** Records a local edit. Written back once the typing stops. */
  changed(text: string): void {
    if (this.path === null || text === this.synced) return;
    this.pending = text;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  /** Writes any queued edit immediately. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const text = this.pending;
    this.pending = null;
    if (text === null || text === this.synced) return;
    this.synced = text;
    await this.opts.transport.save(text);
  }

  private cancelPending(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.pending = null;
  }
}

/** The endpoints `serve` answers on. Shared so the two halves cannot disagree. */
export const DOC_ENDPOINT = '/__sheliak/doc';
export const DOC_EVENTS_ENDPOINT = '/__sheliak/events';

/**
 * The real transport: `fetch` for both directions and an EventSource for the
 * push. `load()` answering null is the normal case — the published app is not
 * served by anything that knows these endpoints — and the stream is only opened
 * once it has answered, so nothing on GitHub Pages ever holds a request open.
 */
export function browserTransport(): DocTransport {
  return {
    async load() {
      try {
        const response = await fetch(DOC_ENDPOINT);
        if (!response.ok) return null;
        return (await response.json()) as DocPayload;
      } catch {
        return null;
      }
    },
    async save(text) {
      try {
        await fetch(DOC_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch {
        // A failed write is not worth interrupting playback for; the next edit
        // retries, and the status line already shows the file being served.
      }
    },
    onRemote(handler) {
      if (typeof EventSource === 'undefined') return;
      const stream = new EventSource(DOC_EVENTS_ENDPOINT);
      stream.onmessage = (event) => {
        try {
          handler(JSON.parse(event.data) as DocPayload);
        } catch {
          // A frame we cannot read is not worth tearing the stream down for.
        }
      };
    },
  };
}
