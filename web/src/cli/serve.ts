// `sheliak serve` — the app, pointed at a file on disk.
//
// This is the command that removes the copy-paste. The app normally opens a
// document compiled into its own bundle and keeps it in a textarea; this serves
// *your* file, reloads the page when you save it in your own editor, and writes
// the GUI's edits back to it. The document stays the single source of truth, and
// for the first time that source is somewhere that survives a reload.
//
// It serves the *built* app over a plain Node HTTP server rather than running
// Vite. That is what lets a release tarball contain everything `serve` needs —
// no repository, no node_modules, no bundler — and it leaves the CLI with no
// runtime dependency at all. Working on the app itself is what `npm run dev` is
// for; this command is for working on a song.

import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_ENDPOINT, DOC_EVENTS_ENDPOINT } from '../docFile.ts';

export interface ServeOptions {
  port: number;
  /** Overrides the located app directory. */
  root?: string;
}

export interface RunningServer {
  url: string;
  /** The directory being served, for the line the CLI prints. */
  root: string;
  close(): Promise<void>;
}

/**
 * Where the built app lives, relative to the module asking for it. Three
 * layouts, because this runs from three places: an installed release, where
 * `app/` sits beside the bundle; the bundle in a working copy at
 * `web/dist-cli/`; and the source at `web/src/cli/` under vitest.
 */
export function defaultAppRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, 'app'), resolve(here, '../dist'), resolve(here, '../../dist')];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[0];
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Starts the server and resolves once it is listening. */
export async function serve(file: string, opts: ServeOptions): Promise<RunningServer> {
  if (!existsSync(file)) {
    throw new Error(`cannot serve ${file}: no such file. \`sheliak new ${file}\` writes one`);
  }
  const root = opts.root ?? defaultAppRoot();
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(
      `cannot find the app to serve (looked in ${root}).\n` +
        '  From a working copy, build it first: cd web && npm run build',
    );
  }
  if (!existsSync(join(root, 'dsp.wasm'))) {
    throw new Error(
      `the DSP core is missing from ${root}, so the page would load without a synth.\n` +
        '  From a working copy, run ./scripts/build-wasm.sh and rebuild the app.',
    );
  }

  const path = resolve(file);
  /**
   * What was last read from or written to the file. The watcher compares against
   * it so a write made through the browser does not come back as a change to
   * apply — `docFile.ts` holds the other half of the same rule.
   */
  let known = readFileSync(path, 'utf8');
  const listeners = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === DOC_ENDPOINT) return document(req, res);
    if (url.pathname === DOC_EVENTS_ENDPOINT) return events(res);
    return staticFile(url.pathname, res);
  });

  function document(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET') {
      try {
        known = readFileSync(path, 'utf8');
      } catch {
        /* keep the last good text */
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path, text: known }));
      return;
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const text = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: string }).text;
          if (typeof text !== 'string') throw new Error('no text');
          known = text;
          writeFileSync(path, text);
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(405).end();
  }

  /**
   * Server-sent events rather than a WebSocket: one direction is all this needs
   * — the page writes back over POST — and EventSource reconnects on its own,
   * which a hand-rolled socket would have to be taught to do.
   */
  function events(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    listeners.add(res);
    res.on('close', () => listeners.delete(res));
  }

  function staticFile(pathname: string, res: ServerResponse): void {
    // `normalize` after stripping the leading slash, then a prefix check: a
    // request for `/../../etc/passwd` must not escape the served directory.
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let target = resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
    if (!target.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    if (!existsSync(target)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      // The app is rebuilt under the server's feet in a working copy, and a
      // song is not worth a stale bundle.
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  }

  // `fs.watch` rather than watching the served directory: the file being edited
  // is somewhere else entirely, which is the whole point of the command.
  watcher = watch(path, () => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return; // mid-write, or replaced by an editor's atomic save
    }
    if (text === known) return;
    known = text;
    const payload = `data: ${JSON.stringify({ path, text })}\n\n`;
    for (const listener of listeners) listener.write(payload);
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(opts.port, () => {
      server.off('error', fail);
      done();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  return {
    url: `http://localhost:${port}/`,
    root,
    async close() {
      watcher?.close();
      for (const listener of listeners) listener.end();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
