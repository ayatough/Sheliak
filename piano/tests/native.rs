//! Drives the piano through the CLAP ABI, natively, where a panic still has
//! a backtrace — the same shape as `wclap/tests/native.rs`. What a DAW will
//! do to this plugin, done here first: enumerate it, activate it, feed it
//! notes and MIDI, automate a parameter, and round-trip its state.

use std::ffi::{c_void, CStr};

use clap_sys::events::{
    clap_event_header, clap_event_midi, clap_event_note, clap_event_param_value, clap_input_events,
    clap_output_events, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, CLAP_EVENT_NOTE_OFF,
    CLAP_EVENT_NOTE_ON, CLAP_EVENT_PARAM_VALUE,
};
use clap_sys::ext::audio_ports::clap_plugin_audio_ports;
use clap_sys::ext::note_ports::{
    clap_note_port_info, clap_plugin_note_ports, CLAP_NOTE_DIALECT_CLAP, CLAP_NOTE_DIALECT_MIDI,
};
use clap_sys::ext::params::{clap_param_info, clap_plugin_params};
use clap_sys::ext::state::clap_plugin_state;
use clap_sys::factory::plugin_factory::clap_plugin_factory;
use clap_sys::host::clap_host;
use clap_sys::plugin::clap_plugin;
use clap_sys::process::clap_process;
use clap_sys::stream::{clap_istream, clap_ostream};
use clap_sys::version::CLAP_VERSION;

use sheliak_piano::clap_entry;
use sheliak_piano::model::{P_GAIN_DB, P_SUSTAIN};

const SR: f32 = 48_000.0;
const N: usize = 128;
const PLUGIN_ID: &CStr = c"io.github.ayatough.sheliak.piano";

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
    /// Three raw MIDI bytes at a frame.
    Midi([u8; 3], u32),
}

enum Stored {
    Param(clap_event_param_value),
    Note(clap_event_note),
    Midi(clap_event_midi),
}

