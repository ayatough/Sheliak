//! Hosting a CLAP plugin, which is the reason this crate exists.
//!
//! A `.clap` is a dynamic library. It cannot be loaded in a browser tab, so
//! everything Sheliak does in the browser is closed to it and the native
//! renderer is the only door — see [workstreams §9](../../docs/workstreams.md).
//!
//! What is hosted here is an **effect on the mix**: the rendered stereo bus goes
//! through the plugin and comes back. That is the smallest thing that proves the
//! door opens, and it is deliberately not wired to the notation. §7 holds the
//! `fx` fence back until a host exists precisely so the notation can be written
//! against a plugin that really loads, rather than against a guess; this is the
//! plugin that really loads, and the fence comes after.
//!
//! # What a plugin costs the guarantees
//!
//! Determinism is a non-negotiable for Sheliak's own engine and cannot be one
//! for somebody else's code: a plugin may read a clock, use an unseeded RNG, or
//! dispatch on CPU features. Nothing here can check that. A render that went
//! through a plugin is reproducible against *that build of that plugin* and
//! nothing weaker, which is the `pinned` class in §4 and why it exists.
//!
//! Parameters are not touched. The plugin runs at its own defaults, because
//! Sheliak has nowhere yet to write a plugin's parameters down — §3 settled that
//! they will be written as parameters and never as an opaque state blob, and
//! until the fence can carry them, defaults are the honest thing to use.

use clack_host::events::io::{EventBuffer, InputEvents, OutputEvents};
use clack_host::prelude::*;

/// The block the plugin is driven with, matching the engine's render quantum.
const BLOCK: usize = 128;

/// Sheliak asks nothing of its plugins, so every callback is a no-op.
///
/// A plugin may ask to be restarted, to be processed, or for a main-thread
/// callback. In a live host those matter. In an offline render there is no
/// transport to restart and no idle loop to run a callback on, and a plugin that
/// needs one to produce correct audio is a plugin this renderer cannot serve
/// correctly — better to be plain about that than to pretend.
struct SheliakShared;

impl<'a> SharedHandler<'a> for SheliakShared {
    fn request_restart(&self) {}
    fn request_process(&self) {}
    fn request_callback(&self) {}
}

struct SheliakHost;

impl HostHandlers for SheliakHost {
    type Shared<'a> = SheliakShared;
    type MainThread<'a> = ();
    type AudioProcessor<'a> = ();
}

/// A loaded plugin, ready to process the mix.
pub struct HostedPlugin {
    /// The plugin's own name, for the report.
    pub name: String,
    /// Its reverse-domain id, which is what a document would have to name.
    pub id: String,
    /// `Option` only so that `Drop` can take it: deactivation consumes it.
    processor: Option<PluginAudioProcessor<SheliakHost>>,
    instance: PluginInstance<SheliakHost>,
    /// The library has to outlive everything taken out of it. Declared last so
    /// it is dropped last.
    _entry: PluginEntry,
}

/// Everything a `.clap` bundle offers, for `--list-clap`.
pub fn describe(path: &str) -> Result<Vec<(String, String)>, String> {
    // SAFETY: none available. Loading a `.clap` runs its initialiser, which is
    // arbitrary native code from outside this repository; clack marks it unsafe
    // because no wrapper can make that safe. The user named the file.
    let entry =
        unsafe { PluginEntry::load(path) }.map_err(|e| format!("cannot load {path}: {e}"))?;
    let factory = entry
        .get_plugin_factory()
        .ok_or_else(|| format!("{path} has no plugin factory — it is not a CLAP bundle"))?;
    Ok(factory
        .plugin_descriptors()
        .map(|d| {
            let id = d
                .id()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = d
                .name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            (id, name)
        })
        .collect())
}

impl HostedPlugin {
    /// Loads a plugin and activates it for `sample_rate`.
    ///
    /// `wanted` picks one by id when a bundle carries several — `lsp-plugins-clap.clap`
    /// carries hundreds. Without it the first descriptor is used, which is the
    /// right guess for a bundle that holds exactly one.
    pub fn load(path: &str, wanted: Option<&str>, sample_rate: f32) -> Result<Self, String> {
        // SAFETY: see `describe`. This runs third-party native code by design.
        let entry =
            unsafe { PluginEntry::load(path) }.map_err(|e| format!("cannot load {path}: {e}"))?;
        let factory = entry
            .get_plugin_factory()
            .ok_or_else(|| format!("{path} has no plugin factory — it is not a CLAP bundle"))?;

        let descriptor = match wanted {
            Some(id) => factory
                .plugin_descriptors()
                .find(|d| {
                    d.id()
                        .map(|s| s.to_bytes() == id.as_bytes())
                        .unwrap_or(false)
                })
                .ok_or_else(|| {
                    format!("{path} has no plugin with id \"{id}\" (try --list-clap)")
                })?,
            None => factory
                .plugin_descriptors()
                .next()
                .ok_or_else(|| format!("{path} declares no plugins at all"))?,
        };

        let id = descriptor
            .id()
            .ok_or("the plugin descriptor has no id")?
            .to_owned();
        let name = descriptor
            .name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.to_string_lossy().into_owned());

