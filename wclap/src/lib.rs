//! Sheliak's own effects, wearing the CLAP ABI, built for wasm32 — a WCLAP.
//!
//! # Why this crate exists before any third-party plugin does
//!
//! docs/workstreams.md §8 puts the ordering first: *compile one of Sheliak's
//! own effects to a `.wclap` and run it through the host before any
//! third-party binary is involved*. A commercial plugin as the first test
//! subject means debugging the host and the plugin at once, with no reference
//! for what the right answer was. This module is the reference. Its DSP is the
//! same [`Dist`] the engine runs, so "did the plugin path change the sound?"
//! has an exact answer rather than an opinion.
//!
//! # What the browser needs from a module, and where each part is
//!
//! The draft asks a WCLAP for four things. Three of them come out of the build
//! rather than the source:
//!
//! * **exported memory** — `wasm32-unknown-unknown` exports its own, and it is
//!   an ordinary `ArrayBuffer`, so hosting it needs no cross-origin isolation;
//! * **exactly one growable function table** — `-C link-arg=--export-table`,
//!   see `scripts/build-wclap.sh`. The host grows it to install its own
//!   callbacks, which is the only way a JS function can become something the
//!   plugin can call;
//! * **`clap_entry`, a global holding the address of a `clap_plugin_entry`** —
//!   a `#[no_mangle] pub static` is exactly that. A Rust static cannot
//!   initialise a *wasm global* to another static's address, which is what
//!   §8 recorded as open; the answer is that it does not have to, because
//!   wasm-ld exports a data symbol as a global whose value is its address.
//!
//! The fourth is [`alloc::malloc`], and it is here because a host that lives
//! outside the module's address space cannot make room in it by itself.
//!
//! # Adding another effect
//!
//! [`MODELS`] is the list. An entry is a descriptor, a parameter table and a
//! constructor; nothing below it is per-effect. The parameter table is the
//! only place that has to be written by hand, and it is the same information
//! `web/src/dsl/fx.ts` already holds for the internal path — a name, a range,
//! a default and an offset into the effect's own block.

pub mod alloc;
mod layout;

use core::ffi::{c_char, c_void};
use std::ffi::CStr;
use std::ptr::{null, null_mut};

use clap_sys::entry::clap_plugin_entry;
use clap_sys::events::{
    clap_event_header, clap_event_param_value, clap_input_events, clap_output_events,
    CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE,
};
use clap_sys::ext::audio_ports::{
    clap_audio_port_info, clap_plugin_audio_ports, CLAP_AUDIO_PORT_IS_MAIN, CLAP_EXT_AUDIO_PORTS,
    CLAP_PORT_STEREO,
};
use clap_sys::ext::params::{
    clap_param_info, clap_plugin_params, CLAP_EXT_PARAMS, CLAP_PARAM_IS_AUTOMATABLE,
    CLAP_PARAM_IS_ENUM, CLAP_PARAM_IS_STEPPED,
};
use clap_sys::factory::plugin_factory::{clap_plugin_factory, CLAP_PLUGIN_FACTORY_ID};
use clap_sys::host::clap_host;
use clap_sys::id::clap_id;
use clap_sys::plugin::{clap_plugin, clap_plugin_descriptor};
use clap_sys::process::{clap_process, clap_process_status, CLAP_PROCESS_CONTINUE};
use clap_sys::version::CLAP_VERSION;

use sheliak_dsp::fx::dist::Dist;
use sheliak_dsp::fx::Effect;
use sheliak_dsp::params::{
    DIST_DRIVE, DIST_MIX, DIST_MODE, DIST_TONE_HZ, FX_SLOT_STRIDE, MAX_BLOCK,
};

// --------------------------------------------------------------- descriptors

/// A NUL-terminated literal as a C string pointer, usable in a `static`.
const fn cstr(bytes: &'static [u8]) -> *const c_char {
    bytes.as_ptr() as *const c_char
}

/// One parameter, in the two vocabularies at once: CLAP's (an id, a range, a
/// default) and the effect's (an index into its own block).
struct ParamDesc {
    id: clap_id,
    name: &'static [u8],
    /// Index into the effect's `FX_SLOT_STRIDE`-long parameter block. The CLAP
    /// value *is* the block value — no unit conversion happens anywhere here,
    /// because the DSP core does not know units (non-negotiable 1).
    offset: usize,
    min: f64,
    max: f64,
    default: f64,
    /// Whole numbers only, and each one is a name rather than a quantity.
    enumerated: Option<&'static [&'static [u8]]>,
}

