// Renders a plugin track inside a real AudioWorklet and prints the peak.
//
// Driven by scripts/check-worklet-plugin.sh, which builds first. See that file
// for why this is a script and not a test.
//
// The page is served from `web/dist` because that is the arrangement the app
// actually ships: `worklet.js` and `wclap-host.js` beside each other, the WCLAP
// bundle in a directory, and every URL relative to the same base.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../web/dist');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
};

if (!existsSync(join(ROOT, 'wclap-host.js'))) {
  console.error('web/dist has no wclap-host.js — run scripts/check-worklet-plugin.sh instead');
  process.exit(2);
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // `/__sheliak/doc` is the app asking whether `sheliak serve` is behind it.
    // Nothing is, and the app copes; anything else 404ing is worth seeing.
    if (!path.startsWith('/__sheliak/')) console.log(`  404 ${path}`);
    res.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`;

// `PLAYWRIGHT_CHROMIUM` points at a browser Playwright did not install
// itself, which is the usual case on a machine that already has one.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error' && !text.includes('404')) console.error('  page error:', text);
});
await page.goto(base);

/**
 * Boots the same two worklet modules the app boots, sends the same messages,
 * and renders two seconds offline. The document is one plugin track playing
 * one note, so the peak is entirely the plugin's.
 */
const result = await page.evaluate(async () => {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 48000 * 2, sampleRate: 48000 });
  await ctx.audioWorklet.addModule('wclap-host.js');
  await ctx.audioWorklet.addModule('worklet.js');

  const node = new AudioWorkletNode(ctx, 'sheliak-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(ctx.destination);

  const status = [];
  const ready = new Promise((done) => {
    node.port.onmessage = (ev) => {
      if (ev.data?.type === 'ready') done();
      if (ev.data?.type === 'plugin-status') status.push(ev.data);
      if (ev.data?.type === 'error') status.push(ev.data);
    };
  });

  const dsp = await (await fetch('dsp.wasm')).arrayBuffer();
  node.port.postMessage({ type: 'load-wasm', bytes: dsp }, [dsp]);
  await ready;

  const bundle = await (await fetch('sheliak.wclap/module.wasm')).arrayBuffer();
  node.port.postMessage({
    type: 'plugins',
    bundles: [bundle],
    tracks: [
      {
        id: 'lead',
        track: 0,
        from: 'io.github.ayatough.sheliak.synth',
        params: { cutoff: { kind: 'normalized', value: 0.5, raw: '50%' } },
      },
    ],
  });
  // The rack is built on the message, before any rendering starts.
  await new Promise((done) => setTimeout(done, 200));

  node.port.postMessage({
    type: 'loop',
    loop: {
      lengthSamples: 48000,
      events: [
        { offsetSamples: 0, kind: 0, track: 0, note: 60, velocity: 1 },
        { offsetSamples: 24000, kind: 1, track: 0, note: 60, velocity: 0 },
      ],
    },
  });
  node.port.postMessage({ type: 'transport', playing: true });
  // Offline rendering starts as fast as the thread can go, and port messages
  // are delivered asynchronously — without this the first blocks can render
  // before the transport ever started.
  await new Promise((done) => setTimeout(done, 200));

  const rendered = await ctx.startRendering();
  const left = rendered.getChannelData(0);
  let peak = 0;
  for (const sample of left) peak = Math.max(peak, Math.abs(sample));
  return { peak, status, frames: left.length };
});

await browser.close();
server.close();

for (const message of result.status) {
  if (message.type === 'error') console.log(`worklet error: ${message.message}`);
  else console.log(`plugin tracks: ${message.tracks}, errors: ${JSON.stringify(message.errors)}`);
}
console.log(`rendered ${result.frames} frames, peak ${result.peak.toFixed(4)}`);

const failed = result.status.some((m) => m.type === 'error' || (m.errors ?? []).length > 0);
if (failed || result.peak <= 0.01) {
  console.log('\nFAILED: the worklet did not play the plugin track.');
  process.exit(1);
}
console.log('\nThe audio thread played a CLAP plugin.');
