//! Hosting a real CLAP plugin, checked against whatever is installed.
//!
//! These skip when there is no plugin to load, the way `render.test.ts` skips
//! when `dsp.wasm` has not been built. A CI runner has no plugins on it, and a
//! test that cannot run is better skipped loudly than deleted: the thing being
//! checked here is interoperability with somebody else's binary, which no
//! fixture of our own can stand in for.
//!
//! Point `SHELIAK_TEST_CLAP` at a `.clap` to use a specific one. Otherwise the
//! usual Linux location is searched; on this project's development container
//! that is `dragonfly-reverb-clap` and `lsp-plugins-clap`, both from apt.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use sheliak_render::clap_host::{describe, HostedPlugin, NoteEvent};

const SR: f32 = 48_000.0;

/// One plugin at a time, on purpose. Cargo runs these tests on concurrent
/// threads in one process, which is a sharing no real render has — the binary
/// hosts one plugin per process. The DPF plugins are not built for it either:
/// both instruments import libc's process-global `rand()`, and whatever global
/// state a plugin touches while processing is interleaved with every other
/// plugin running beside it. That was a measured flake, not a theory — Nekobi,
/// bit-identical across 12 isolated runs, rendered differently about once per
/// ten concurrent suite runs. The lock makes each measurement about the
/// plugin, not about the test scheduler.
fn one_plugin_at_a_time() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        // A poisoned lock only means another test failed; the plugin it was
        // measuring is gone with its thread, so this measurement is unaffected.
        .unwrap_or_else(PoisonError::into_inner)
}

/// A plugin to test with, or `None` to skip.
fn a_plugin() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SHELIAK_TEST_CLAP") {
        return Some(PathBuf::from(path));
    }
    let dir = std::fs::read_dir("/usr/lib/clap").ok()?;
    let mut found: Vec<PathBuf> = dir
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "clap"))
        .collect();
    // Sorted so a machine with several installed still tests the same one, and
    // a failure names a plugin somebody else can reproduce with.
    found.sort();
    found.into_iter().next()
}

macro_rules! plugin_or_skip {
    () => {
        match a_plugin() {
            Some(path) => path,
            None => {
                eprintln!("no CLAP plugin installed — skipping. Set SHELIAK_TEST_CLAP to one.");
                return;
            }
        }
    };
}

/// A short sine, so "the plugin changed something" is a claim about audio
/// rather than about silence.
fn a_signal(frames: usize) -> (Vec<f32>, Vec<f32>) {
    let tone: Vec<f32> = (0..frames)
        .map(|i| 0.25 * (std::f32::consts::TAU * 220.0 * i as f32 / SR).sin())
        .collect();
    (tone.clone(), tone)
}

#[test]
fn a_bundle_lists_what_it_carries() {
    let _one = one_plugin_at_a_time();
    let path = plugin_or_skip!();
    let found = describe(path.to_str().unwrap()).expect("the bundle should load");
    assert!(!found.is_empty(), "{path:?} declared no plugins");
    for plugin in &found {
        // A plugin with no id cannot be named by a document, which is what §7
        // will eventually have to write down.
        assert!(
            !plugin.id.is_empty(),
            "a plugin in {path:?} has no id (name: {})",
            plugin.name
        );
    }
}

/// An effect to test with. Instruments are refused on purpose (see below), so
/// the effect tests need one that takes audio in.
fn an_effect() -> Option<PathBuf> {
    let path = a_plugin()?;
    let described = describe(path.to_str().unwrap()).ok()?;
    described.iter().any(|p| !p.is_instrument()).then_some(path)
}

macro_rules! effect_or_skip {
    () => {
        match an_effect() {
            Some(path) => path,
            None => {
                eprintln!("no CLAP effect installed — skipping.");
                return;
            }
        }
    };
}

/// The instruments §13 names as the test subjects, whichever are installed.
/// `SHELIAK_TEST_CLAP_INSTRUMENT` overrides the list with one of your own.
fn instruments() -> Vec<PathBuf> {
    if let Ok(path) = std::env::var("SHELIAK_TEST_CLAP_INSTRUMENT") {
        return vec![PathBuf::from(path)];
    }
    ["/usr/lib/clap/Kars.clap", "/usr/lib/clap/Nekobi.clap"]
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect()
}

