// `sheliak serve` — the app, pointed at a file on disk.
//
// This is the command that removes the copy-paste. `npm run dev` serves a
// document compiled into the bundle; this serves *your* file, reloads the
// browser when you save it in your own editor, and writes the GUI's edits back
// to it. The document stays the single source of truth, and for the first time
// that source is somewhere that survives a reload.
//
// It runs Vite's dev server rather than shipping a copy of the built app, so
// what you hear is the app as it exists in this working copy. That also means
// `serve`, unlike `new` and `check`, needs the repository: Vite and the app's
// sources have to be there.

import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_ENDPOINT, DOC_EVENT } from '../docFile.ts';

export interface ServeOptions {
  port: number;
  /** Overrides the located `web/` directory. */
  root?: string;
}

/**
 * The app's directory, relative to the module asking for it: one hop up from
 * the bundle at `web/dist-cli/`, two from `web/src/cli/` under vitest.
 */
export function defaultAppRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..'), resolve(here, '../..')];
  return candidates.find((dir) => existsSync(resolve(dir, 'index.html'))) ?? candidates[0];
}

/**
 * Starts the server and resolves once it is listening. Never returns on its own
 * — the caller's process stays up until it is interrupted.
 */
export async function serve(file: string, opts: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  if (!existsSync(file)) {
    throw new Error(`cannot serve ${file}: no such file. \`sheliak new ${file}\` writes one`);
  }
  const root = opts.root ?? defaultAppRoot();
  if (!existsSync(resolve(root, 'index.html'))) {
    throw new Error(
      `cannot find the app to serve (looked in ${root}).\n` +
        '  `serve` runs the app from a working copy, so it needs the repository:\n' +
        '  git clone https://github.com/ayatough/Sheliak && cd Sheliak && npm install',
    );
  }
  if (!existsSync(resolve(root, 'public/dsp.wasm'))) {
    throw new Error(
      'the DSP core is not built, so the page would load without a synth.\n' +
        '  Run ./scripts/build-wasm.sh first (needs Rust with the\n' +
        '  wasm32-unknown-unknown target).',
    );
  }

  const vite = await importVite();
  const path = resolve(file);

  /**
   * What was last read from or written to the file. The watcher compares
   * against it so that a write made through the browser does not come back as
   * a change to apply — see `docFile.ts`, which holds the other half of the
   * same rule.
   */
  let known = readFileSync(path, 'utf8');
  let watcher: FSWatcher | undefined;

  const server = await vite.createServer({
    root,
    server: { port: opts.port, strictPort: false },
    plugins: [
      {
        name: 'sheliak-serve-document',
        configureServer(dev: ViteDevServer) {
          dev.middlewares.use(DOC_ENDPOINT, (req, res, next) => {
            if (req.method === 'GET') {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ path, text: readCurrent() }));
              return;
            }
            if (req.method === 'POST') {
              collect(req)
                .then((body) => {
                  const text = (JSON.parse(body) as { text?: string }).text;
                  if (typeof text !== 'string') throw new Error('no text');
                  known = text;
                  writeFileSync(path, text);
                  res.statusCode = 204;
                  res.end();
                })
                .catch(() => {
                  res.statusCode = 400;
                  res.end();
                });
              return;
            }
            next();
          });

          // `fs.watch` rather than Vite's own watcher: the file is usually
          // outside the served root, which Vite has no reason to be watching.
          watcher = watch(path, () => {
            let text: string;
            try {
              text = readFileSync(path, 'utf8');
            } catch {
              return; // mid-write, or replaced by an editor's atomic save
            }
            if (text === known) return;
            known = text;
            dev.ws.send({ type: 'custom', event: DOC_EVENT, data: { path, text } });
          });
        },
      },
    ],
  });

  function readCurrent(): string {
    try {
      known = readFileSync(path, 'utf8');
    } catch {
      /* keep the last good text */
    }
    return known;
  }

  await server.listen();
  const port = server.config.server.port ?? opts.port;
  return {
    url: `http://localhost:${port}/`,
    async close() {
      watcher?.close();
      await server.close();
    },
  };
}

/** Minimal shape of what this uses from a Vite dev server. */
interface ViteDevServer {
  middlewares: { use(route: string, fn: (req: NodeRequest, res: NodeResponse, next: () => void) => void): void };
  ws: { send(payload: { type: string; event: string; data: unknown }): void };
}

interface NodeRequest {
  method?: string;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
}

interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function collect(req: NodeRequest): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/**
 * Vite is a build-time dependency everywhere else, so it is imported at the
 * moment it is needed and its absence is reported as what it means rather than
 * as a module resolution failure.
 */
async function importVite(): Promise<{
  createServer(config: unknown): Promise<{
    listen(): Promise<unknown>;
    close(): Promise<void>;
    config: { server: { port?: number } };
  }>;
}> {
  try {
    return (await import('vite')) as never;
  } catch {
    throw new Error(
      'serve needs Vite, which means running from a working copy:\n' +
        '  git clone https://github.com/ayatough/Sheliak && cd Sheliak && npm install\n' +
        '  `new`, `check` and `render` do not need it.',
    );
  }
}