impl Stored {
    fn header(&self) -> *const clap_event_header {
        match self {
            Stored::Param(event) => &event.header,
            Stored::Note(event) => &event.header,
            Stored::Midi(event) => &event.header,
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
                Ev::Midi(data, time) => Stored::Midi(clap_event_midi {
                    header: header(
                        std::mem::size_of::<clap_event_midi>(),
                        time,
                        CLAP_EVENT_MIDI,
                    ),
                    port_index: 0,
                    data,
                }),
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

/// Runs one block through the plugin (an instrument: no audio inputs).
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
    let process = clap_process {
        steady_time: -1,
        frames_count: frames,
        transport: std::ptr::null(),
        audio_inputs: std::ptr::null(),
        audio_outputs: &mut buffer,
        audio_inputs_count: 0,
        audio_outputs_count: 1,
        in_events: &events.list,
        out_events: &out_events,
    };
    (*plugin).process.unwrap()(plugin, &process);
}

fn peak(b: &[f32; N]) -> f32 {
    b.iter().fold(0.0f32, |m, s| m.max(s.abs()))
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
fn the_factory_lists_one_piano_and_refuses_the_rest() {
    unsafe {
        let get_factory = clap_entry.get_factory.unwrap();
        let factory = get_factory(c"clap.plugin-factory".as_ptr()) as *const clap_plugin_factory;
        assert_eq!((*factory).get_plugin_count.unwrap()(factory), 1);

        let desc = (*factory).get_plugin_descriptor.unwrap()(factory, 0);
        assert_eq!(CStr::from_ptr((*desc).id), PLUGIN_ID);
        assert_eq!(CStr::from_ptr((*desc).name), c"Sheliak Piano");
        assert!((*factory).get_plugin_descriptor.unwrap()(factory, 1).is_null());

        let create = (*factory).create_plugin.unwrap();
        assert!(create(factory, &HOST.0, c"com.example.nope".as_ptr()).is_null());
    }
}

#[test]
fn the_ports_say_instrument_with_notes_and_midi() {
    unsafe {
        let plugin = open();
        let ports = (*plugin).get_extension.unwrap()(plugin, c"clap.audio-ports".as_ptr())
            as *const clap_plugin_audio_ports;
        assert!(!ports.is_null());
        assert_eq!(
            (*ports).count.unwrap()(plugin, true),
            0,
            "an instrument has no audio input"
        );
        assert_eq!((*ports).count.unwrap()(plugin, false), 1);

        let notes = (*plugin).get_extension.unwrap()(plugin, c"clap.note-ports".as_ptr())
            as *const clap_plugin_note_ports;
        assert!(!notes.is_null(), "no clap.note-ports extension");
        assert_eq!((*notes).count.unwrap()(plugin, true), 1);

        let mut info = std::mem::zeroed::<clap_note_port_info>();
        assert!((*notes).get.unwrap()(plugin, 0, true, &mut info));
        assert!(info.supported_dialects & CLAP_NOTE_DIALECT_CLAP != 0);
        assert!(
            info.supported_dialects & CLAP_NOTE_DIALECT_MIDI != 0,
            "without the MIDI dialect no host can deliver the sustain pedal"
        );

        (*plugin).destroy.unwrap()(plugin);
    }
}

#[test]
fn the_parameters_carry_their_own_ranges_and_names() {
    unsafe {
        let plugin = open();
        let params = (*plugin).get_extension.unwrap()(plugin, c"clap.params".as_ptr())
            as *const clap_plugin_params;
        assert!(!params.is_null(), "no clap.params extension");
        assert_eq!((*params).count.unwrap()(plugin), 9);

        let mut info = std::mem::zeroed::<clap_param_info>();
        assert!((*params).get_info.unwrap()(plugin, 0, &mut info));
        assert_eq!(CStr::from_ptr(info.name.as_ptr()), c"Gain");
        assert_eq!((info.min_value, info.max_value), (-24.0, 24.0));

        let mut text = [0i8; 64];
        assert!((*params).value_to_text.unwrap()(
            plugin,
            P_GAIN_DB,
            -6.0,
            text.as_mut_ptr(),
            64
        ));
        assert_eq!(CStr::from_ptr(text.as_ptr()), c"-6.0 dB");

        assert!((*params).value_to_text.unwrap()(
            plugin,
            P_SUSTAIN,
            1.0,
            text.as_mut_ptr(),
            64
        ));
        assert_eq!(CStr::from_ptr(text.as_ptr()), c"Down");

        let mut value = 0.0;
        assert!((*params).text_to_value.unwrap()(
            plugin,
            P_SUSTAIN,
            c"down".as_ptr(),
            &mut value
        ));
        assert_eq!(value, 1.0);

        (*plugin).destroy.unwrap()(plugin);
    }
}

#[test]
fn a_note_makes_a_sound_and_the_damper_ends_it() {
    let mut left = [0.0f32; N];
    let mut right = [0.0f32; N];
    unsafe {
        let plugin = open();
        assert!((*plugin).activate.unwrap()(plugin, SR as f64, 1, N as u32));
        assert!((*plugin).start_processing.unwrap()(plugin));

        // Silence before anything is played, from a buffer deliberately full
        // of rubbish: an instrument owns its output rather than adding to it.
        left.fill(0.5);
        right.fill(0.5);
        render(plugin, &mut left, &mut right, &Events::new(&[]), N as u32);
        assert_eq!(peak(&left), 0.0, "an idle instrument must write silence");

        let on = Events::new(&[Ev::On(60, 0.9, 0)]);
        let empty = Events::new(&[]);
        let mut loudest = 0.0f32;
        for block in 0..16 {
            let events = if block == 0 { &on } else { &empty };
            render(plugin, &mut left, &mut right, events, N as u32);
            loudest = loudest.max(peak(&left)).max(peak(&right));
        }
        assert!(loudest > 0.005, "a played note was inaudible ({loudest})");
        assert!(
            left.iter().all(|s| s.is_finite() && s.abs() <= 1.5),
            "the piano left the rails"
        );

        // Note off, then two seconds of blocks: the damper ends the note.
        let off = Events::new(&[Ev::Off(60, 0)]);
        render(plugin, &mut left, &mut right, &off, N as u32);
        for _ in 0..750 {
            render(plugin, &mut left, &mut right, &empty, N as u32);
        }
        assert!(
            peak(&left) < 1.0e-5,
            "the note never stopped ({})",
            peak(&left)
        );

        (*plugin).destroy.unwrap()(plugin);
    }
}

#[test]
fn midi_notes_and_the_cc64_pedal_work() {
    let mut left = [0.0f32; N];
    let mut right = [0.0f32; N];
    unsafe {
        let plugin = open();
        assert!((*plugin).activate.unwrap()(plugin, SR as f64, 1, N as u32));

        // A MIDI note-on, a pedal press, then the note-off: the pedal must
        // keep the note ringing.
        let events = Events::new(&[
            Ev::Midi([0x90, 60, 100], 0),
            Ev::Midi([0xB0, 64, 127], 0),
            Ev::Midi([0x80, 60, 0], 64),
        ]);
        render(plugin, &mut left, &mut right, &events, N as u32);
        let empty = Events::new(&[]);
        // Half a second on: still sounding, because the pedal is down.
        for _ in 0..187 {
            render(plugin, &mut left, &mut right, &empty, N as u32);
        }
        assert!(
            peak(&left) > 1.0e-4,
            "the pedal did not hold the note ({})",
            peak(&left)
        );

        // Pedal up: the dampers fall and the note dies.
        let up = Events::new(&[Ev::Midi([0xB0, 64, 0], 0)]);
        render(plugin, &mut left, &mut right, &up, N as u32);
        for _ in 0..750 {
            render(plugin, &mut left, &mut right, &empty, N as u32);
        }
        assert!(
            peak(&left) < 1.0e-5,
            "pedal release did not stop the note ({})",
            peak(&left)
        );

        (*plugin).destroy.unwrap()(plugin);
    }
}

#[test]
fn the_plugin_path_is_deterministic() {
    let run = || {
        let mut left = [0.0f32; N];
        let mut right = [0.0f32; N];
        let mut out = Vec::new();
        unsafe {
            let plugin = open();
            assert!((*plugin).activate.unwrap()(plugin, SR as f64, 1, N as u32));
            let first = Events::new(&[
                Ev::Param(P_GAIN_DB, -3.0, 0),
                Ev::On(48, 0.8, 0),
                Ev::On(64, 0.6, 37),
            ]);
            let empty = Events::new(&[]);
            for block in 0..48 {
                let events = if block == 0 { &first } else { &empty };
                render(plugin, &mut left, &mut right, events, N as u32);
                out.extend_from_slice(&left);
                out.extend_from_slice(&right);
            }
            (*plugin).destroy.unwrap()(plugin);
        }
        out
    };
    let a = run();
    assert!(a.iter().any(|s| *s != 0.0), "the run was silent");
    assert_eq!(a, run(), "two identical runs disagreed");
}

// ------------------------------------------------------------------ state

struct Blob {
    bytes: Vec<u8>,
    at: usize,
}

unsafe extern "C" fn blob_write(
    stream: *const clap_ostream,
    buffer: *const c_void,
    size: u64,
) -> i64 {
    let blob = &mut *((*stream).ctx as *mut Blob);
    let bytes = std::slice::from_raw_parts(buffer as *const u8, size as usize);
    blob.bytes.extend_from_slice(bytes);
    size as i64
}

unsafe extern "C" fn blob_read(stream: *const clap_istream, buffer: *mut c_void, size: u64) -> i64 {
    let blob = &mut *((*stream).ctx as *mut Blob);
    let n = (blob.bytes.len() - blob.at).min(size as usize);
    std::ptr::copy_nonoverlapping(blob.bytes[blob.at..].as_ptr(), buffer as *mut u8, n);
    blob.at += n;
    n as i64
}

#[test]
fn state_round_trips_the_parameters() {
    unsafe {
        let plugin = open();
        let params = (*plugin).get_extension.unwrap()(plugin, c"clap.params".as_ptr())
            as *const clap_plugin_params;
        let state = (*plugin).get_extension.unwrap()(plugin, c"clap.state".as_ptr())
            as *const clap_plugin_state;
        assert!(!state.is_null(), "no clap.state extension");

        // Change Gain via flush (the plugin is not active), save, reset the
        // value, load: the saved value must come back.
        let change = Events::new(&[Ev::Param(P_GAIN_DB, -12.0, 0)]);
        let out_events = clap_output_events {
            ctx: std::ptr::null_mut(),
            try_push: Some(out_try_push),
        };
        (*params).flush.unwrap()(plugin, &change.list, &out_events);

        let mut blob = Blob {
            bytes: Vec::new(),
            at: 0,
        };
        let ostream = clap_ostream {
            ctx: &mut blob as *mut Blob as *mut c_void,
            write: Some(blob_write),
        };
        assert!(
            (*state).save.unwrap()(plugin, &ostream),
            "state.save failed"
        );
        assert!(!blob.bytes.is_empty());

        let back = Events::new(&[Ev::Param(P_GAIN_DB, 0.0, 0)]);
        (*params).flush.unwrap()(plugin, &back.list, &out_events);
        let mut value = 0.0;
        assert!((*params).get_value.unwrap()(plugin, P_GAIN_DB, &mut value));
        assert_eq!(value, 0.0);

        let istream = clap_istream {
            ctx: &mut blob as *mut Blob as *mut c_void,
            read: Some(blob_read),
        };
        assert!(
            (*state).load.unwrap()(plugin, &istream),
            "state.load failed"
        );
        assert!((*params).get_value.unwrap()(plugin, P_GAIN_DB, &mut value));
        assert_eq!(value, -12.0, "the saved gain did not come back");

        (*plugin).destroy.unwrap()(plugin);
    }
}
