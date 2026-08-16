//! A physically modelled piano, wearing the CLAP ABI, built natively.
//!
//! The shell around the model follows `wclap/src/lib.rs`, which is this
//! repository's worked example of a CLAP plugin in plain Rust; where the two
//! differ it is because a piano needs something the synth did not:
//!
//! * **the MIDI dialect on the note port.** The sustain pedal arrives as
//!   CC 64, and CLAP has no pedal event of its own — a host with a pedal
//!   sends MIDI. The port therefore speaks both dialects, preferring CLAP
//!   notes, and the pedal is *also* a parameter (`Sustain Pedal`) so hosts
//!   without MIDI routing can automate it.
//! * **the `state` extension.** A DAW project that reloads with every knob
//!   at default is not a plugin anyone keeps; state is the parameter values,
//!   written as little-endian id/value pairs behind a magic and a version.
//!
//! The model itself lives in [`model`], and knows nothing about CLAP.

pub mod keys;
pub mod model;

use core::ffi::{c_char, c_void};
use std::ffi::CStr;
use std::ptr::{null, null_mut};

use clap_sys::entry::clap_plugin_entry;
use clap_sys::events::{
    clap_event_header, clap_event_midi, clap_event_note, clap_event_param_value, clap_input_events,
    clap_output_events, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, CLAP_EVENT_NOTE_CHOKE,
    CLAP_EVENT_NOTE_OFF, CLAP_EVENT_NOTE_ON, CLAP_EVENT_PARAM_VALUE,
};
use clap_sys::ext::audio_ports::{
    clap_audio_port_info, clap_plugin_audio_ports, CLAP_AUDIO_PORT_IS_MAIN, CLAP_EXT_AUDIO_PORTS,
    CLAP_PORT_STEREO,
};
use clap_sys::ext::note_ports::{
    clap_note_port_info, clap_plugin_note_ports, CLAP_EXT_NOTE_PORTS, CLAP_NOTE_DIALECT_CLAP,
    CLAP_NOTE_DIALECT_MIDI,
};
use clap_sys::ext::params::{
    clap_host_params, clap_param_info, clap_plugin_params, CLAP_EXT_PARAMS,
    CLAP_PARAM_IS_AUTOMATABLE, CLAP_PARAM_IS_STEPPED, CLAP_PARAM_RESCAN_VALUES,
};
use clap_sys::ext::state::{clap_plugin_state, CLAP_EXT_STATE};
use clap_sys::factory::plugin_factory::{clap_plugin_factory, CLAP_PLUGIN_FACTORY_ID};
use clap_sys::host::clap_host;
use clap_sys::id::{clap_id, CLAP_INVALID_ID};
use clap_sys::plugin::{clap_plugin, clap_plugin_descriptor};
use clap_sys::process::{clap_process, clap_process_status, CLAP_PROCESS_CONTINUE};
use clap_sys::stream::{clap_istream, clap_ostream};
use clap_sys::version::CLAP_VERSION;

use model::{Piano, PARAM_COUNT};

// --------------------------------------------------------------- descriptors

/// A NUL-terminated literal as a C string pointer, usable in a `static`.
const fn cstr(bytes: &'static [u8]) -> *const c_char {
    bytes.as_ptr() as *const c_char
}

/// What kind of number a parameter is, which is all a host needs to label it.
enum ParamKind {
    Number {
        decimals: usize,
        suffix: &'static str,
    },
    Choice(&'static [&'static [u8]]),
}

/// One parameter: CLAP's vocabulary (id, range, default) for a value the
/// model reads in its own unit — the CLAP value *is* the model value.
struct ParamDesc {
    id: clap_id,
    name: &'static [u8],
    min: f64,
    max: f64,
    default: f64,
    kind: ParamKind,
}

impl ParamDesc {
    fn flags(&self) -> u32 {
        let mut f = CLAP_PARAM_IS_AUTOMATABLE;
        if matches!(self.kind, ParamKind::Choice(_)) {
            f |= CLAP_PARAM_IS_STEPPED;
        }
        f
    }
}

const NUMBER: ParamKind = ParamKind::Number {
    decimals: 2,
    suffix: "",
};

static PEDAL_NAMES: [&[u8]; 2] = [b"Up\0", b"Down\0"];

