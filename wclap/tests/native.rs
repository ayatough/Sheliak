//! Drives the plugin through the CLAP ABI, natively, where a panic still has
//! a backtrace.
//!
//! The browser host is checked in `web/src/audio/wclap.test.ts` against the
//! built module; this checks the other half — that the shell around the effect
//! is faithful. The test that matters is [`the_plugin_path_does_not_change_the
//! _sound`]: the same effect, the same parameters, the same input, reached two
//! ways, and the samples have to match bit for bit. If they ever stop
//! matching, running an effect as a plugin has become a different thing from
//! running it in the chain, and every claim about determinism gets weaker.

use std::ffi::{c_void, CStr};

use clap_sys::events::{
    clap_event_header, clap_event_note, clap_event_param_value, clap_input_events,
    clap_output_events, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_NOTE_OFF, CLAP_EVENT_NOTE_ON,
    CLAP_EVENT_PARAM_VALUE,
};
use clap_sys::ext::audio_ports::clap_plugin_audio_ports;
use clap_sys::ext::note_ports::{
    clap_note_port_info, clap_plugin_note_ports, CLAP_NOTE_DIALECT_CLAP,
};
use clap_sys::ext::params::{clap_param_info, clap_plugin_params, CLAP_PARAM_IS_STEPPED};
use clap_sys::factory::plugin_factory::clap_plugin_factory;
use clap_sys::host::clap_host;
use clap_sys::plugin::clap_plugin;
use clap_sys::process::clap_process;
use clap_sys::version::CLAP_VERSION;

use sheliak_dsp::fx::dist::Dist;
use sheliak_dsp::fx::Effect;
use sheliak_dsp::params::{
    DIST_DRIVE, DIST_MIX, DIST_MODE, DIST_TONE_HZ, ENV_A, ENV_AMP_BASE, ENV_D, ENV_FILTER_BASE,
    ENV_R, ENV_S, FX_SLOT_STRIDE, OSC_A_BASE, OSC_DETUNE_CENTS, OSC_ENABLED, OSC_LEVEL, OSC_MORPH,
    OSC_TABLE_ID, OSC_UNISON, PARAM_COUNT, P_FILTER_CUTOFF_HZ, P_FILTER_MODE, P_FILTER_RES,
    P_GLIDE_S, P_MASTER_GAIN, P_POLYPHONY,
};
use sheliak_dsp::tables;
use sheliak_dsp::Track;
use sheliak_wclap::clap_entry;

const SR: f32 = 48_000.0;
const N: usize = 128;
const PLUGIN_ID: &CStr = c"io.github.ayatough.sheliak.dist";
const SYNTH_ID: &CStr = c"io.github.ayatough.sheliak.synth";

// -------------------------------------------------------------- a tiny host

unsafe extern "C" fn host_get_extension(_: *const clap_host, _: *const i8) -> *const c_void {
    std::ptr::null()
}
unsafe extern "C" fn host_nop(_: *const clap_host) {}

struct Host(clap_host);
// SAFETY: the fields are `'static` string pointers and function pointers; the
// test is single-threaded.
unsafe impl Sync for Host {}

static HOST: Host = Host(clap_host {
    clap_version: CLAP_VERSION,
    host_data: std::ptr::null_mut(),
    name: c"Sheliak (test)".as_ptr(),
    vendor: c"Sheliak".as_ptr(),
    url: c"https://github.com/ayatough/Sheliak".as_ptr(),
    version: c"0.1.0".as_ptr(),
    get_extension: Some(host_get_extension),
    request_restart: Some(host_nop),
    request_process: Some(host_nop),
    request_callback: Some(host_nop),
});

/// What a block can carry, in the order the host writes it.
#[derive(Copy, Clone)]
enum Ev {
    /// Parameter id, value, frame.
    Param(u32, f64, u32),
    /// Key, velocity, frame.
    On(i16, f64, u32),
    /// Key, frame.
    Off(i16, u32),
}

/// One event, in whichever struct its type calls for. Both start with the
/// header, which is what makes a `*const clap_event_header` enough for a host
/// to hand over and a plugin to dispatch on.
enum Stored {
    Param(clap_event_param_value),
    Note(clap_event_note),
}

impl Stored {
    fn header(&self) -> *const clap_event_header {
        match self {
            Stored::Param(event) => &event.header,
            Stored::Note(event) => &event.header,
        }
    }
}

/// A `clap_input_events` backed by a plain `Vec`.
struct Events {
    list: clap_input_events,
    events: Vec<Stored>,
}

