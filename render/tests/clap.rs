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

use sheliak_render::clap_host::{describe, HostedPlugin};

const SR: f32 = 48_000.0;

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
    let path = plugin_or_skip!();
    let found = describe(path.to_str().unwrap()).expect("the bundle should load");
    assert!(!found.is_empty(), "{path:?} declared no plugins");
    for (id, name) in &found {
        // A plugin with no id cannot be named by a document, which is what §7
        // will eventually have to write down.
        assert!(
            !id.is_empty(),
            "a plugin in {path:?} has no id (name: {name})"
        );
    }
}

#[test]
fn a_plugin_loads_activates_and_processes() {
    let path = plugin_or_skip!();
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
    let path = plugin_or_skip!();
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
    let path = plugin_or_skip!();
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