impl ParamDesc {
    fn flags(&self) -> u32 {
        let mut f = CLAP_PARAM_IS_AUTOMATABLE;
        if self.enumerated.is_some() {
            f |= CLAP_PARAM_IS_STEPPED | CLAP_PARAM_IS_ENUM;
        }
        f
    }
}

/// A plugin this module can make.
struct Model {
    descriptor: clap_plugin_descriptor,
    params: &'static [ParamDesc],
    make: fn(f32) -> Box<dyn Effect>,
}

/// Raw pointers into `'static` string data. Immutable for the life of the
/// module, and the module is single-threaded by construction — an
/// AudioWorklet render thread, exactly as `dsp/src/lib.rs` documents.
struct Statics<T>(T);
unsafe impl<T> Sync for Statics<T> {}

static DIST_MODE_NAMES: [&[u8]; 3] = [b"Tanh\0", b"Fold\0", b"Clip\0"];

static DIST_PARAMS: [ParamDesc; 4] = [
    ParamDesc {
        id: 0,
        name: b"Drive\0",
        offset: DIST_DRIVE,
        min: 0.0,
        max: 1.0,
        default: 0.3,
        enumerated: None,
    },
    ParamDesc {
        id: 1,
        name: b"Mix\0",
        offset: DIST_MIX,
        min: 0.0,
        max: 1.0,
        default: 1.0,
        enumerated: None,
    },
    ParamDesc {
        id: 2,
        name: b"Mode\0",
        offset: DIST_MODE,
        min: 0.0,
        max: 2.0,
        default: 0.0,
        enumerated: Some(&DIST_MODE_NAMES),
    },
    ParamDesc {
        id: 3,
        name: b"Tone\0",
        offset: DIST_TONE_HZ,
        min: 20.0,
        max: 20_000.0,
        default: 20_000.0,
        enumerated: None,
    },
];

static DIST_FEATURES: Statics<[*const c_char; 4]> = Statics([
    cstr(b"audio-effect\0"),
    cstr(b"distortion\0"),
    cstr(b"stereo\0"),
    null(),
]);

/// Every plugin this module offers, in factory order.
static MODELS: Statics<[Model; 1]> = Statics([Model {
    descriptor: clap_plugin_descriptor {
        clap_version: CLAP_VERSION,
        id: cstr(b"io.github.ayatough.sheliak.dist\0"),
        name: cstr(b"Sheliak Distortion\0"),
        vendor: cstr(b"Sheliak\0"),
        url: cstr(b"https://github.com/ayatough/Sheliak\0"),
        manual_url: cstr(b"https://github.com/ayatough/Sheliak\0"),
        support_url: cstr(b"https://github.com/ayatough/Sheliak/issues\0"),
        version: cstr(b"0.1.0\0"),
        description: cstr(b"The distortion from Sheliak's own effect chain.\0"),
        features: DIST_FEATURES.0.as_ptr(),
    },
    params: &DIST_PARAMS,
    make: |sample_rate| Box::new(Dist::new(sample_rate)),
}]);

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
    // Terminate whether or not `src` fitted: past the copy this byte was
    // whatever the host left there.
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
    model: &'static Model,
    /// The effect's own parameter block — the same numbers, at the same
    /// offsets, that the engine writes into a track's patch.
    block: [f32; FX_SLOT_STRIDE],
    /// Built at `activate()`, where the sample rate is finally known, and
    /// dropped at `deactivate()`. Allocation lives here and nowhere else.
    effect: Option<Box<dyn Effect>>,
    sample_rate: f32,
    /// The next `apply_patch` snaps its smoothers instead of ramping them.
    first: bool,
    /// A right channel for a mono port, so a host that gives us one channel
    /// still gets processed audio instead of silence or a bypass.
    scratch: Vec<f32>,
}