unsafe extern "C" fn events_size(list: *const clap_input_events) -> u32 {
    (*((*list).ctx as *const Vec<Stored>)).len() as u32
}

unsafe extern "C" fn events_get(
    list: *const clap_input_events,
    index: u32,
) -> *const clap_event_header {
    let events = &*((*list).ctx as *const Vec<Stored>);
    match events.get(index as usize) {
        Some(event) => event.header(),
        None => std::ptr::null(),
    }
}

unsafe extern "C" fn out_try_push(
    _: *const clap_output_events,
    _: *const clap_event_header,
) -> bool {
    true
}

impl Events {
    /// CLAP requires these in ascending frame order; so does the plugin.
    fn new(changes: &[Ev]) -> Box<Self> {
        fn header(size: usize, time: u32, type_: u16) -> clap_event_header {
            clap_event_header {
                size: size as u32,
                time,
                space_id: CLAP_CORE_EVENT_SPACE_ID,
                type_,
                flags: 0,
            }
        }
        let note = |time, type_, key, velocity| {
            Stored::Note(clap_event_note {
                header: header(std::mem::size_of::<clap_event_note>(), time, type_),
                note_id: -1,
                port_index: 0,
                channel: 0,
                key,
                velocity,
            })
        };
        let events = changes
            .iter()
            .map(|&change| match change {
                Ev::Param(id, value, time) => Stored::Param(clap_event_param_value {
                    header: header(
                        std::mem::size_of::<clap_event_param_value>(),
                        time,
                        CLAP_EVENT_PARAM_VALUE,
                    ),
                    param_id: id,
                    cookie: std::ptr::null_mut(),
                    note_id: -1,
                    port_index: -1,
                    channel: -1,
                    key: -1,
                    value,
                }),
                Ev::On(key, velocity, time) => note(time, CLAP_EVENT_NOTE_ON, key, velocity),
                Ev::Off(key, time) => note(time, CLAP_EVENT_NOTE_OFF, key, 0.0),
            })
            .collect();
        let mut boxed = Box::new(Events {
            list: clap_input_events {
                ctx: std::ptr::null_mut(),
                size: Some(events_size),
                get: Some(events_get),
            },
            events,
        });
        boxed.list.ctx = &boxed.events as *const Vec<Stored> as *mut c_void;
        boxed
    }
}

/// Creates and initialises a plugin, or fails the test saying which step.
unsafe fn open_id(id: &CStr) -> *const clap_plugin {
    let get_factory = clap_entry
        .get_factory
        .expect("clap_entry has no get_factory");
    let factory = get_factory(c"clap.plugin-factory".as_ptr()) as *const clap_plugin_factory;
    assert!(!factory.is_null(), "no clap.plugin-factory");
    let create = (*factory)
        .create_plugin
        .expect("factory has no create_plugin");
    let plugin = create(factory, &HOST.0, id.as_ptr());
    assert!(!plugin.is_null(), "the factory refused its own plugin id");
    assert!((*plugin).init.unwrap()(plugin), "plugin.init said no");
    plugin
}

/// The distortion, which is what most of these tests are about.
unsafe fn open() -> *const clap_plugin {
    open_id(PLUGIN_ID)
}

/// Runs one block through the plugin, in place.
unsafe fn render(
    plugin: *const clap_plugin,
    left: &mut [f32; N],
    right: &mut [f32; N],
    events: &Events,
    frames: u32,
) {
    render_ports(plugin, left, right, events, frames, 1)
}

/// The same, with `inputs` audio input ports — zero for an instrument, which
/// has none and must not be handed one.
unsafe fn render_ports(
    plugin: *const clap_plugin,
    left: &mut [f32; N],
    right: &mut [f32; N],
    events: &Events,
    frames: u32,
    inputs: u32,
) {
    let mut channels = [left.as_mut_ptr(), right.as_mut_ptr()];
    let mut buffer = clap_sys::audio_buffer::clap_audio_buffer {
        data32: channels.as_mut_ptr(),
        data64: std::ptr::null_mut(),
        channel_count: 2,
        latency: 0,
        constant_mask: 0,
    };
    let out_events = clap_output_events {
        ctx: std::ptr::null_mut(),
        try_push: Some(out_try_push),
    };
    // In-place: the same buffer as input and output, which is what
    // `in_place_pair` advertises and what a chain would actually do.
    let process = clap_process {
        steady_time: -1,
        frames_count: frames,
        transport: std::ptr::null(),
        audio_inputs: if inputs > 0 {
            &buffer
        } else {
            std::ptr::null()
        },
        audio_outputs: &mut buffer,
        audio_inputs_count: inputs,
        audio_outputs_count: 1,
        in_events: &events.list,
        out_events: &out_events,
    };
    (*plugin).process.unwrap()(plugin, &process);
}

