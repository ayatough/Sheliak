# Sheliak brand assets

Everything in this directory is **generated**. The source is
[`scripts/build-brand.mjs`](../../scripts/build-brand.mjs); the SVGs here and the
icons in `web/public/` are its output.

```bash
node scripts/build-brand.mjs          # the SVGs
node scripts/build-brand.mjs --png    # the SVGs, plus the PNGs the web app serves
```

Do not hand-edit the SVGs. The mark is embedded in eight of them, and the last
time these files were maintained by hand the gradient definitions were dropped
from six of them, which silently deleted parts of the artwork. Edit the script,
re-run it, and commit the result. CI re-runs the script and fails if the
committed SVGs differ.

The `--png` step needs Chrome or Chromium; it looks in the usual places and
honours `CHROMIUM=/path/to/chrome`. It is only needed when the artwork changes,
because the PNGs are committed.

## The mark

Three ideas, no literal music-note clichés:

1. **The lyre** — the open arc. It is an ellipse with a gap at the top, and its
   stroke tapers towards both ends; a constant-width arc reads as a loading
   spinner, which is why the path is computed rather than stroked.
2. **The song** — five strings with one lit segment each. The segments are the
   same length and step down in pairs: an arpeggio, not a bar chart. The centre
   note is held longer, which puts the mass under the star.
3. **The star** — β Lyrae, cradled in the opening of the arc. Sheliak is a star
   as well as an instrument, and the four-ray form keeps the family resemblance
   with the other star-named projects.

The mark survives down to about 24 px. Below that use it anyway — the silhouette
still reads — but do not add detail to compensate.

**Clear space:** keep a margin of one star-height (about 15% of the mark's
height) on every side. The icon files already include it.

## Palette

| | Hex | Use |
|---|---|---|
| Gold | `#E5A900` | the brand colour, on dark. 9.2:1 on `#0A0C0B` |
| Gold highlight | `#FFD45A` | top of the gradient on dark |
| Gold deep | `#B07E00` | the gold **on light**. 3.4:1 on `#FAF8F1`, where plain gold is 1.9:1 |
| Dark | `#0A0C0B` | dark background |
| Dark surface | `#111411` | panels on dark |
| Light | `#FAF8F1` | light background |
| Ink | `#171916` | type on light |
| Paper | `#F4F2EA` | type on dark |

Never put `#E5A900` on the cream: it fails even the 3:1 threshold for graphical
objects. That is what `#B07E00` and the `*-light.svg` variants are for.

**The web app uses this palette too.** The `:root` block in `web/src/style.css` is
the only place in the interface where a colour is written; everything else refers
to those tokens, and the oscilloscope canvas reads them back out with
`getComputedStyle` rather than repeating the values. Two interface tokens have no
brand equivalent and are chosen against it:

| Token | Value | Why |
|---|---|---|
| `--warn` | `#E8912F` | amber, not a paler gold. The status dot switches between `--accent` and `--warn`, so they have to differ in hue and not only in lightness |
| `--err` | `#F4675C` | warm red, tuned to sit beside the gold rather than the old cool palette |

The app is dark-only. The `*-light.svg` variants exist for documents and slides,
not for a light theme that does not exist yet.

## Typography

**Undecided, and nothing here depends on it.** The wordmark is drawn as monoline
paths on a 99-unit cap height, so every asset renders identically on a machine
with no fonts installed — including inside GitHub's image sandbox, which is where
a `font-family` in an SVG usually falls apart.

Only the small supporting copy on the banner and the social card is live text,
set in a monospace stack where a substitution is cosmetic. When a typeface is
chosen, replace `GLYPHS` in the build script with the outlines of the real
letterforms and re-run it; the lockups will re-space themselves.

## Files

| File | Size | What it is |
|---|---|---|
| `sheliak-icon-{dark,light}.svg` | 1024² | app icon: the mark on a rounded square |
| `sheliak-mark-{dark,light}.svg` | — | the mark alone, transparent |
| `sheliak-wordmark-{dark,light}.svg` | — | SHELIAK alone, transparent |
| `sheliak-logo-{dark,light}.svg` | — | mark + wordmark, transparent |
| `sheliak-banner-{dark,light}.svg` | 1600×400 | the README header |
| `sheliak-social-{dark,light}.svg` | 1200×630 | Open Graph / social card |
| `sheliak-backdrop-{dark,light}.svg` | 1600×900 | decorative background for slides |

The `-dark` variants are for dark backgrounds and the `-light` variants for light
ones. In Markdown, offer both:

```markdown
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/sheliak-banner-dark.svg">
  <img alt="Sheliak" src="assets/brand/sheliak-banner-light.svg">
</picture>
```

The logo, mark and wordmark files are transparent, so they sit on any surface.
The icon, banner, social and backdrop files carry their own background.

Generated PNGs live in `web/public/` rather than here, because they exist to be
served: `favicon.svg`, `apple-touch-icon.png` (180²), `icon-192.png`,
`icon-512.png` and `og.png` (1200×630, the dark social card).

## Licence

The artwork is part of Sheliak and is covered by the repository's
[MIT licence](../../LICENSE). The name and the mark identify the project — please
do not use them as the identity of a fork or of an unrelated product.
