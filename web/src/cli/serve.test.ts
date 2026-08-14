// `sheliak serve` over a real socket. The server is small enough that the
// interesting parts are all edge cases: what it refuses, what it will not serve,
// and whether a change on disk actually reaches a listener.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type RunningServer } from './serve.ts';
import { DOC_ENDPOINT, DOC_EVENTS_ENDPOINT } from '../docFile.ts';

let dir: string;
let app: string;
let song: string;
let running: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheliak-serve-'));
  app = join(dir, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(app, 'dsp.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  song = join(dir, 'song.md');
  writeFileSync(song, '# a song\n');
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Starts on an ephemeral port so tests cannot collide with anything. */
async function start(): Promise<string> {
  running = await serve(song, { port: 0, root: app });
  return running.url.replace(/\/$/, '');
}

describe('what it refuses', () => {
  it('a song that does not exist, naming the command that writes one', async () => {
    await expect(serve(join(dir, 'absent.md'), { port: 0, root: app })).rejects.toThrow(/sheliak new/);
  });

  it('an app directory with no index.html', async () => {
    await expect(serve(song, { port: 0, root: dir })).rejects.toThrow(/cannot find the app/);
  });

  it('an app with no dsp.wasm, rather than a page with no synth', async () => {
    rmSync(join(app, 'dsp.wasm'));
    await expect(serve(song, { port: 0, root: app })).rejects.toThrow(/DSP core is missing/);
  });
});

describe('the document endpoint', () => {
  it('hands out the file and where it came from', async () => {
    const base = await start();
    const body = await (await fetch(base + DOC_ENDPOINT)).json();
    expect(body).toEqual({ path: song, text: '# a song\n' });
  });

  it('reads the file again on every request', async () => {
    const base = await start();
    writeFileSync(song, '# changed on disk\n');
    const body = await (await fetch(base + DOC_ENDPOINT)).json();
    expect(body.text).toBe('# changed on disk\n');
  });

  it('writes a posted document to disk', async () => {
    const base = await start();
    const res = await fetch(base + DOC_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# from the page\n' }),
    });
    expect(res.status).toBe(204);
    expect(readFileSync(song, 'utf8')).toBe('# from the page\n');
  });

  it('rejects a body that is not a document', async () => {
    const base = await start();
    const res = await fetch(base + DOC_ENDPOINT, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect(readFileSync(song, 'utf8')).toBe('# a song\n');
  });
});

describe('static files', () => {
  it('serves the app, with the content type the browser needs for wasm', async () => {
    const base = await start();
    expect((await fetch(`${base}/`)).status).toBe(200);
    const wasm = await fetch(`${base}/dsp.wasm`);
    // Chrome refuses to compile a wasm module served as anything else.
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
  });

  it('does not serve anything outside the app directory', async () => {
    // The song itself sits one level up, which makes it the obvious probe.
    const base = await start();
    for (const path of ['/../song.md', '/%2e%2e/song.md', '/../../etc/passwd']) {
      const res = await fetch(base + path);
      expect(await res.text()).not.toContain('a song');
    }
  });

  it('answers 404 for something that is simply not there', async () => {
    const base = await start();
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
  });
});

describe('the event stream', () => {
  it('pushes a change made on disk', async () => {
    const base = await start();
    const res = await fetch(base + DOC_EVENTS_ENDPOINT);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the ": connected" preamble

    writeFileSync(song, '# saved in another editor\n');
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(JSON.parse(frame.slice(6)).text).toBe('# saved in another editor\n');
    await reader.cancel();
  });

  it('does not push back what the page itself wrote', async () => {
    // Otherwise the page and the file trade the same text forever.
    const base = await start();
    const res = await fetch(base + DOC_EVENTS_ENDPOINT);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();

    await fetch(base + DOC_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# from the page\n' }),
    });
    const race = await Promise.race([
      reader.read().then(() => 'pushed'),
      new Promise((done) => setTimeout(() => done('quiet'), 600)),
    ]);
    expect(race).toBe('quiet');
    await reader.cancel();
  });
});