static PARAMS_DESC: [ParamDesc; PARAM_COUNT] = [
    ParamDesc {
        id: model::P_GAIN_DB,
        name: b"Gain\0",
        min: -24.0,
        max: 24.0,
        default: 0.0,
        kind: ParamKind::Number {
            decimals: 1,
            suffix: " dB",
        },
    },
    ParamDesc {
        id: model::P_HARDNESS,
        name: b"Hammer Hardness\0",
        min: 0.0,
        max: 1.0,
        default: 0.5,
        kind: NUMBER,
    },
    ParamDesc {
        id: model::P_DETUNE,
        name: b"Unison Detune\0",
        min: 0.0,
        max: 2.0,
        default: 1.0,
        kind: NUMBER,
    },
    ParamDesc {
        id: model::P_BRIGHTNESS_HZ,
        name: b"Brightness\0",
        min: 500.0,
        max: 16000.0,
        default: 7500.0,
        kind: ParamKind::Number {
            decimals: 0,
            suffix: " Hz",
        },
    },
    ParamDesc {
        id: model::P_DECAY,
        name: b"Decay\0",
        min: 0.25,
        max: 4.0,
        default: 1.0,
        kind: ParamKind::Number {
            decimals: 2,
            suffix: "x",
        },
    },
    ParamDesc {
        id: model::P_DAMPER_S,
        name: b"Damper\0",
        min: 0.05,
        max: 1.0,
        default: 0.2,
        kind: ParamKind::Number {
            decimals: 3,
            suffix: " s",
        },
    },
    ParamDesc {
        id: model::P_STRETCH,
        name: b"Stretch\0",
        min: 0.0,
        max: 2.0,
        default: 1.0,
        kind: NUMBER,
    },
    ParamDesc {
        id: model::P_DYNAMICS,
        name: b"Dynamics\0",
        min: 0.0,
        max: 1.0,
        default: 0.5,
        kind: NUMBER,
    },
    ParamDesc {
        id: model::P_SUSTAIN,
        name: b"Sustain Pedal\0",
        min: 0.0,
        max: 1.0,
        default: 0.0,
        kind: ParamKind::Choice(&PEDAL_NAMES),
    },
];

/// Raw pointers into `'static` string data — immutable for the life of the
/// module, so sharing them is sound.
struct Statics<T>(T);
unsafe impl<T> Sync for Statics<T> {}

static FEATURES: Statics<[*const c_char; 4]> = Statics([
    cstr(b"instrument\0"),
    cstr(b"piano\0"),
    cstr(b"stereo\0"),
    null(),
]);

static DESCRIPTOR: Statics<clap_plugin_descriptor> = Statics(clap_plugin_descriptor {
    clap_version: CLAP_VERSION,
    id: cstr(b"io.github.ayatough.sheliak.piano\0"),
    name: cstr(b"Sheliak Piano\0"),
    vendor: cstr(b"Sheliak\0"),
    url: cstr(b"https://github.com/ayatough/Sheliak\0"),
    manual_url: cstr(b"https://github.com/ayatough/Sheliak\0"),
    support_url: cstr(b"https://github.com/ayatough/Sheliak/issues\0"),
    version: cstr(b"0.1.0\0"),
    description: cstr(b"A physically modelled piano: modal strings struck by a felt hammer.\0"),
    features: FEATURES.0.as_ptr(),
});

// -------------------------------------------------------------------- helpers

/// Does a host-supplied C string say `expected` (which carries its own NUL)?
///
/// # Safety
///
/// `s` must be null or a valid NUL-terminated string.
unsafe fn cstr_is(s: *const c_char, expected: &[u8]) -> bool {
    !s.is_null() && CStr::from_ptr(s).to_bytes_with_nul() == expected
}

/// Copies a NUL-terminated literal into a fixed C char array, truncating
/// rather than overflowing.
fn write_name(dst: &mut [c_char], src: &[u8]) {
    let Some(last) = dst.len().checked_sub(1) else {
        return;
    };
    let n = src.len().min(dst.len());
    for (d, s) in dst.iter_mut().zip(&src[..n]) {
        *d = *s as c_char;
    }
    dst[last] = 0;
}

