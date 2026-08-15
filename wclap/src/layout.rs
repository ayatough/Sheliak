//! The struct layouts `web/src/audio/wclap.ts` hard-codes, asserted here.
//!
//! The browser host reads and writes CLAP structs at byte offsets, because a C
//! ABI without a C compiler is exactly that: numbers. Those numbers are the
//! same kind of duplicate as `dsp/src/params.rs` and
//! `web/src/shared/params.ts` — one fact written twice, in two languages that
//! cannot see each other.
//!
//! Every assertion below is a `const`, so **building the module is the check**:
//! if `clap-sys` moves a field, `scripts/build-wclap.sh` fails with the name of
//! the field rather than the browser reading a plugin's name as gibberish.
//!
//! They only hold on a 32-bit target — 4-byte pointers, 8-byte `f64`
//! alignment — which is the only kind of target a WCLAP is. On a 64-bit build
//! (`cargo test`, `cargo clippy`) the module compiles with nothing in it.

#![cfg(target_pointer_width = "32")]

use core::mem::{offset_of, size_of};

use clap_sys::audio_buffer::clap_audio_buffer;
use clap_sys::entry::clap_plugin_entry;
use clap_sys::events::{clap_event_header, clap_event_param_value, clap_input_events};
use clap_sys::ext::audio_ports::{clap_audio_port_info, clap_plugin_audio_ports};
use clap_sys::ext::params::{clap_param_info, clap_plugin_params};
use clap_sys::factory::plugin_factory::clap_plugin_factory;
use clap_sys::host::clap_host;
use clap_sys::plugin::{clap_plugin, clap_plugin_descriptor};
use clap_sys::process::clap_process;

macro_rules! layout {
    ($($struct:ty { $($field:ident => $offset:literal),* $(,)? } size $size:literal;)*) => {
        $(
            $(
                const _: () = assert!(
                    offset_of!($struct, $field) == $offset,
                    concat!(stringify!($struct), ".", stringify!($field),
                            " moved — web/src/audio/wclap.ts says otherwise"),
                );
            )*
            const _: () = assert!(
                size_of::<$struct>() == $size,
                concat!("sizeof ", stringify!($struct),
                        " changed — web/src/audio/wclap.ts says otherwise"),
            );
        )*
    };
}

layout! {
    clap_plugin_entry { init => 12, deinit => 16, get_factory => 20 } size 24;
    clap_plugin_factory {
        get_plugin_count => 0, get_plugin_descriptor => 4, create_plugin => 8,
    } size 12;
    clap_plugin_descriptor {
        id => 12, name => 16, vendor => 20, url => 24, manual_url => 28,
        support_url => 32, version => 36, description => 40, features => 44,
    } size 48;
    clap_plugin {
        desc => 0, plugin_data => 4, init => 8, destroy => 12, activate => 16,
        deactivate => 20, start_processing => 24, stop_processing => 28, reset => 32,
        process => 36, get_extension => 40, on_main_thread => 44,
    } size 48;
    clap_host {
        host_data => 12, name => 16, vendor => 20, url => 24, version => 28,
        get_extension => 32, request_restart => 36, request_process => 40,
        request_callback => 44,
    } size 48;
    clap_process {
        steady_time => 0, frames_count => 8, transport => 12, audio_inputs => 16,
        audio_outputs => 20, audio_inputs_count => 24, audio_outputs_count => 28,
        in_events => 32, out_events => 36,
    } size 40;
    clap_audio_buffer {
        data32 => 0, data64 => 4, channel_count => 8, latency => 12, constant_mask => 16,
    } size 24;
    clap_input_events { ctx => 0, size => 4, get => 8 } size 12;
    clap_event_header { size => 0, time => 4, space_id => 8, type_ => 10, flags => 12 } size 16;
    clap_event_param_value {
        param_id => 16, cookie => 20, note_id => 24, port_index => 28, channel => 30,
        key => 32, value => 40,
    } size 48;
    clap_param_info {
        id => 0, flags => 4, cookie => 8, name => 12, module => 268, min_value => 1296,
        max_value => 1304, default_value => 1312,
    } size 1320;
    clap_audio_port_info {
        id => 0, name => 4, flags => 260, channel_count => 264, port_type => 268,
        in_place_pair => 272,
    } size 276;
    clap_plugin_audio_ports { count => 0, get => 4 } size 8;
    clap_plugin_params {
        count => 0, get_info => 4, get_value => 8, value_to_text => 12,
        text_to_value => 16, flush => 20,
    } size 24;
}