/// One cycle of a sine, the same one both paths are given.
fn sine(amplitude: f32) -> [f32; N] {
    let mut out = [0.0; N];
    for (i, s) in out.iter_mut().enumerate() {
        *s = amplitude * (std::f32::consts::TAU * i as f32 / N as f32).sin();
    }
    out
}

// ------------------------------------------------------------------- tests

#[test]
fn the_entry_point_is_the_one_a_host_looks_for() {
    assert!(clap_entry.clap_version.major >= 1);
    unsafe {
        let get_factory = clap_entry.get_factory.unwrap();
        assert!(!get_factory(c"clap.plugin-factory".as_ptr()).is_null());
        // An unknown factory is a null, not a crash: hosts ask for factories
        // that most plugins do not have.
        assert!(get_factory(c"clap.preset-discovery-factory/2".as_ptr()).is_null());
    }
}

#[test]
fn the_factory_lists_what_it_can_make_and_refuses_the_rest() {
    unsafe {
        let get_factory = clap_entry.get_factory.unwrap();
        let factory = get_factory(c"clap.plugin-factory".as_ptr()) as *const clap_plugin_factory;
        assert_eq!((*factory).get_plugin_count.unwrap()(factory), 2);

        let desc = (*factory).get_plugin_descriptor.unwrap()(factory, 0);
        assert_eq!(CStr::from_ptr((*desc).id), PLUGIN_ID);
        assert_eq!(CStr::from_ptr((*desc).name), c"Sheliak Distortion");

        let synth = (*factory).get_plugin_descriptor.unwrap()(factory, 1);
        assert_eq!(CStr::from_ptr((*synth).id), SYNTH_ID);
        assert_eq!(CStr::from_ptr((*synth).name), c"Sheliak Synth");
        assert!((*factory).get_plugin_descriptor.unwrap()(factory, 2).is_null());

        let create = (*factory).create_plugin.unwrap();
        assert!(create(factory, &HOST.0, c"com.example.nope".as_ptr()).is_null());
    }
}

#[test]
fn the_parameters_carry_their_own_ranges_and_names() {
    unsafe {
        let plugin = open();
        let params = (*plugin).get_extension.unwrap()(plugin, c"clap.params".as_ptr())
            as *const clap_plugin_params;
        assert!(!params.is_null(), "no clap.params extension");
        assert_eq!((*params).count.unwrap()(plugin), 4);

        let mut info = std::mem::zeroed::<clap_param_info>();
        assert!((*params).get_info.unwrap()(plugin, 2, &mut info));
        assert_eq!(CStr::from_ptr(info.name.as_ptr()), c"Mode");
        assert_eq!((info.min_value, info.max_value), (0.0, 2.0));
        assert!(info.flags & CLAP_PARAM_IS_STEPPED != 0);

        // The plugin's own spelling of a value is the only label a host that
        // knows nothing about this parameter can show.
        let mut text = [0i8; 64];
        assert!((*params).value_to_text.unwrap()(
            plugin,
            2,
            1.0,
            text.as_mut_ptr(),
            64
        ));
        assert_eq!(CStr::from_ptr(text.as_ptr()), c"Fold");

        let mut value = 0.0;
        assert!((*params).text_to_value.unwrap()(
            plugin,
            2,
            c"clip".as_ptr(),
            &mut value
        ));
        assert_eq!(value, 2.0);

        (*plugin).destroy.unwrap()(plugin);
    }
}

#[test]
fn the_plugin_path_does_not_change_the_sound() {
    const DRIVE: f32 = 0.7;
    let input = sine(0.5);

    // Through the plugin: two parameter changes at frame 0, then one block.
    let mut plugin_l = input;
    let mut plugin_r = input;
    unsafe {
        let plugin = open();
        assert!((*plugin).activate.unwrap()(plugin, SR as f64, 1, N as u32));
        assert!((*plugin).start_processing.unwrap()(plugin));
        let events = Events::new(&[Ev::Param(0, DRIVE as f64, 0), Ev::Param(1, 1.0, 0)]);
        render(plugin, &mut plugin_l, &mut plugin_r, &events, N as u32);
        (*plugin).stop_processing.unwrap()(plugin);
        (*plugin).deactivate.unwrap()(plugin);
        (*plugin).destroy.unwrap()(plugin);
    }

    // Through the effect directly, the way the chain runs it.
    let mut direct_l = input;
    let mut direct_r = input;
    let mut block = [0.0f32; FX_SLOT_STRIDE];
    block[DIST_DRIVE] = DRIVE;
    block[DIST_MIX] = 1.0;
    block[DIST_MODE] = 0.0;
    block[DIST_TONE_HZ] = 20_000.0;
    let mut dist = Dist::new(SR);
    dist.apply_patch(&block, SR, true);
    dist.run(&mut direct_l, &mut direct_r, SR);

    assert_eq!(direct_l, plugin_l, "left channel");
    assert_eq!(direct_r, plugin_r, "right channel");
    // And it did something: a test that compared two silences would pass.
    assert!(direct_l.iter().zip(input.iter()).any(|(a, b)| a != b));
}