/// Writes `text` into a host buffer, NUL-terminated, and reports whether it
/// fitted.
fn write_text(text: &str, out: *mut c_char, capacity: u32) -> bool {
    let cap = capacity as usize;
    if out.is_null() || cap == 0 {
        return false;
    }
    let bytes = text.as_bytes();
    if bytes.len() + 1 > cap {
        return false;
    }
    // SAFETY: the host promises `capacity` writable bytes at `out`, and the
    // length check above keeps the write inside them.
    unsafe {
        for (i, b) in bytes.iter().enumerate() {
            out.add(i).write(*b as c_char);
        }
        out.add(bytes.len()).write(0);
    }
    true
}

// ------------------------------------------------------------------ instance

/// One live plugin. `clap` is first so a host that (wrongly) treats the
/// `clap_plugin*` as the instance address still lands on something valid.
struct Instance {
    clap: clap_plugin,
    /// The host that created us — needed to announce that parameter values
    /// changed on the plugin's initiative (a state load), which a host has
    /// no other way of noticing.
    host: *const clap_host,
    /// Parameter values, authoritative even while deactivated — state saves
    /// and loads read and write these, engine or no engine.
    values: [f64; PARAM_COUNT],
    /// Built at `activate()`, where the sample rate arrives; dropped at
    /// `deactivate()`. Allocation lives there and nowhere else.
    engine: Option<Box<Piano>>,
}

impl Instance {
    fn set_value(&mut self, id: clap_id, value: f64) {
        let Some(desc) = PARAMS_DESC.iter().find(|p| p.id == id) else {
            return;
        };
        let value = value.clamp(desc.min, desc.max);
        self.values[id as usize] = value;
        if let Some(engine) = &mut self.engine {
            engine.set_param(id, value);
        }
    }

