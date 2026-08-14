# Releasing

Four commands. Run them in order; the third one is the point of no return.

```bash
./scripts/release.sh 0.2.0                        # 1. prepare, and run the gate
git commit -am "Release v0.2.0" && git push origin main   # 2. publish the bump
# wait for CI to go green on that commit
git tag v0.2.0 && git push origin v0.2.0          # 3. cut it
```

That is the whole procedure. The rest of this page is why, for when something
goes wrong.

## What each step does

**1. `./scripts/release.sh <version>`** writes the version into the six places
`check-versions.sh` compares, closes `## [Unreleased]` in the changelog into
`## [x.y.z] - <today>` and opens a fresh empty one, then runs the full gate. It
refuses to start on a dirty tree, off `main`, or on a version already tagged, and
it changes nothing that is already correct — so a failed gate can be fixed and
the script run again.

It pushes nothing and tags nothing. Everything it does is a local edit you can
read in `git diff` before step 2.

**2. Push the bump.** An ordinary commit on `main`. CI runs; Pages rebuilds
`/next/` from it.

**3. Wait for CI, then tag.** Pushing the tag starts
[`release.yml`](../.github/workflows/release.yml), which builds the tarball,
extracts it somewhere unrelated to the repository, runs the CLI out of it, and
only then creates the GitHub release and attaches the archive and its checksum.
[`pages.yml`](../.github/workflows/pages.yml) then rebuilds the site's root from
the tag's own tree.

## Why the order matters

**Waiting for CI is not politeness.** The site's front page is built from the
newest tag. Tag before CI finishes and Pages starts a rebuild while the tag's
commit is still unverified — and if that CI run is what triggers it, the front
page comes from the release *before* last.

**The tag must be on the bump commit.** `sheliak --version` reads
`web/package.json`, which step 1 wrote. Tag a commit before the bump and the
released binary reports the previous version.

## Checks that will stop you

| Symptom | Cause |
|---|---|
| `the working tree has uncommitted changes` | Commit or stash first |
| `on branch 'x'; releases are cut from main` | `git checkout main` |
| `vX.Y.Z is already tagged` | Pick the next version |
| `FAIL  <file>  0.1.0 (expected 0.2.0)` | A version copy the script does not know about — add it to both `check-versions.sh` and `release.sh` |
| `no [Unreleased] section to close` | The previous release did not open one; add `## [Unreleased]` above the newest version heading |

## If it goes wrong

**Before the tag is pushed**, nothing has been published: `git reset` and start
again.

**After the tag is pushed**, do not delete and re-push it. A tag someone has
already fetched is not yours to change, the release archive is already
downloadable, and the site's front page is built from it. Cut the next patch
version instead — the whole procedure takes four commands.

## What a release contains

One tarball, `sheliak-<version>.tar.gz`, plus its `.sha256`. It works on every
platform because nothing in it is platform-specific: the CLI is a JavaScript
bundle, `dsp.wasm` is wasm, and the app is static files. Node.js 20 or newer is
the only requirement on the far end, and
[`scripts/install.sh`](../scripts/install.sh) checks for it before downloading
anything.

To check the packaging without cutting a release, dispatch the Release workflow
by hand: it builds and smoke-tests the tarball and uploads it as a run artifact,
and skips publishing entirely.