macro_rules! instruments_or_skip {
    () => {{
        let found = instruments();
        if found.is_empty() {
            eprintln!(
                "no CLAP instrument installed — skipping. apt-get install dpf-plugins-clap, \
                 or set SHELIAK_TEST_CLAP_INSTRUMENT."
            );
            return;
        }
        found
    }};
}

/// A phrase with an off-beat onset, so sample-accuracy is on trial: the first
/// note lands mid-block, and any host that quantizes events to block edges
/// makes sound 104 frames early.
fn a_phrase() -> Vec<NoteEvent> {
    vec![
        NoteEvent {
            frame: 1000,
            on: true,
            key: 57,
            velocity: 0.8,
        },
        NoteEvent {
            frame: 20_000,
            on: false,
            key: 57,
            velocity: 0.0,
        },
        NoteEvent {
            frame: 24_000,
            on: true,
            key: 60,
            velocity: 0.6,
        },
        NoteEvent {
            frame: 40_000,
            on: false,
            key: 60,
            velocity: 0.0,
        },
    ]
}

#[test]
fn an_instrument_on_the_mix_is_refused_rather_than_fed_audio_it_never_asked_for() {
    let _one = one_plugin_at_a_time();
    // An instrument declares zero audio inputs. Handing one an input port
    // anyway is a protocol violation, and DPF's Kars proves it is not a
    // harmless one: it trips an internal assertion and reports uninitialised
    // frame counts. Loading is fine now — it is the mix-effect path that has
    // to refuse, and point at the door that does work.
    for path in instruments_or_skip!() {
        let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR)
            .expect("an instrument should load and activate");
        let (mut l, mut r) = a_signal(4800);
        let error = match plugin.process(&mut l, &mut r) {
            Err(error) => error,
            Ok(()) => panic!("{} processed the mix without an audio input", plugin.name),
        };
        assert!(
            error.contains("instrument"),
            "the error should say what it is, got: {error}"
        );
        assert!(
            error.contains("--clap-instrument"),
            "the error should say what to do instead, got: {error}"
        );
    }
}

#[test]
fn an_instrument_declares_notes_in_and_no_audio_in() {
    let _one = one_plugin_at_a_time();
    // §13's reconnaissance, kept true by assertion: Kars and Nekobi declare
    // zero audio inputs, one audio output, one note input. The zero is what
    // the whole port-layout machinery exists for.
    for path in instruments_or_skip!() {
        let plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR)
            .expect("an instrument should load and activate");
        let ports = plugin.ports();
        assert_eq!(ports.audio_in, 0, "{} grew an audio input", plugin.name);
        assert!(ports.audio_out >= 1, "{} has no audio output", plugin.name);
        assert!(
            ports.note_in.unwrap_or(0) >= 1,
            "{} declares no note input",
            plugin.name
        );
    }
}

#[test]
fn an_instrument_is_silent_before_its_first_note_and_audible_after() {
    let _one = one_plugin_at_a_time();
    for path in instruments_or_skip!() {
        let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR)
            .expect("an instrument should load and activate");
        let mut l = vec![0.0f32; SR as usize];
        let mut r = vec![0.0f32; SR as usize];
        plugin
            .render_notes(&a_phrase(), &mut l, &mut r)
            .expect("rendering notes should succeed");

        assert!(
            l.iter().chain(r.iter()).all(|v| v.is_finite()),
            "{} produced a non-finite sample",
            plugin.name
        );
        // The first note-on is at frame 1000, mid-block on purpose: sound
        // before it means events are being quantized to block edges.
        let early = l[..1000].iter().chain(r[..1000].iter());
        assert!(
            early.clone().all(|v| v.abs() <= 1.0e-6),
            "{} made sound before its first note (peak {})",
            plugin.name,
            early.fold(0.0f32, |a, v| a.max(v.abs()))
        );
        let energy: f32 = l[1000..].iter().map(|v| v.abs()).sum();
        assert!(
            energy > 1.0e-2,
            "{} made no sound from its notes",
            plugin.name
        );
    }
}