        let host_info = HostInfo::new(
            "Sheliak",
            "Sheliak",
            "https://github.com/ayatough/Sheliak",
            "0.1.0",
        )
        .map_err(|e| format!("host info rejected: {e}"))?;

        let mut instance =
            PluginInstance::<SheliakHost>::new(|_| SheliakShared, |_| (), &entry, &id, &host_info)
                .map_err(|e| format!("cannot instantiate {name}: {e}"))?;

        // Activation is where a plugin sizes its own buffers, so it has to be
        // told the largest block it will ever see.
        let config = PluginAudioConfiguration {
            sample_rate: sample_rate as f64,
            min_frames_count: 1,
            max_frames_count: BLOCK as u32,
        };
        let processor = instance
            .activate(|_, _| (), config)
            .map_err(|e| format!("cannot activate {name}: {e}"))?;

        Ok(HostedPlugin {
            name,
            id: id.to_string_lossy().into_owned(),
            processor: Some(processor.into()),
            instance,
            _entry: entry,
        })
    }

    /// Runs the whole mix through the plugin, in place.
    ///
    /// Latency is not compensated. A plugin that reports latency will shift the
    /// result by that many samples, which for a reverb is nothing and for a
    /// look-ahead limiter is audible; compensating it is a real feature and it
    /// belongs with the notation that can express a plugin at all, not here.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> Result<(), String> {
        let processor = self
            .processor
            .as_mut()
            .ok_or("the plugin has already been deactivated")?;
        processor
            .ensure_processing_started()
            .map_err(|e| format!("{} refused to start processing: {e}", self.name))?;

        let mut in_ports = AudioPorts::with_capacity(2, 1);
        let mut out_ports = AudioPorts::with_capacity(2, 1);
        let mut out_events = EventBuffer::new();
        let mut in_l = [0.0f32; BLOCK];
        let mut in_r = [0.0f32; BLOCK];
        let mut out_l = [0.0f32; BLOCK];
        let mut out_r = [0.0f32; BLOCK];

        let total = l.len().min(r.len());
        let mut at = 0;
        while at < total {
            let n = BLOCK.min(total - at);
            in_l[..n].copy_from_slice(&l[at..at + n]);
            in_r[..n].copy_from_slice(&r[at..at + n]);
            out_l[..n].fill(0.0);
            out_r[..n].fill(0.0);
            out_events.clear();

            let mut input_channels = [&mut in_l[..n], &mut in_r[..n]];
            let input_audio = in_ports.with_input_buffers([AudioPortBuffer {
                latency: 0,
                channels: AudioPortBufferType::f32_input_only(
                    input_channels
                        .iter_mut()
                        .map(|b| InputChannel::variable(*b)),
                ),
            }]);
            let mut output_channels = [&mut out_l[..n], &mut out_r[..n]];
            let mut output_audio = out_ports.with_output_buffers([AudioPortBuffer {
                latency: 0,
                channels: AudioPortBufferType::f32_output_only(
                    output_channels.iter_mut().map(|b| &mut **b),
                ),
            }]);

            // Nothing is sent in: this hosts an effect on the mix, and the
            // notation has no way to address a plugin's parameters yet (§7).
            let input_events = InputEvents::empty();
            let mut output_events = OutputEvents::from_buffer(&mut out_events);

            processor
                .ensure_processing_started()
                .map_err(|e| format!("{} stopped processing early: {e}", self.name))?
                .process(
                    &input_audio,
                    &mut output_audio,
                    &input_events,
                    &mut output_events,
                    None,
                    None,
                )
                .map_err(|e| format!("{} failed while processing: {e}", self.name))?;

            l[at..at + n].copy_from_slice(&out_l[..n]);
            r[at..at + n].copy_from_slice(&out_r[..n]);
            at += n;
        }

        processor.ensure_processing_stopped();
        Ok(())
    }
}

impl Drop for HostedPlugin {
    fn drop(&mut self) {
        // Deactivation has to happen on the main thread and before the instance
        // goes; a plugin that de-allocates in its audio processor would
        // otherwise do it at a moment nobody chose.
        if let Some(processor) = self.processor.take() {
            self.instance.deactivate(processor.into_stopped());
        }
    }
}