#[test]
fn a_mix_of_zero_is_a_bypass_bit_for_bit() {
    let input = sine(0.5);
    let mut left = input;
    let mut right = input;
    unsafe {
        let plugin = open();
        assert!((*plugin).activate.unwrap()(plugin, SR as f64, 1, N as u32));
        let events = Events::new(&[Ev::Param(1, 0.0, 0)]);
        render(plugin, &mut left, &mut right, &events, N as u32);
        (*plugin).destroy.unwrap()(plugin);
    }
    assert_eq!(left, input);
    assert_eq!(right, input);
}

#[test]
fn a_block_with_no_events_and_no_frames_is_harmless() {
    let mut left = [0.0f32; N];
    let mut right = [0.0f32; N];
    unsafe {
        let plugin = open();
        assert!((*plugin).activate.unwrap()(plugin, SR as f64, 1, N as u32));
        let events = Events::new(&[]);
        render(plugin, &mut left, &mut right, &events, 0);
        (*plugin).reset.unwrap()(plugin);
        (*plugin).destroy.unwrap()(plugin);
    }
    assert!(left.iter().all(|s| *s == 0.0));
}

// ------------------------------------------------------- the instrument half

#[test]
fn the_synth_declares_notes_in_and_no_audio_in() {
    unsafe {
        let synth = open_id(SYNTH_ID);
        let ports = (*synth).get_extension.unwrap()(synth, c"clap.audio-ports".as_ptr())
            as *const clap_plugin_audio_ports;
        assert!(!ports.is_null());
        assert_eq!(
            (*ports).count.unwrap()(synth, true),
            0,
            "an instrument has no audio input, and saying otherwise is what \
             crashed a third-party instrument in the native renderer"
        );
        assert_eq!((*ports).count.unwrap()(synth, false), 1);

        let notes = (*synth).get_extension.unwrap()(synth, c"clap.note-ports".as_ptr())
            as *const clap_plugin_note_ports;
        assert!(!notes.is_null(), "no clap.note-ports extension");
        assert_eq!((*notes).count.unwrap()(synth, true), 1);
        assert_eq!((*notes).count.unwrap()(synth, false), 0);

        let mut info = std::mem::zeroed::<clap_note_port_info>();
        assert!((*notes).get.unwrap()(synth, 0, true, &mut info));
        assert!(info.supported_dialects & CLAP_NOTE_DIALECT_CLAP != 0);

        // And the effect must not answer here, or a host would route notes
        // into something that drops them.
        let effect = open();
        assert!((*effect).get_extension.unwrap()(effect, c"clap.note-ports".as_ptr()).is_null());

        (*synth).destroy.unwrap()(synth);
        (*effect).destroy.unwrap()(effect);
    }
}

#[test]
fn a_note_makes_a_sound_and_a_note_off_ends_it() {
    let mut left = [0.0f32; N];
    let mut right = [0.0f32; N];
    let peak = |b: &[f32; N]| b.iter().fold(0.0f32, |m, s| m.max(s.abs()));

    unsafe {
        let synth = open_id(SYNTH_ID);
        assert!((*synth).activate.unwrap()(synth, SR as f64, 1, N as u32));
        assert!((*synth).start_processing.unwrap()(synth));

        // Silence before anything is played, from a buffer deliberately full
        // of rubbish: an instrument owns its output rather than adding to it.
        left.fill(0.5);
        right.fill(0.5);
        render_ports(synth, &mut left, &mut right, &Events::new(&[]), N as u32, 0);
        assert_eq!(peak(&left), 0.0, "an idle instrument must write silence");

        let on = Events::new(&[Ev::On(60, 1.0, 0)]);
        let mut loudest = 0.0f32;
        for block in 0..8 {
            let events = if block == 0 { &on } else { &Events::new(&[]) };
            render_ports(synth, &mut left, &mut right, events, N as u32, 0);
            loudest = loudest.max(peak(&left));
        }
        assert!(loudest > 0.05, "a played note was inaudible ({loudest})");
        assert!(
            left.iter().all(|s| s.is_finite() && s.abs() <= 1.5),
            "the synth left the rails"
        );

        // Release is 0.3 s, so a second of blocks after note off is silence.
        let off = Events::new(&[Ev::Off(60, 0)]);
        render_ports(synth, &mut left, &mut right, &off, N as u32, 0);
        for _ in 0..400 {
            render_ports(synth, &mut left, &mut right, &Events::new(&[]), N as u32, 0);
        }
        assert_eq!(peak(&left), 0.0, "the note never stopped");

        (*synth).destroy.unwrap()(synth);
    }
}

