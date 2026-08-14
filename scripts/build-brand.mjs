#!/usr/bin/env node
// Generates every Sheliak brand asset from one description of the geometry.
//
//   node scripts/build-brand.mjs          # SVG only
//   node scripts/build-brand.mjs --png    # SVG + the PNGs the web app serves
//
// The SVGs under assets/brand/ and the icons under web/public/ are OUTPUT.
// Edit this file, re-run it, and commit the result — do not hand-edit the SVGs,
// because the mark is embedded in eight of them and they drift apart silently.
//
// Nothing here depends on a font: the wordmark is drawn as monoline paths, so
// every asset renders identically on a machine that has no fonts installed at
// all. Only the small supporting copy on the banner and the social card is live
// text, in a monospace stack where a substitution is cosmetic.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'assets', 'brand');
const PUBLIC = join(ROOT, 'web', 'public');

// ---------------------------------------------------------------- palette ---

const C = {
  gold: '#E5A900',       // the brand gold, on dark
  goldHi: '#FFD45A',     // highlight, top of the gradient
  goldMid: '#EDB000',
  goldLow: '#D19700',
  goldDeep: '#B07E00',   // on light: 3.4:1 against the cream, where the gold is 1.9:1
  dark: '#0A0C0B',
  darkSurface: '#111411',
  darkLine: '#2C302C',
  light: '#FAF8F1',
  lightLine: '#E3DED0',
  ink: '#171916',        // type on light
  paper: '#F4F2EA',      // type on dark
  muted: '#A7AAA2',
  mutedLight: '#6E7269',
};

// ------------------------------------------------------------------ maths ---