impl Instance {
    /// Applies one event, ignoring anything that is not a parameter change in
    /// the core event space — an unknown event is not an error.
    ///
    /// # Safety
    ///
    /// `header` must point at a complete event of the size it declares.
    unsafe fn event(&mut self, header: *const clap_event_header) {
        if (*header).space_id != CLAP_CORE_EVENT_SPACE_ID
            || (*header).type_ != CLAP_EVENT_PARAM_VALUE
        {
            return;
        }
        let ev = header as *const clap_event_param_value;
        let id = (*ev).param_id;
        let Some(p) = self.model.params.iter().find(|p| p.id == id) else {
            return;
        };
        self.block[p.offset] = (*ev).value.clamp(p.min, p.max) as f32;
    }

    /// Runs `frames` of the two channels, in place, with the current block.
    fn run(&mut self, l: &mut [f32], r: &mut [f32]) {
        let Some(effect) = self.effect.as_mut() else {
            return;
        };
        effect.apply_patch(&self.block, self.sample_rate, self.first);
        self.first = false;
        effect.run(l, r, self.sample_rate);
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
    max_frames: u32,
) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    inst.sample_rate = sample_rate as f32;
    inst.effect = Some((inst.model.make)(inst.sample_rate));
    inst.first = true;
    inst.scratch = vec![0.0; max_frames.max(MAX_BLOCK as u32) as usize];
    true
}

unsafe extern "C" fn plugin_deactivate(plugin: *const clap_plugin) {
    if let Some(inst) = instance(plugin) {
        inst.effect = None;
        inst.scratch = Vec::new();
    }
}

unsafe extern "C" fn plugin_start_processing(_plugin: *const clap_plugin) -> bool {
    true
}

unsafe extern "C" fn plugin_stop_processing(_plugin: *const clap_plugin) {}

unsafe extern "C" fn plugin_reset(plugin: *const clap_plugin) {
    if let Some(inst) = instance(plugin) {
        if let Some(effect) = inst.effect.as_mut() {
            effect.reset();
        }
        inst.first = true;
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
    if cstr_is(id, CLAP_EXT_PARAMS.to_bytes_with_nul()) {
        return &PARAMS.0 as *const clap_plugin_params as *const c_void;
    }
    null()
}

/// The audio half of `process`, kept out of the event loop below.
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

    // In-place is allowed and is what `in_place_pair` advertises, so copying
    // is conditional on the host having given us distinct buffers.
    if p.audio_inputs_count > 0 {
        if let Some((in_l, in_r)) = channels(p.audio_inputs, frames) {
            if in_l != out_l {
                out_l.copy_from_nonoverlapping(in_l, frames);
            }
            if let (Some(ir), Some(or)) = (in_r, out_r) {
                if ir != or {
                    or.copy_from_nonoverlapping(ir, frames);
                }
            }
        }
    }
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

    let mut next = 0u32;
    let mut frame = 0usize;
    while frame < frames {
        // Everything due at or before this frame, in order.
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

        // Stop at the next event so its value lands on the exact sample.
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
        match out_r {
            Some(r) => {
                let r = std::slice::from_raw_parts_mut(r.add(frame), n);
                inst.run(l, r);
            }
            None => {
                // Mono: the effect needs two channels, so the second one is
                // scratch and its result is thrown away.
                if inst.scratch.len() < n {
                    inst.scratch.resize(n, 0.0);
                }
                let mut scratch = std::mem::take(&mut inst.scratch);
                scratch[..n].copy_from_slice(l);
                inst.run(l, &mut scratch[..n]);
                inst.scratch = scratch;
            }
        }
        frame = end;
    }

    CLAP_PROCESS_CONTINUE
}

// ------------------------------------------------------------- audio-ports ext

unsafe extern "C" fn ports_count(_plugin: *const clap_plugin, _is_input: bool) -> u32 {
    1
}

unsafe extern "C" fn ports_get(
    _plugin: *const clap_plugin,
    index: u32,
    is_input: bool,
    info: *mut clap_audio_port_info,
) -> bool {
    if index != 0 || info.is_null() {
        return false;
    }
    let info = &mut *info;
    info.id = 0;
    info.flags = CLAP_AUDIO_PORT_IS_MAIN;
    info.channel_count = 2;
    info.port_type = CLAP_PORT_STEREO.as_ptr();
    // Both ports carry id 0, so this says "in-place with the other side's
    // port 0" — which `plugin_process` handles by skipping the copy.
    info.in_place_pair = 0;
    write_name(
        &mut info.name,
        if is_input { b"Input\0" } else { b"Output\0" },
    );
    true
}