#[test]
fn the_synth_plugin_and_the_engine_track_agree_sample_for_sample() {
    const BLOCKS: usize = 24;
    const KEY: i16 = 64;

    // Through the plugin: one note at frame 0 of the first block.
    let mut plugin_out = Vec::with_capacity(BLOCKS * N);
    unsafe {
        let synth = open_id(SYNTH_ID);
        assert!((*synth).activate.unwrap()(synth, SR as f64, 1, N as u32));
        let on = Events::new(&[Ev::On(KEY, 0.8, 0)]);
        let empty = Events::new(&[]);
        let (mut l, mut r) = ([0.0f32; N], [0.0f32; N]);
        for block in 0..BLOCKS {
            let events = if block == 0 { &on } else { &empty };
            render_ports(synth, &mut l, &mut r, events, N as u32, 0);
            plugin_out.extend_from_slice(&l);
        }
        (*synth).destroy.unwrap()(synth);
    }

    // Through the engine's own track, with the patch the plugin starts from.
    let mut block = [0.0f32; PARAM_COUNT];
    block[OSC_A_BASE + OSC_ENABLED] = 1.0;
    block[P_POLYPHONY] = 8.0;
    block[P_MASTER_GAIN] = 1.0;
    block[ENV_FILTER_BASE + ENV_R] = 0.2;
    block[OSC_A_BASE + OSC_TABLE_ID] = 2.0;
    block[OSC_A_BASE + OSC_MORPH] = 0.0;
    block[OSC_A_BASE + OSC_LEVEL] = 0.8;
    block[OSC_A_BASE + OSC_UNISON] = 1.0;
    block[OSC_A_BASE + OSC_DETUNE_CENTS] = 10.0;
    block[P_FILTER_CUTOFF_HZ] = 8_000.0;
    block[P_FILTER_RES] = 0.2;
    block[P_FILTER_MODE] = 0.0;
    block[ENV_AMP_BASE + ENV_A] = 0.005;
    block[ENV_AMP_BASE + ENV_D] = 0.2;
    block[ENV_AMP_BASE + ENV_S] = 0.7;
    block[ENV_AMP_BASE + ENV_R] = 0.3;
    block[P_GLIDE_S] = 0.0;

    let tables = tables::build_all();
    let mut track = Track::new(SR);
    let mut direct = Vec::with_capacity(BLOCKS * N);
    let (mut l, mut r) = ([0.0f32; N], [0.0f32; N]);
    for i in 0..BLOCKS {
        // Same order as the plugin: events first, then patch, then render.
        if i == 0 {
            track.note_on(KEY as f32, 0.8);
        }
        track.apply_patch(&block);
        if !track.process(&tables, &mut l, &mut r) {
            l.fill(0.0);
            r.fill(0.0);
        }
        direct.extend_from_slice(&l);
    }

    assert_eq!(direct.len(), plugin_out.len());
    assert!(
        direct.iter().any(|s| *s != 0.0),
        "the comparison would pass on two silences"
    );
    assert_eq!(direct, plugin_out);
}

#[test]
fn malloc_hands_out_aligned_memory_a_host_can_write_f64_into() {
    unsafe {
        let ptr = sheliak_wclap::alloc::malloc(64);
        assert!(!ptr.is_null());
        assert_eq!(
            ptr as usize % 8,
            0,
            "a clap_event_param_value needs 8-byte alignment"
        );
        (ptr as *mut f64).write(1.5);
        assert_eq!((ptr as *mut f64).read(), 1.5);
        sheliak_wclap::alloc::free(ptr);
        // Freeing null is what C promises and what a host will do.
        sheliak_wclap::alloc::free(std::ptr::null_mut());
    }
}