    /// Applies one event, ignoring anything in another event space and any
    /// type this plugin has no use for — an unknown event is not an error.
    ///
    /// # Safety
    ///
    /// `header` must point at a complete event of the size it declares.
    unsafe fn event(&mut self, header: *const clap_event_header) {
        if (*header).space_id != CLAP_CORE_EVENT_SPACE_ID {
            return;
        }
        match (*header).type_ {
            CLAP_EVENT_PARAM_VALUE => {
                let ev = header as *const clap_event_param_value;
                self.set_value((*ev).param_id, (*ev).value);
            }
            CLAP_EVENT_NOTE_ON | CLAP_EVENT_NOTE_OFF | CLAP_EVENT_NOTE_CHOKE => {
                let Some(engine) = &mut self.engine else {
                    return;
                };
                let ev = header as *const clap_event_note;
                // A key of -1 is CLAP's wildcard and means "every note".
                let key = (*ev).key;
                match (*header).type_ {
                    CLAP_EVENT_NOTE_ON => {
                        if key >= 0 {
                            engine.note_on(key, (*ev).velocity.clamp(0.0, 1.0) as f32);
                        }
                    }
                    CLAP_EVENT_NOTE_OFF if key < 0 => engine.all_notes_off(),
                    CLAP_EVENT_NOTE_OFF => engine.note_off(key),
                    _ if key < 0 => engine.all_sound_off(),
                    _ => engine.choke(key),
                }
            }
            CLAP_EVENT_MIDI => {
                let Some(engine) = &mut self.engine else {
                    return;
                };
                let ev = header as *const clap_event_midi;
                let data = (*ev).data;
                let key = data[1] as i16;
                match data[0] & 0xF0 {
                    0x90 if data[2] > 0 => engine.note_on(key, data[2] as f32 / 127.0),
                    // A zero-velocity note-on is MIDI's spelling of note-off.
                    0x90 | 0x80 => engine.note_off(key),
                    0xB0 => match data[1] {
                        64 => engine.set_pedal(data[2] >= 64),
                        120 => engine.all_sound_off(),
                        123 => engine.all_notes_off(),
                        _ => {}
                    },
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// # Safety
///
/// `plugin` must be a pointer this module returned from `create_plugin` and
/// has not destroyed.
unsafe fn instance<'a>(plugin: *const clap_plugin) -> Option<&'a mut Instance> {
    if plugin.is_null() {
        return None;
    }
    let data = (*plugin).plugin_data as *mut Instance;
    if data.is_null() {
        None
    } else {
        Some(&mut *data)
    }
}

// -------------------------------------------------------------- plugin vtable

unsafe extern "C" fn plugin_init(_plugin: *const clap_plugin) -> bool {
    true
}

unsafe extern "C" fn plugin_destroy(plugin: *const clap_plugin) {
    if plugin.is_null() {
        return;
    }
    let data = (*plugin).plugin_data as *mut Instance;
    if !data.is_null() {
        drop(Box::from_raw(data));
    }
}

unsafe extern "C" fn plugin_activate(
    plugin: *const clap_plugin,
    sample_rate: f64,
    _min_frames: u32,
    _max_frames: u32,
) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    let mut engine = Box::new(Piano::new(sample_rate as f32));
    for desc in &PARAMS_DESC {
        engine.set_param(desc.id, inst.values[desc.id as usize]);
    }
    inst.engine = Some(engine);
    true
}

unsafe extern "C" fn plugin_deactivate(plugin: *const clap_plugin) {
    if let Some(inst) = instance(plugin) {
        inst.engine = None;
    }
}

unsafe extern "C" fn plugin_start_processing(_plugin: *const clap_plugin) -> bool {
    true
}

unsafe extern "C" fn plugin_stop_processing(_plugin: *const clap_plugin) {}

unsafe extern "C" fn plugin_reset(plugin: *const clap_plugin) {
    if let Some(inst) = instance(plugin) {
        if let Some(engine) = &mut inst.engine {
            engine.reset();
        }
    }
}

unsafe extern "C" fn plugin_on_main_thread(_plugin: *const clap_plugin) {}

unsafe extern "C" fn plugin_get_extension(
    _plugin: *const clap_plugin,
    id: *const c_char,
) -> *const c_void {
    if cstr_is(id, CLAP_EXT_AUDIO_PORTS.to_bytes_with_nul()) {
        return &AUDIO_PORTS.0 as *const clap_plugin_audio_ports as *const c_void;
    }
    if cstr_is(id, CLAP_EXT_NOTE_PORTS.to_bytes_with_nul()) {
        return &NOTE_PORTS.0 as *const clap_plugin_note_ports as *const c_void;
    }
    if cstr_is(id, CLAP_EXT_PARAMS.to_bytes_with_nul()) {
        return &PARAMS_EXT.0 as *const clap_plugin_params as *const c_void;
    }
    if cstr_is(id, CLAP_EXT_STATE.to_bytes_with_nul()) {
        return &STATE.0 as *const clap_plugin_state as *const c_void;
    }
    null()
}

/// The output buffer pointers, checked.
///
/// # Safety
///
/// `buffer` must describe `frames` valid samples per channel.
unsafe fn channels(
    buffer: *const clap_sys::audio_buffer::clap_audio_buffer,
    frames: usize,
) -> Option<(*mut f32, Option<*mut f32>)> {
    if buffer.is_null() || (*buffer).data32.is_null() || (*buffer).channel_count == 0 || frames == 0
    {
        return None;
    }
    let l = *(*buffer).data32;
    if l.is_null() {
        return None;
    }
    let r = if (*buffer).channel_count >= 2 {
        let p = *(*buffer).data32.add(1);
        if p.is_null() {
            None
        } else {
            Some(p)
        }
    } else {
        None
    };
    Some((l, r))
}

unsafe extern "C" fn plugin_process(
    plugin: *const clap_plugin,
    process: *const clap_process,
) -> clap_process_status {
    let Some(inst) = instance(plugin) else {
        return CLAP_PROCESS_CONTINUE;
    };
    if process.is_null() {
        return CLAP_PROCESS_CONTINUE;
    }
    let p = &*process;
    let frames = p.frames_count as usize;
    if p.audio_outputs_count == 0 || frames == 0 {
        return CLAP_PROCESS_CONTINUE;
    }
    let Some((out_l, out_r)) = channels(p.audio_outputs, frames) else {
        return CLAP_PROCESS_CONTINUE;
    };
    (*p.audio_outputs).constant_mask = 0;

    let events = p.in_events;
    let event_count = if events.is_null() {
        0
    } else {
        (*events).size.map_or(0, |size| size(events))
    };
    let get = if events.is_null() {
        None
    } else {
        (*events).get
    };

    // Sample-accurate splitting: everything due at or before the current
    // frame is applied, then audio runs to the next event's frame.
    let mut next = 0u32;
    let mut frame = 0usize;
    while frame < frames {
        while next < event_count {
            let Some(get) = get else { break };
            let header = get(events, next);
            if header.is_null() {
                next += 1;
                continue;
            }
            if (*header).time as usize > frame {
                break;
            }
            inst.event(header);
            next += 1;
        }

        let mut end = frames;
        if next < event_count {
            if let Some(get) = get {
                let header = get(events, next);
                if !header.is_null() {
                    let time = (*header).time as usize;
                    if time > frame && time < end {
                        end = time;
                    }
                }
            }
        }

        let n = end - frame;
        let l = std::slice::from_raw_parts_mut(out_l.add(frame), n);
        match (&mut inst.engine, out_r) {
            (Some(engine), Some(r)) => {
                let r = std::slice::from_raw_parts_mut(r.add(frame), n);
                engine.process(l, r);
            }
            (Some(engine), None) => {
                // A mono host: render both channels and keep the mean, so
                // the two readout points still both contribute.
                let mut right = [0.0f32; 256];
                let mut done = 0;
                while done < n {
                    let step = (n - done).min(right.len());
                    let l_part = &mut l[done..done + step];
                    engine.process(l_part, &mut right[..step]);
                    for (l, r) in l_part.iter_mut().zip(&right[..step]) {
                        *l = 0.5 * (*l + r);
                    }
                    done += step;
                }
            }
            (None, r) => {
                l.fill(0.0);
                if let Some(r) = r {
                    std::slice::from_raw_parts_mut(r.add(frame), n).fill(0.0);
                }
            }
        }
        frame = end;
    }

    CLAP_PROCESS_CONTINUE
}

// ------------------------------------------------------------- audio-ports ext

unsafe extern "C" fn ports_count(_plugin: *const clap_plugin, is_input: bool) -> u32 {
    if is_input {
        0
    } else {
        1
    }
}

unsafe extern "C" fn ports_get(
    plugin: *const clap_plugin,
    index: u32,
    is_input: bool,
    info: *mut clap_audio_port_info,
) -> bool {
    if index >= ports_count(plugin, is_input) || info.is_null() {
        return false;
    }
    let info = &mut *info;
    info.id = 0;
    info.flags = CLAP_AUDIO_PORT_IS_MAIN;
    info.channel_count = 2;
    info.port_type = CLAP_PORT_STEREO.as_ptr();
    // An instrument has no input to be in place with.
    info.in_place_pair = CLAP_INVALID_ID;
    write_name(&mut info.name, b"Output\0");
    true
}

static AUDIO_PORTS: Statics<clap_plugin_audio_ports> = Statics(clap_plugin_audio_ports {
    count: Some(ports_count),
    get: Some(ports_get),
});

// -------------------------------------------------------------- note-ports ext

unsafe extern "C" fn note_ports_count(_plugin: *const clap_plugin, is_input: bool) -> u32 {
    if is_input {
        1
    } else {
        0
    }
}

unsafe extern "C" fn note_ports_get(
    plugin: *const clap_plugin,
    index: u32,
    is_input: bool,
    info: *mut clap_note_port_info,
) -> bool {
    if index >= note_ports_count(plugin, is_input) || info.is_null() {
        return false;
    }
    let info = &mut *info;
    info.id = 0;
    // Both dialects: CLAP notes preferred, MIDI accepted because the sustain
    // pedal has no CLAP event and arrives as CC 64.
    info.supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
    info.preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
    write_name(&mut info.name, b"Notes\0");
    true
}

static NOTE_PORTS: Statics<clap_plugin_note_ports> = Statics(clap_plugin_note_ports {
    count: Some(note_ports_count),
    get: Some(note_ports_get),
});

// ------------------------------------------------------------------ params ext

unsafe extern "C" fn params_count(_plugin: *const clap_plugin) -> u32 {
    PARAMS_DESC.len() as u32
}

unsafe extern "C" fn params_get_info(
    _plugin: *const clap_plugin,
    index: u32,
    info: *mut clap_param_info,
) -> bool {
    let Some(desc) = PARAMS_DESC.get(index as usize) else {
        return false;
    };
    if info.is_null() {
        return false;
    }
    let info = &mut *info;
    info.id = desc.id;
    info.flags = desc.flags();
    info.cookie = null_mut();
    info.min_value = desc.min;
    info.max_value = desc.max;
    info.default_value = desc.default;
    write_name(&mut info.name, desc.name);
    info.module[0] = 0;
    true
}

unsafe extern "C" fn params_get_value(
    plugin: *const clap_plugin,
    id: clap_id,
    out: *mut f64,
) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    if PARAMS_DESC.iter().all(|p| p.id != id) || out.is_null() {
        return false;
    }
    *out = inst.values[id as usize];
    true
}

unsafe extern "C" fn params_value_to_text(
    _plugin: *const clap_plugin,
    id: clap_id,
    value: f64,
    out: *mut c_char,
    capacity: u32,
) -> bool {
    let Some(desc) = PARAMS_DESC.iter().find(|p| p.id == id) else {
        return false;
    };
    let text = match desc.kind {
        ParamKind::Choice(names) => {
            let i = value.round().clamp(0.0, (names.len() - 1) as f64) as usize;
            String::from_utf8_lossy(&names[i][..names[i].len() - 1]).into_owned()
        }
        ParamKind::Number { decimals, suffix } => format!("{value:.decimals$}{suffix}"),
    };
    write_text(&text, out, capacity)
}

unsafe extern "C" fn params_text_to_value(
    _plugin: *const clap_plugin,
    id: clap_id,
    text: *const c_char,
    out: *mut f64,
) -> bool {
    let Some(desc) = PARAMS_DESC.iter().find(|p| p.id == id) else {
        return false;
    };
    if text.is_null() || out.is_null() {
        return false;
    }
    let Ok(text) = CStr::from_ptr(text).to_str() else {
        return false;
    };
    let text = text.trim();
    if let ParamKind::Choice(names) = desc.kind {
        for (i, name) in names.iter().enumerate() {
            let name = &name[..name.len() - 1];
            if text.as_bytes().eq_ignore_ascii_case(name) {
                *out = i as f64;
                return true;
            }
        }
    }
    // "7500 Hz" and "0.200 s" are what `value_to_text` produced, so they are
    // what a host is most likely to hand back.
    let text = text
        .trim_end_matches(|c: char| c.is_ascii_alphabetic())
        .trim();
    let Ok(value) = text.parse::<f64>() else {
        return false;
    };
    *out = value.clamp(desc.min, desc.max);
    true
}

unsafe extern "C" fn params_flush(
    plugin: *const clap_plugin,
    events: *const clap_input_events,
    _out: *const clap_output_events,
) {
    let Some(inst) = instance(plugin) else { return };
    if events.is_null() {
        return;
    }
    let count = (*events).size.map_or(0, |size| size(events));
    let Some(get) = (*events).get else { return };
    for i in 0..count {
        let header = get(events, i);
        if !header.is_null() {
            inst.event(header);
        }
    }
}

static PARAMS_EXT: Statics<clap_plugin_params> = Statics(clap_plugin_params {
    count: Some(params_count),
    get_info: Some(params_get_info),
    get_value: Some(params_get_value),
    value_to_text: Some(params_value_to_text),
    text_to_value: Some(params_text_to_value),
    flush: Some(params_flush),
});

// ------------------------------------------------------------------- state ext

/// Bytes at the front of a state blob: "SPNO" then a format version.
const STATE_MAGIC: u32 = u32::from_le_bytes(*b"SPNO");
const STATE_VERSION: u32 = 1;

unsafe extern "C" fn state_save(plugin: *const clap_plugin, stream: *const clap_ostream) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    if stream.is_null() {
        return false;
    }
    let Some(write) = (*stream).write else {
        return false;
    };

    let mut bytes = Vec::with_capacity(12 + PARAMS_DESC.len() * 12);
    bytes.extend_from_slice(&STATE_MAGIC.to_le_bytes());
    bytes.extend_from_slice(&STATE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&(PARAMS_DESC.len() as u32).to_le_bytes());
    for desc in &PARAMS_DESC {
        bytes.extend_from_slice(&desc.id.to_le_bytes());
        bytes.extend_from_slice(&inst.values[desc.id as usize].to_le_bytes());
    }

    let mut sent = 0;
    while sent < bytes.len() {
        let n = write(
            stream,
            bytes[sent..].as_ptr() as *const c_void,
            (bytes.len() - sent) as u64,
        );
        if n <= 0 {
            return false;
        }
        sent += n as usize;
    }
    true
}

unsafe extern "C" fn state_load(plugin: *const clap_plugin, stream: *const clap_istream) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    if stream.is_null() {
        return false;
    }
    let Some(read) = (*stream).read else {
        return false;
    };

    let mut bytes = Vec::new();
    let mut chunk = [0u8; 256];
    loop {
        let n = read(
            stream,
            chunk.as_mut_ptr() as *mut c_void,
            chunk.len() as u64,
        );
        if n < 0 {
            return false;
        }
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n as usize]);
        // A state blob is a few hundred bytes; a stream that keeps going is
        // not this plugin's state.
        if bytes.len() > 64 * 1024 {
            return false;
        }
    }

    let word = |at: usize| -> Option<u32> {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    };
    if word(0) != Some(STATE_MAGIC) || word(4) != Some(STATE_VERSION) {
        return false;
    }
    let Some(count) = word(8) else {
        return false;
    };
    let mut at = 12;
    for _ in 0..count {
        let Some(id) = word(at) else { return false };
        let Some(raw) = bytes.get(at + 4..at + 12) else {
            return false;
        };
        let value = f64::from_le_bytes(raw.try_into().unwrap());
        if value.is_finite() {
            inst.set_value(id, value);
        }
        at += 12;
    }

    // The values just changed on the plugin's initiative, and a host only
    // learns that by being told. `load` is a main-thread call, which is the
    // thread `rescan` wants.
    if !inst.host.is_null() {
        if let Some(get_extension) = (*inst.host).get_extension {
            let ext = get_extension(inst.host, CLAP_EXT_PARAMS.as_ptr()) as *const clap_host_params;
            if !ext.is_null() {
                if let Some(rescan) = (*ext).rescan {
                    rescan(inst.host, CLAP_PARAM_RESCAN_VALUES);
                }
            }
        }
    }
    true
}