/// Two renders of `a_phrase` through the instrument at `path`, from two fresh
/// instances, as `(left1, left2, right1, right2)`.
fn twice(path: &std::path::Path) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
    let run = || {
        let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
        let mut l = vec![0.0f32; SR as usize / 2];
        let mut r = vec![0.0f32; SR as usize / 2];
        plugin.render_notes(&a_phrase(), &mut l, &mut r).unwrap();
        (l, r)
    };
    let (l1, r1) = run();
    let (l2, r2) = run();
    (l1, l2, r1, r2)
}

#[test]
fn the_same_notes_twice_give_the_same_audio() {
    let _one = one_plugin_at_a_time();
    // The instrument version of the reproducibility measurement below: an
    // instrument carries more state than an effect — oscillators, envelopes,
    // filters — so it is the better test of whether a fresh instance really
    // starts from the same silence. Nekobi passes it bit for bit. Kars is
    // measured by the test after this one, because what it measures is the
    // opposite finding.
    let path = if let Ok(own) = std::env::var("SHELIAK_TEST_CLAP_INSTRUMENT") {
        PathBuf::from(own)
    } else {
        let path = PathBuf::from("/usr/lib/clap/Nekobi.clap");
        if !path.exists() {
            eprintln!("Nekobi not installed — skipping. apt-get install dpf-plugins-clap");
            return;
        }
        path
    };
    let (l1, l2, r1, r2) = twice(&path);
    assert_eq!(l1, l2, "two runs of {path:?} disagreed on the left channel");
    assert_eq!(
        r1, r2,
        "two runs of {path:?} disagreed on the right channel"
    );
}

#[test]
fn kars_draws_its_excitation_from_an_unseeded_rng_and_two_renders_differ() {
    let _one = one_plugin_at_a_time();
    // The other finding, kept as a finding. Kars fills each note's excitation
    // wavetable from `rand()` with no seed (DistrhoPluginKars.cpp:
    // `note.wavetable[i] = (float(rand()) / float(RAND_MAX)) * 2.0f - 1.0f`),
    // so two instances disagree from the first frame of the first note — the
    // note-on itself lands sample-accurately, and everything after it is
    // different noise. No host can reach that; it is exactly the plugin
    // behavior §4's `pinned` class can pin but never fix, and §13's "same
    // bytes twice" criterion is unmeetable for this plugin by upstream design.
    // Asserted, so the measurement stays written down: an upstream Kars that
    // starts seeding its noise makes this fail, and that would be news.
    let path = std::path::Path::new("/usr/lib/clap/Kars.clap");
    if !path.exists() {
        eprintln!("Kars not installed — skipping. apt-get install dpf-plugins-clap");
        return;
    }
    let (l1, l2, _, _) = twice(path);
    assert_eq!(
        &l1[..1000],
        &l2[..1000],
        "before the first note there is nothing random yet"
    );
    assert_ne!(
        l1, l2,
        "Kars rendered the same bytes twice — its excitation noise appears \
         to be seeded now, which changes what a lockfile can promise for it"
    );
}

#[test]
fn a_plugin_loads_activates_and_processes() {
    let _one = one_plugin_at_a_time();
    let path = effect_or_skip!();
    let mut plugin =
        HostedPlugin::load(path.to_str().unwrap(), None, SR).expect("the plugin should activate");
    assert!(!plugin.id.is_empty());

    let (mut l, mut r) = a_signal(SR as usize / 2);
    let dry = l.clone();
    plugin
        .process(&mut l, &mut r)
        .expect("processing should succeed");

    assert_eq!(l.len(), dry.len(), "the plugin must not change the length");
    assert!(
        l.iter().chain(r.iter()).all(|v| v.is_finite()),
        "{} produced a non-finite sample",
        plugin.name
    );
    // Not asserting that it changed the signal: a plugin at its defaults is
    // entitled to be transparent, and a limiter given a quiet input is. What
    // must hold is that audio came back at all, finite and the right length.
}