const RAD = Math.PI / 180;
const n = (v) => {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * The lyre: an elliptical arc, open at the top, whose stroke thins towards both
 * ends. The taper is the whole reason this is computed rather than written as a
 * stroked path — a constant-width arc reads as a loading spinner.
 */
function taperedArc({ cx, cy, rx, ry, gapDeg, hMax, hMin, taper, samples = 120 }) {
  const at = (deg) => [cx + rx * Math.sin(deg * RAD), cy - ry * Math.cos(deg * RAD)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const halfWidth = (s) => {
    const e = Math.min(s, 1 - s) / taper;
    return e >= 1 ? hMax : hMin + (hMax - hMin) * smooth(e);
  };
  const outer = [];
  const inner = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const deg = gapDeg + (360 - 2 * gapDeg) * s;
    const [x, y] = at(deg);
    const [xa, ya] = at(deg - 0.15);
    const [xb, yb] = at(deg + 0.15);
    const tx = xb - xa;
    const ty = yb - ya;
    const len = Math.hypot(tx, ty) || 1;
    const h = halfWidth(s);
    outer.push([x - (ty / len) * h, y + (tx / len) * h]);
    inner.push([x + (ty / len) * h, y - (tx / len) * h]);
  }
  const run = (pts) => pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L');
  return `M${run(outer)}L${run(inner.reverse())}Z`;
}

/** A four-ray star with concave flanks: β Lyrae, the star the project is named for. */
function star({ cx, cy, rx, ry, w1, w2 }) {
  const p = (x, y) => `${n(x)} ${n(y)}`;
  return [
    `M${p(cx, cy - ry)}`,
    `C${p(cx + w1, cy - w2)} ${p(cx + w2, cy - w1)} ${p(cx + rx, cy)}`,
    `C${p(cx + w2, cy + w1)} ${p(cx + w1, cy + w2)} ${p(cx, cy + ry)}`,
    `C${p(cx - w1, cy + w2)} ${p(cx - w2, cy + w1)} ${p(cx - rx, cy)}`,
    `C${p(cx - w2, cy - w1)} ${p(cx - w1, cy - w2)} ${p(cx, cy - ry)}`,
    'Z',
  ].join('');
}

// ------------------------------------------------------------------- mark ---

const ARC = { cx: 512, cy: 596, rx: 256, ry: 272, gapDeg: 37, hMax: 13.5, hMin: 4.5, taper: 0.16 };
const STAR = { cx: 512, cy: 292, rx: 74, ry: 96, w1: 6, w2: 26 };

// Five strings, one lit segment each. The segments are the same length and step
// down in pairs — an arpeggio, not a bar chart. The centre note is held longer,
// which is what puts the mass under the star.
const NOTES = [
  [330, 452, 52, 190],
  [408, 510, 52, 190],
  [486, 568, 52, 230],
  [564, 510, 52, 190],
  [642, 452, 52, 190],
];

// The mark's visual bounds, derived rather than measured, so moving the geometry
// above keeps every lockup aligned.
const MARK_BOX = {
  x: ARC.cx - ARC.rx - ARC.hMax,
  y: STAR.cy - STAR.ry,
  w: 2 * (ARC.rx + ARC.hMax),
  h: ARC.cy + ARC.ry + ARC.hMax - (STAR.cy - STAR.ry),
};

function markPaths(fill) {
  const notes = NOTES.map(([x, y, w, h]) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}"/>`).join('');
  return `<g fill="${fill}">`
    + `<path d="${star(STAR)}"/>`
    + `<path d="${taperedArc(ARC)}"/>`
    + notes
    + '</g>';
}

/** Place the mark so that its visual box has the given height, at (x, y) top-left. */
function markAt(fill, x, y, height) {
  const s = height / MARK_BOX.h;
  const tx = x - MARK_BOX.x * s;
  const ty = y - MARK_BOX.y * s;
  return `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n2(s)})">${markPaths(fill)}</g>`;
}
const n2 = (v) => Math.round(v * 10000) / 10000;
const markWidth = (height) => (MARK_BOX.w / MARK_BOX.h) * height;

// --------------------------------------------------------------- wordmark ---

// SHELIAK as monoline strokes on a 99-unit cap height. Drawn rather than set,
// because the typeface is still undecided and a logo that changes shape with the
// viewer's installed fonts is not a logo.
const GLYPH_STROKE = 13;
const CAP = 99;

const GLYPHS = {
  S: { w: 66, d: 'M60 28C60 14 47 8 33 8C19 8 8 16 8 29C8 42 21 47 34 51C47 55 60 61 60 74C60 87 48 93 33 93C19 93 8 87 8 73' },
  H: { w: 65, d: 'M7 7V93M59 7V93M7 50H59' },
  E: { w: 63, d: 'M7 7V93M7 7H57M7 50H49M7 93H57' },
  L: { w: 61, d: 'M7 7V93M7 93H55' },
  I: { w: 13, d: 'M7 7V93' },
  A: { w: 65, d: 'M8 93L33 7L58 93M16 66H50' },
  K: { w: 64, d: 'M7 7V93M58 7L7 52M28 33.5L58 93' },
};
const TRACKING = 30;

function wordmark(color) {
  let x = 0;
  const parts = [];
  for (const ch of 'SHELIAK') {
    const g = GLYPHS[ch];
    parts.push(`<path transform="translate(${n(x)} 0)" d="${g.d}"/>`);
    x += g.w + TRACKING;
  }
  return {
    width: x - TRACKING,
    height: CAP,
    svg: `<g fill="none" stroke="${color}" stroke-width="${GLYPH_STROKE}"`
      + ` stroke-linecap="round" stroke-linejoin="round">`
      + parts.join('') + '</g>',
  };
}

/** The wordmark scaled to a cap height, placed with its cap-top-left at (x, y). */
function wordmarkAt(color, x, y, cap) {
  const w = wordmark(color);
  const s = cap / CAP;
  return {
    width: w.width * s,
    height: cap,
    svg: `<g transform="translate(${n(x)} ${n(y)}) scale(${n2(s)})">${w.svg}</g>`,
  };
}

// ----------------------------------------------------------------- pieces ---

// Single quotes inside: this string is interpolated into an XML attribute.
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const goldGradient = (id, y1, y2, deep) => deep
  ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="512" y1="${y1}" x2="512" y2="${y2}">`
    + `<stop offset="0" stop-color="${C.gold}"/><stop offset="1" stop-color="${C.goldDeep}"/></linearGradient>`
  : `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="512" y1="${y1}" x2="512" y2="${y2}">`
    + `<stop offset="0" stop-color="${C.goldHi}"/><stop offset=".46" stop-color="${C.goldMid}"/>`
    + `<stop offset="1" stop-color="${C.goldLow}"/></linearGradient>`;

const svgDoc = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"`
  + ` role="img" aria-label="${title}">\n${body}\n</svg>\n`;

// -------------------------------------------------------------- the icon ----

function icon(dark) {
  const g = dark
    ? goldGradient('gold', 196, 844, false)
    : goldGradient('gold', 196, 844, true);
  const veil = dark
    ? `<radialGradient id="veil" gradientUnits="userSpaceOnUse" cx="512" cy="400" r="500">`
      + `<stop offset="0" stop-color="${C.gold}" stop-opacity=".15"/>`
      + `<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>`
    : `<radialGradient id="veil" gradientUnits="userSpaceOnUse" cx="512" cy="400" r="500">`
      + `<stop offset="0" stop-color="${C.gold}" stop-opacity=".10"/>`
      + `<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>`;
  const bg = dark ? C.dark : C.light;
  const body = `<defs>${g}${veil}</defs>
<rect width="1024" height="1024" rx="224" fill="${bg}"/>
<rect width="1024" height="1024" rx="224" fill="url(#veil)"/>
<g transform="translate(-15.36 -16.2) scale(1.03)">${markPaths('url(#gold)')}</g>`;
  return svgDoc(1024, 1024, body, 'Sheliak');
}

// -------------------------------------------------------- mark / wordmark ---

function markOnly(dark) {
  const pad = 24;
  const w = MARK_BOX.w + pad * 2;
  const h = MARK_BOX.h + pad * 2;
  const body = `<defs>${goldGradient('gold', MARK_BOX.y, MARK_BOX.y + MARK_BOX.h, !dark)}</defs>
<g transform="translate(${n(pad - MARK_BOX.x)} ${n(pad - MARK_BOX.y)})">${markPaths('url(#gold)')}</g>`;
  return svgDoc(n(w), n(h), body, 'Sheliak');
}

function wordmarkOnly(dark) {
  const pad = 12;
  const w = wordmarkAt(dark ? C.paper : C.ink, pad, pad, CAP);
  return svgDoc(n(w.width + pad * 2), CAP + pad * 2, w.svg, 'Sheliak');
}

// ------------------------------------------------------------------ logo ----

const LOGO = { cap: 99, markH: 154, gap: 48, pad: 10 };

function logoParts(dark) {
  const markW = markWidth(LOGO.markH);
  const wm = wordmarkAt(dark ? C.paper : C.ink, LOGO.pad + markW + LOGO.gap, 0, LOGO.cap);
  return { markW, wm };
}

function logo(dark) {
  const { markW, wm } = logoParts(dark);
  const h = LOGO.markH + LOGO.pad * 2;
  const w = LOGO.pad * 2 + markW + LOGO.gap + wm.width;
  // The wordmark's cap box is centred on the arc, not on the mark's bounding
  // box: the star is airy and pulls the box up further than the eye does.
  const arcMid = ((ARC.cy - MARK_BOX.y) / MARK_BOX.h) * LOGO.markH + LOGO.pad;
  const capTop = arcMid - LOGO.cap / 2 - 6;
  const wm2 = wordmarkAt(dark ? C.paper : C.ink, LOGO.pad + markW + LOGO.gap, capTop, LOGO.cap);
  const body = `<defs>${goldGradient('gold', MARK_BOX.y, MARK_BOX.y + MARK_BOX.h, !dark)}</defs>
${markAt('url(#gold)', LOGO.pad, LOGO.pad, LOGO.markH)}
${wm2.svg}`;
  return svgDoc(n(w), n(h), body, 'Sheliak');
}

// ---------------------------------------------------------------- banner ----

const TAGLINE = 'songs that live in your repository.';

// A horizontal hairline that fades out at both ends. userSpaceOnUse is not
// optional here: the default objectBoundingBox units are degenerate on a shape
// with no height, and the line silently disappears.
const fadedRule = (id, x1, x2, peak) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">`
  + `<stop offset="0" stop-color="${C.gold}" stop-opacity="0"/>`
  + `<stop offset=".5" stop-color="${C.gold}" stop-opacity="${peak}"/>`
  + `<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></linearGradient>`;

function banner(dark) {
  const W = 1600;
  const H = 400;
  const markH = 156;
  const cap = 86;
  const markW = markWidth(markH);
  const totalW = markW + 50 + wordmarkAt('#000', 0, 0, cap).width;
  const x0 = (W - totalW) / 2;
  const markY = 76;
  const arcMid = markY + ((ARC.cy - MARK_BOX.y) / MARK_BOX.h) * markH;
  const wm = wordmarkAt(dark ? C.paper : C.ink, x0 + markW + 50, arcMid - cap / 2 - 6, cap);
  const bg = dark ? C.dark : C.light;
  const body = `<defs>
${goldGradient('gold', MARK_BOX.y, MARK_BOX.y + MARK_BOX.h, !dark)}
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="800" cy="140" r="600">
<stop offset="0" stop-color="${C.gold}" stop-opacity="${dark ? '.17' : '.13'}"/>
<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
${fadedRule('rule', 460, 1140, dark ? '.5' : '.4')}
</defs>
<rect width="${W}" height="${H}" fill="${bg}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
${markAt('url(#gold)', x0, markY, markH)}
${wm.svg}
<path d="M460 288H1140" stroke="url(#rule)" stroke-width="2"/>
<text x="${W / 2}" y="334" text-anchor="middle" font-family="${MONO}" font-size="25"
 letter-spacing="1.5" fill="${dark ? C.gold : C.goldDeep}">${TAGLINE}</text>`;
  return svgDoc(W, H, body, `Sheliak — ${TAGLINE}`);
}

// ---------------------------------------------------------------- social ----

// Real notation, not a plausible-looking imitation of it: every line below is
// syntax the parser in web/src/dsl actually accepts.
const SNIPPET = [
  ['```synth id=lead seed=42', 'key'],
  ['osc:', 'dim'],
  ['  - { table: basic/saw, level: -3dB, unison: 5 }', 'fg'],
  ['filter: { type: lp12, cutoff: 900Hz, res: 0.28 }', 'fg'],
  ['env:', 'dim'],
  ['  amp: { a: 8ms, d: 220ms, s: 65%, r: 180ms }', 'fg'],
  ['```', 'key'],
  ['', 'gap'],
  ['```phrase id=verse key=C scale=minor res=1/16', 'key'],
  ['grid:', 'dim'],
  ["  1'  |o-------........|", 'fg'],
  ['```', 'key'],
];

function social(dark) {
  const W = 1200;
  const H = 630;
  const bg = dark ? C.dark : C.light;
  const surface = dark ? C.darkSurface : '#FFFFFF';
  const line = dark ? C.darkLine : C.lightLine;
  const fg = dark ? '#D9D8D0' : '#2A2C28';
  const dim = dark ? C.muted : C.mutedLight;
  const key = dark ? C.gold : C.goldDeep;

  const markH = 92;
  const markW = markWidth(markH);
  const cap = 52;
  const markY = 48;
  const arcMid = markY + ((ARC.cy - MARK_BOX.y) / MARK_BOX.h) * markH;
  const wm = wordmarkAt(dark ? C.paper : C.ink, 72 + markW + 30, arcMid - cap / 2 - 4, cap);

  const CODE_TOP = 302;
  const LEADING = 24;
  const code = SNIPPET.map(([text, kind], i) => kind === 'gap'
    ? ''
    : `<text x="104" y="${CODE_TOP + i * LEADING}" font-family="${MONO}" font-size="19"`
      + ` fill="${kind === 'key' ? key : kind === 'dim' ? dim : fg}"`
      + ` xml:space="preserve">${esc(text)}</text>`).filter(Boolean).join('\n');
  const cardTop = 226;
  const cardBottom = CODE_TOP + (SNIPPET.length - 1) * LEADING + 28;

  const flow = ['Markdown', 'WebAssembly', 'sound'].map((label, i) =>
    `<text x="1006" y="${312 + i * 92}" text-anchor="middle" font-family="${MONO}" font-size="21"`
    + ` letter-spacing="1" fill="${i === 2 ? key : dim}">${label}</text>`
    + (i < 2
      ? `<path d="M1006 ${328 + i * 92}v42" stroke="${key}" stroke-width="2" stroke-opacity=".55"/>`
        + `<path d="M998 ${362 + i * 92}l8 8 8-8" fill="none" stroke="${key}" stroke-width="2"`
        + ` stroke-opacity=".55" stroke-linecap="round" stroke-linejoin="round"/>`
      : '')).join('\n');

  const body = `<defs>
${goldGradient('gold', MARK_BOX.y, MARK_BOX.y + MARK_BOX.h, !dark)}
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="1010" cy="150" r="560">
<stop offset="0" stop-color="${C.gold}" stop-opacity="${dark ? '.16' : '.12'}"/>
<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="${bg}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
${markAt('url(#gold)', 72, markY, markH)}
${wm.svg}
<text x="${n(72 + markW + 32)}" y="190" font-family="${MONO}" font-size="21" letter-spacing="1"
 fill="${key}">${TAGLINE}</text>
<rect x="72" y="${cardTop}" width="800" height="${cardBottom - cardTop}" rx="18" fill="${surface}" stroke="${line}"/>
<circle cx="100" cy="254" r="5" fill="${key}"/>
<text x="120" y="260" font-family="${MONO}" font-size="15" fill="${dim}">song.md</text>
${code}
${flow}`;
  return svgDoc(W, H, body, `Sheliak — ${TAGLINE}`);
}

// -------------------------------------------------------------- backdrop ----

function backdrop(dark) {
  const W = 1600;
  const H = 900;
  const bg = dark ? C.dark : C.light;
  const body = `<defs>
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="1160" cy="360" r="520">
<stop offset="0" stop-color="${C.gold}" stop-opacity="${dark ? '.14' : '.11'}"/>
<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="0" y1="120" x2="0" y2="760">
<stop offset="0" stop-color="${C.gold}" stop-opacity="0"/>
<stop offset=".45" stop-color="${C.gold}" stop-opacity="${dark ? '.18' : '.22'}"/>
<stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></linearGradient>
${fadedRule('rule', 240, 1360, dark ? '.7' : '.55')}
</defs>
<rect width="${W}" height="${H}" fill="${bg}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<g stroke="url(#fade)" stroke-width="3">
${Array.from({ length: 11 }, (_, i) => `<path d="M${700 + i * 84} 120V760"/>`).join('')}
</g>
<g fill="${dark ? C.gold : C.goldDeep}" opacity="${dark ? '.9' : '.8'}">
${[[784, 356, 92], [868, 300, 92], [952, 428, 92], [1120, 232, 148], [1288, 392, 92], [1372, 336, 92]].map(([x, y, h]) =>
    `<rect x="${x}" y="${y}" width="34" height="${h}" rx="17"/>`).join('')}
</g>
<path transform="translate(1140 118) scale(.42)" d="${star({ ...STAR, cx: 0, cy: 0 })}"
 fill="${dark ? C.gold : C.goldDeep}"/>
<path d="M240 786H1360" stroke="url(#rule)" stroke-width="3"/>
<path d="M420 812H1180" stroke="url(#rule)" stroke-width="2" opacity=".55"/>`;
  return svgDoc(W, H, body, 'Sheliak');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ----------------------------------------------------------------- output ---

const ASSETS = [
  ['sheliak-icon-dark.svg', icon(true)],
  ['sheliak-icon-light.svg', icon(false)],
  ['sheliak-mark-dark.svg', markOnly(true)],
  ['sheliak-mark-light.svg', markOnly(false)],
  ['sheliak-wordmark-dark.svg', wordmarkOnly(true)],
  ['sheliak-wordmark-light.svg', wordmarkOnly(false)],
  ['sheliak-logo-dark.svg', logo(true)],
  ['sheliak-logo-light.svg', logo(false)],
  ['sheliak-banner-dark.svg', banner(true)],
  ['sheliak-banner-light.svg', banner(false)],
  ['sheliak-social-dark.svg', social(true)],
  ['sheliak-social-light.svg', social(false)],
  ['sheliak-backdrop-dark.svg', backdrop(true)],
  ['sheliak-backdrop-light.svg', backdrop(false)],
];

mkdirSync(BRAND, { recursive: true });
for (const [name, content] of ASSETS) writeFileSync(join(BRAND, name), content);
// favicon.svg is the icon; mark.svg is the transparent mark the topbar shows.
writeFileSync(join(PUBLIC, 'favicon.svg'), icon(true));
writeFileSync(join(PUBLIC, 'mark.svg'), markOnly(true));
console.log(`wrote ${ASSETS.length} SVGs to assets/brand/, plus web/public/{favicon,mark}.svg`);

// ------------------------------------------------------------------- PNGs ---

function buildPngs() {
  const chrome = findChromium();
  if (!chrome) {
    console.error('--png needs Chrome or Chromium. Set CHROMIUM=/path/to/chrome and retry.');
    process.exit(1);
  }
  const raster = [
    ['sheliak-icon-dark.svg', join(PUBLIC, 'icon-512.png'), 512, 512],
    ['sheliak-icon-dark.svg', join(PUBLIC, 'icon-192.png'), 192, 192],
    ['sheliak-icon-dark.svg', join(PUBLIC, 'apple-touch-icon.png'), 180, 180],
    ['sheliak-social-dark.svg', join(PUBLIC, 'og.png'), 1200, 630],
  ];
  for (const [src, out, w, h] of raster) {
    shoot(chrome, join(BRAND, src), out, w, h);
    console.log(`wrote ${out.slice(ROOT.length + 1)} (${w}×${h})`);
  }
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

// Chromium will not open a window smaller than roughly 500x500, so the page is
// always 640 wide and the image is pinned to the top-left corner and cropped.
function shoot(chrome, svgPath, outPath, w, h) {
  const dir = join(tmpdir(), `sheliak-brand-${process.pid}-${w}x${h}`);
  mkdirSync(dir, { recursive: true });
  const page = join(dir, 'page.html');
  writeFileSync(page, `<!doctype html><meta charset="utf-8">`
    + `<style>*{margin:0;padding:0}html,body{background:transparent}`
    + `img{display:block;width:${w}px;height:${h}px}</style>`
    + `<img src="file://${svgPath}">`);
  const shot = join(dir, 'shot.png');
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    `--window-size=${Math.max(w, 640)},${Math.max(h, 640)}`,
    `--screenshot=${shot}`, `file://${page}`,
  ], { stdio: 'ignore' });
  cropPng(shot, outPath, w, h);
  rmSync(dir, { recursive: true, force: true });
}

// A minimal PNG reader/writer, so the build needs no image dependency.
function cropPng(inPath, outPath, cw, ch) {
  const data = readFileSync(inPath);
  let pos = 8;
  let idat = Buffer.alloc(0);
  let w = 0;
  let h = 0;
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) throw new Error('unexpected PNG format from Chromium');
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, body]);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(idat);
  const stride = w * 4;
  const rows = [];
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    unfilter(filter, line, prev, stride);
    rows.push(line);
    prev = line;
  }
  const outW = Math.min(cw, w);
  const outH = Math.min(ch, h);
  const body = Buffer.alloc(outH * (outW * 4 + 1));
  for (let y = 0; y < outH; y++) {
    body[y * (outW * 4 + 1)] = 0;
    rows[y].copy(body, y * (outW * 4 + 1) + 1, 0, outW * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outW, 0);
  ihdr.writeUInt32BE(outH, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(outPath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));

  function chunk(type, payload) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    const withType = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(withType) >>> 0, 0);
    return Buffer.concat([head, withType, crc]);
  }
}

function unfilter(filter, line, prev, stride) {
  if (filter === 0) return;
  for (let i = 0; i < stride; i++) {
    const a = i >= 4 ? line[i - 4] : 0;
    const b = prev[i];
    const c = i >= 4 ? prev[i - 4] : 0;
    let add = 0;
    if (filter === 1) add = a;
    else if (filter === 2) add = b;
    else if (filter === 3) add = (a + b) >> 1;
    else if (filter === 4) {
      const pp = a + b - c;
      const pa = Math.abs(pp - a);
      const pb = Math.abs(pp - b);
      const pc = Math.abs(pp - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else throw new Error(`unknown PNG filter ${filter}`);
    line[i] = (line[i] + add) & 0xff;
  }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

if (process.argv.includes('--png')) buildPngs();