static STATE: Statics<clap_plugin_state> = Statics(clap_plugin_state {
    save: Some(state_save),
    load: Some(state_load),
});

// ----------------------------------------------------------------- factory

unsafe extern "C" fn factory_count(_factory: *const clap_plugin_factory) -> u32 {
    1
}

unsafe extern "C" fn factory_descriptor(
    _factory: *const clap_plugin_factory,
    index: u32,
) -> *const clap_plugin_descriptor {
    if index == 0 {
        &DESCRIPTOR.0
    } else {
        null()
    }
}

unsafe extern "C" fn factory_create(
    _factory: *const clap_plugin_factory,
    host: *const clap_host,
    id: *const c_char,
) -> *const clap_plugin {
    if !cstr_is(id, CStr::from_ptr(DESCRIPTOR.0.id).to_bytes_with_nul()) {
        return null();
    }

    let mut values = [0.0f64; PARAM_COUNT];
    for desc in &PARAMS_DESC {
        values[desc.id as usize] = desc.default;
    }

    let instance = Box::new(Instance {
        clap: clap_plugin {
            desc: &DESCRIPTOR.0,
            plugin_data: null_mut(),
            init: Some(plugin_init),
            destroy: Some(plugin_destroy),
            activate: Some(plugin_activate),
            deactivate: Some(plugin_deactivate),
            start_processing: Some(plugin_start_processing),
            stop_processing: Some(plugin_stop_processing),
            reset: Some(plugin_reset),
            process: Some(plugin_process),
            get_extension: Some(plugin_get_extension),
            on_main_thread: Some(plugin_on_main_thread),
        },
        host,
        values,
        engine: None,
    });

    let raw = Box::into_raw(instance);
    (*raw).clap.plugin_data = raw as *mut c_void;
    &(*raw).clap
}

static FACTORY: Statics<clap_plugin_factory> = Statics(clap_plugin_factory {
    get_plugin_count: Some(factory_count),
    get_plugin_descriptor: Some(factory_descriptor),
    create_plugin: Some(factory_create),
});

// ------------------------------------------------------------------- entry

unsafe extern "C" fn entry_init(_plugin_path: *const c_char) -> bool {
    true
}

unsafe extern "C" fn entry_deinit() {}

unsafe extern "C" fn entry_get_factory(id: *const c_char) -> *const c_void {
    if cstr_is(id, CLAP_PLUGIN_FACTORY_ID.to_bytes_with_nul()) {
        return &FACTORY.0 as *const clap_plugin_factory as *const c_void;
    }
    null()
}

/// The one symbol a CLAP host looks for in the shared library.
#[allow(non_upper_case_globals)]
#[no_mangle]
pub static clap_entry: clap_plugin_entry = clap_plugin_entry {
    clap_version: CLAP_VERSION,
    init: Some(entry_init),
    deinit: Some(entry_deinit),
    get_factory: Some(entry_get_factory),
};