static AUDIO_PORTS: Statics<clap_plugin_audio_ports> = Statics(clap_plugin_audio_ports {
    count: Some(ports_count),
    get: Some(ports_get),
});

// ------------------------------------------------------------------ params ext

unsafe extern "C" fn params_count(plugin: *const clap_plugin) -> u32 {
    instance(plugin).map_or(0, |inst| inst.model.params.len() as u32)
}

unsafe extern "C" fn params_get_info(
    plugin: *const clap_plugin,
    index: u32,
    info: *mut clap_param_info,
) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    let Some(desc) = inst.model.params.get(index as usize) else {
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
    let Some(desc) = inst.model.params.iter().find(|p| p.id == id) else {
        return false;
    };
    if out.is_null() {
        return false;
    }
    *out = inst.block[desc.offset] as f64;
    true
}

unsafe extern "C" fn params_value_to_text(
    plugin: *const clap_plugin,
    id: clap_id,
    value: f64,
    out: *mut c_char,
    capacity: u32,
) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    let Some(desc) = inst.model.params.iter().find(|p| p.id == id) else {
        return false;
    };
    let text = match desc.enumerated {
        Some(names) => {
            let i = value.round().clamp(0.0, (names.len() - 1) as f64) as usize;
            String::from_utf8_lossy(&names[i][..names[i].len() - 1]).into_owned()
        }
        // Two decimals for a 0..1 control, none for anything measured in Hz.
        None if desc.max <= 1.0 => format!("{value:.2}"),
        None => format!("{value:.0}"),
    };
    write_text(&text, out, capacity)
}

unsafe extern "C" fn params_text_to_value(
    plugin: *const clap_plugin,
    id: clap_id,
    text: *const c_char,
    out: *mut f64,
) -> bool {
    let Some(inst) = instance(plugin) else {
        return false;
    };
    let Some(desc) = inst.model.params.iter().find(|p| p.id == id) else {
        return false;
    };
    if text.is_null() || out.is_null() {
        return false;
    }
    let Ok(text) = CStr::from_ptr(text).to_str() else {
        return false;
    };
    let text = text.trim();
    if let Some(names) = desc.enumerated {
        for (i, name) in names.iter().enumerate() {
            let name = &name[..name.len() - 1];
            if text.as_bytes().eq_ignore_ascii_case(name) {
                *out = i as f64;
                return true;
            }
        }
    }
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

static PARAMS: Statics<clap_plugin_params> = Statics(clap_plugin_params {
    count: Some(params_count),
    get_info: Some(params_get_info),
    get_value: Some(params_get_value),
    value_to_text: Some(params_value_to_text),
    text_to_value: Some(params_text_to_value),
    flush: Some(params_flush),
});

// ----------------------------------------------------------------- factory

unsafe extern "C" fn factory_count(_factory: *const clap_plugin_factory) -> u32 {
    MODELS.0.len() as u32
}

unsafe extern "C" fn factory_descriptor(
    _factory: *const clap_plugin_factory,
    index: u32,
) -> *const clap_plugin_descriptor {
    match MODELS.0.get(index as usize) {
        Some(model) => &model.descriptor,
        None => null(),
    }
}

unsafe extern "C" fn factory_create(
    _factory: *const clap_plugin_factory,
    _host: *const clap_host,
    id: *const c_char,
) -> *const clap_plugin {
    let Some(model) = MODELS
        .0
        .iter()
        .find(|m| cstr_is(id, CStr::from_ptr(m.descriptor.id).to_bytes_with_nul()))
    else {
        return null();
    };

    let mut block = [0.0f32; FX_SLOT_STRIDE];
    for p in model.params {
        block[p.offset] = p.default as f32;
    }

    let instance = Box::new(Instance {
        clap: clap_plugin {
            desc: &model.descriptor,
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
        model,
        block,
        effect: None,
        sample_rate: 48_000.0,
        first: true,
        scratch: Vec::new(),
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

/// The one symbol a host looks for. On wasm32 it is an exported *global*
/// holding this struct's address; on a native build it is an ordinary
/// exported symbol. Both are what a CLAP host expects to find.
#[allow(non_upper_case_globals)]
#[no_mangle]
pub static clap_entry: clap_plugin_entry = clap_plugin_entry {
    clap_version: CLAP_VERSION,
    init: Some(entry_init),
    deinit: Some(entry_deinit),
    get_factory: Some(entry_get_factory),
};