#[test]
fn the_same_plugin_twice_gives_the_same_audio() {
    let _one = one_plugin_at_a_time();
    let path = effect_or_skip!();
    let run = || {
        let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
        let (mut l, mut r) = a_signal(SR as usize / 4);
        plugin.process(&mut l, &mut r).unwrap();
        (l, r)
    };
    let (l1, r1) = run();
    let (l2, r2) = run();

    // This is a measurement, not a guarantee the format offers: a plugin may
    // read a clock or use an unseeded RNG, and nothing here could stop it.
    // Finding out that a given plugin *is* reproducible is exactly what §4's
    // `pinned` class needs, and finding out that one is not is worth a failure
    // that names it.
    assert_eq!(l1, l2, "two runs of {path:?} disagreed on the left channel");
    assert_eq!(
        r1, r2,
        "two runs of {path:?} disagreed on the right channel"
    );
}

#[test]
fn asking_for_a_plugin_that_is_not_there_fails_by_name() {
    let _one = one_plugin_at_a_time();
    let path = effect_or_skip!();
    // `expect_err` would need HostedPlugin: Debug, and a loaded plugin is not a
    // thing worth teaching to print itself.
    let error = match HostedPlugin::load(path.to_str().unwrap(), Some("com.example.nope"), SR) {
        Err(error) => error,
        Ok(plugin) => panic!("an unknown id loaded {} instead of failing", plugin.name),
    };
    assert!(
        error.contains("com.example.nope"),
        "the error should name what was asked for, got: {error}"
    );
}

// ------------------------------------------------- the document's own plugins

/// A document names a plugin, not a file, so the renderer has to find it.
#[test]
fn a_plugin_is_found_by_the_id_a_document_would_write() {
    let path = std::path::Path::new("/usr/lib/clap/Kars.clap");
    if !path.exists() {
        eprintln!("Kars not installed — skipping. apt-get install dpf-plugins-clap");
        return;
    }
    let found = sheliak_render::clap_host::find_by_id("studio.kx.distrho.Kars")
        .expect("an installed plugin should be findable by its id");
    // Not asserting the path: which file carries an id is a property of the
    // machine. What must hold is that the file found really carries it.
    let carried = describe(found.to_str().unwrap()).unwrap();
    assert!(carried.iter().any(|p| p.id == "studio.kx.distrho.Kars"));
}

#[test]
fn an_id_nobody_has_installed_says_where_it_looked() {
    let error = sheliak_render::clap_host::find_by_id("com.example.definitely-not-installed")
        .expect_err("an absent plugin must not resolve to something else");
    assert!(error.contains("com.example.definitely-not-installed"));
    // A song that will not render because a plugin is missing is a song whose
    // reader needs to know where to put one.
    assert!(error.contains("Looked in"), "got: {error}");
}

#[test]
fn the_search_path_puts_the_environment_first() {
    // CLAP_PATH is the format's own variable, and a machine that sets it means
    // it — a system directory must not shadow what the user asked for.
    let dirs = sheliak_render::clap_host::search_path();
    assert!(dirs.iter().any(|d| d.ends_with("clap")));
}

// ------------------------------------------------------ parameters, resolved

/// Kars specifically: its parameters are known and small, and one of them
/// (`volume`, 0..100) is linear enough that "did the setting arrive" is a
/// question about the audio rather than about the API returning Ok.
fn kars() -> Option<PathBuf> {
    let path = PathBuf::from("/usr/lib/clap/Kars.clap");
    path.exists().then_some(path)
}

macro_rules! kars_or_skip {
    () => {
        match kars() {
            Some(path) => path,
            None => {
                eprintln!("Kars not installed — skipping. apt-get install dpf-plugins-clap");
                return;
            }
        }
    };
}

fn render_kars(settings: &[(&str, bool, f64)]) -> Vec<f32> {
    let path = kars().unwrap();
    let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
    let settings: Vec<_> = settings
        .iter()
        .map(
            |(name, normalized, value)| sheliak_render::clap_host::ParamSetting {
                name: (*name).to_string(),
                normalized: *normalized,
                value: *value,
            },
        )
        .collect();
    plugin.set_params(&settings).unwrap();
    let frames = SR as usize / 2;
    let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
    plugin.render_notes(&a_phrase(), &mut l, &mut r).unwrap();
    l
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

#[test]
fn a_plugin_reports_the_parameters_a_document_can_name() {
    let _one = one_plugin_at_a_time();
    let path = kars_or_skip!();
    let plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
    let names: Vec<String> = plugin
        .parameters()
        .iter()
        .map(|p| p.name.to_lowercase())
        .collect();
    assert!(names.contains(&"volume".to_string()), "got {names:?}");
    // A range is what makes a percentage mean anything.
    let volume = plugin
        .parameters()
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case("volume"))
        .unwrap();
    assert!(
        volume.max > volume.min,
        "volume has no range to be a fraction of"
    );
}

