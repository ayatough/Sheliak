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
    clap_event_header, clap_event_param_value, clap_input_events, clap_output_events,
    CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE,
};
use clap_sys::ext::params::{clap_param_info, clap_plugin_params, CLAP_PARAM_IS_STEPPED};
use clap_sys::factory::plugin_factory::clap_plugin_factory;
use clap_sys::host::clap_host;
use clap_sys::plugin::clap_plugin;
use clap_sys::process::clap_process;
use clap_sys::version::CLAP_VERSION;

use sheliak_dsp::fx::dist::Dist;
use sheliak_dsp::fx::Effect;
use sheliak_dsp::params::{DIST_DRIVE, DIST_MIX, DIST_MODE, DIST_TONE_HZ, FX_SLOT_STRIDE};
use sheliak_wclap::clap_entry;

const SR: f32 = 48_000.0;
const N: usize = 128;
const PLUGIN_ID: &CStr = c"io.github.ayatough.sheliak.dist";

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

/// A `clap_input_events` backed by a plain `Vec`.
struct Events {
    list: clap_input_events,
    events: Vec<clap_event_param_value>,
}

unsafe extern "C" fn events_size(list: *const clap_input_events) -> u32 {
    (*((*list).ctx as *const Vec<clap_event_param_value>)).len() as u32
}

unsafe extern "C" fn events_get(
    list: *const clap_input_events,
    index: u32,
) -> *const clap_event_header {
    let events = &*((*list).ctx as *const Vec<clap_event_param_value>);
    match events.get(index as usize) {
        Some(event) => &event.header,
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
    /// `changes` are `(param id, value, frame)`, which CLAP requires in
    /// ascending frame order.
    fn new(changes: &[(u32, f64, u32)]) -> Box<Self> {
        let events = changes
            .iter()
            .map(|&(id, value, time)| clap_event_param_value {
                header: clap_event_header {
                    size: std::mem::size_of::<clap_event_param_value>() as u32,
                    time,
                    space_id: CLAP_CORE_EVENT_SPACE_ID,
                    type_: CLAP_EVENT_PARAM_VALUE,
                    flags: 0,
                },
                param_id: id,
                cookie: std::ptr::null_mut(),
                note_id: -1,
                port_index: -1,
                channel: -1,
                key: -1,
                value,
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
        boxed.list.ctx = &boxed.events as *const Vec<clap_event_param_value> as *mut c_void;
        boxed
    }
}

/// Creates and initialises the plugin, or fails the test saying which step.
unsafe fn open() -> *const clap_plugin {
    let get_factory = clap_entry
        .get_factory
        .expect("clap_entry has no get_factory");
    let factory = get_factory(c"clap.plugin-factory".as_ptr()) as *const clap_plugin_factory;
    assert!(!factory.is_null(), "no clap.plugin-factory");
    let create = (*factory)
        .create_plugin
        .expect("factory has no create_plugin");
    let plugin = create(factory, &HOST.0, PLUGIN_ID.as_ptr());
    assert!(!plugin.is_null(), "the factory refused its own plugin id");
    assert!((*plugin).init.unwrap()(plugin), "plugin.init said no");
    plugin
}

/// Runs one block through the plugin and returns the output channels.
unsafe fn render(
    plugin: *const clap_plugin,
    left: &mut [f32; N],
    right: &mut [f32; N],
    events: &Events,
    frames: u32,
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
        audio_inputs: &buffer,
        audio_outputs: &mut buffer,
        audio_inputs_count: 1,
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
        assert_eq!((*factory).get_plugin_count.unwrap()(factory), 1);

        let desc = (*factory).get_plugin_descriptor.unwrap()(factory, 0);
        assert_eq!(CStr::from_ptr((*desc).id), PLUGIN_ID);
        assert_eq!(CStr::from_ptr((*desc).name), c"Sheliak Distortion");
        assert!((*factory).get_plugin_descriptor.unwrap()(factory, 1).is_null());

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
        let events = Events::new(&[(0, DRIVE as f64, 0), (1, 1.0, 0)]);
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
        let events = Events::new(&[(1, 0.0, 0)]);
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