#[test]
fn a_setting_reaches_the_plugin_and_changes_the_sound() {
    let _one = one_plugin_at_a_time();
    let _path = kars_or_skip!();
    // Louder is louder. Anything weaker than this passes when the events are
    // built correctly and quietly dropped on the floor.
    let quiet = rms(&render_kars(&[("volume", false, 25.0)]));
    let loud = rms(&render_kars(&[("volume", false, 100.0)]));
    assert!(quiet > 0.0, "the instrument made no sound at all");
    assert!(
        loud > quiet * 2.0,
        "volume 100 ({loud}) should be well above volume 25 ({quiet})"
    );
}

#[test]
fn a_percentage_and_the_plugins_own_number_mean_the_same_thing() {
    let _one = one_plugin_at_a_time();
    // Nekobi, not Kars: this compares two renders sample for sample, and Kars
    // cannot be compared to itself — its excitation comes from an unseeded
    // `rand()` upstream. Nekobi is bit-identical across runs, so a difference
    // here is the conversion and nothing else.
    //
    // `tuning` spans -12..12, which is the case worth testing: a range that
    // does not start at zero is where `min + v * (max - min)` earns its keep.
    // 50% is the middle of -12..12, which is 0 — the same as writing `0`.
    let path = PathBuf::from("/usr/lib/clap/Nekobi.clap");
    if !path.exists() {
        eprintln!("Nekobi not installed — skipping. apt-get install dpf-plugins-clap");
        return;
    }
    let render = |normalized: bool, value: f64| {
        let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
        plugin
            .set_params(&[sheliak_render::clap_host::ParamSetting {
                name: "tuning".into(),
                normalized,
                value,
            }])
            .unwrap();
        let frames = SR as usize / 4;
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        plugin.render_notes(&a_phrase(), &mut l, &mut r).unwrap();
        l
    };
    let by_percent = render(true, 0.5);
    let by_value = render(false, 0.0);
    assert_eq!(
        by_percent, by_value,
        "50% of -12..12 should be the same as writing 0"
    );

    // And the two spellings must not collapse into each other: a real change
    // still has to be audible, or the test above would pass on a host that
    // ignored settings entirely.
    assert_ne!(
        by_percent,
        render(false, 12.0),
        "tuning 0 and tuning 12 should not sound the same"
    );
}

#[test]
fn a_parameter_the_plugin_does_not_have_is_named_along_with_the_ones_it_does() {
    let _one = one_plugin_at_a_time();
    let path = kars_or_skip!();
    let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
    let error = plugin
        .set_params(&[sheliak_render::clap_host::ParamSetting {
            name: "brightness".into(),
            normalized: true,
            value: 0.6,
        }])
        .expect_err("an unknown parameter must not be silently ignored");
    assert!(error.contains("brightness"), "got: {error}");
    // Naming what it *does* have is the difference between a wall and a fix.
    assert!(error.contains("volume"), "got: {error}");
}

#[test]
fn a_value_outside_the_range_is_refused_rather_than_clamped() {
    let _one = one_plugin_at_a_time();
    let path = kars_or_skip!();
    let mut plugin = HostedPlugin::load(path.to_str().unwrap(), None, SR).unwrap();
    // Clamping would be the quieter answer and the worse one: a value this far
    // out is almost always the wrong unit, and the document should be fixed.
    let error = plugin
        .set_params(&[sheliak_render::clap_host::ParamSetting {
            name: "volume".into(),
            normalized: false,
            value: 5000.0,
        }])
        .expect_err("an out-of-range value must not be quietly clamped");
    assert!(error.contains("outside its range"), "got: {error}");
}
