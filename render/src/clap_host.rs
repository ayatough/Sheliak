//! Hosting a CLAP plugin, which is the reason this crate exists.
//!
//! A `.clap` is a dynamic library. It cannot be loaded in a browser tab, so
//! everything Sheliak does in the browser is closed to it and the native
//! renderer is the only door — see [workstreams §9](../../docs/workstreams.md).
//!
//! Two kinds of plugin are hosted, and they are driven differently. An
//! **effect on the mix** takes the rendered stereo bus and gives it back
//! ([`HostedPlugin::process`]). An **instrument** declares no audio input at
//! all: it is a track's voice, fed the track's notes and nothing else, and
//! Sheliak's engine does not run for that track ([`HostedPlugin::render_notes`],
//! workstreams §13). Neither is wired to the notation yet. §7 holds the fence
//! back until a host exists precisely so the notation can be written against a
//! plugin that really loads, rather than against a guess; these are the plugins
//! that really load, and the fence comes after.
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

use std::path::PathBuf;

use clack_extensions::audio_ports::{AudioPortInfoBuffer, PluginAudioPorts};
use clack_extensions::note_ports::{NoteDialect, NotePortInfoBuffer, PluginNotePorts};
use clack_extensions::params::{ParamInfoBuffer, PluginParams};
use clack_host::events::event_types::{MidiEvent, NoteOffEvent, NoteOnEvent, ParamValueEvent};
use clack_host::events::io::{EventBuffer, InputEvents, OutputEvents};
use clack_host::events::{Match, Pckn};
use clack_host::prelude::*;
use clack_host::utils::{ClapId, Cookie};

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

/// A loaded plugin, ready to process the mix or play a track.
pub struct HostedPlugin {
    /// The plugin's own name, for the report.
    pub name: String,
    /// Its reverse-domain id, which is what a document would have to name.
    pub id: String,
    /// Channel count of every declared input port, in port order. Empty for an
    /// instrument — that emptiness is what decides how it may be driven.
    in_channels: Vec<u32>,
    /// Channel count of every declared output port, in port order.
    out_channels: Vec<u32>,
    /// How many note-input ports it declares; `None` when the note-ports
    /// extension is absent, which is how an effect says it wants no notes.
    note_in: Option<u32>,
    /// The dialect notes will be sent in, settled once at load: the port's
    /// preference when this host speaks it, else CLAP events, else MIDI 1.0.
    note_dialect: Option<NoteDialect>,
    /// Every parameter the plugin declares, read once at load.
    params: Vec<ParamDesc>,
    /// Settings resolved from a document, sent at frame 0 of the first block.
    pending: Vec<(ClapId, f64)>,
    /// `Option` only so that `Drop` can take it: deactivation consumes it.
    processor: Option<PluginAudioProcessor<SheliakHost>>,
    instance: PluginInstance<SheliakHost>,
    /// The library has to outlive everything taken out of it. Declared last so
    /// it is dropped last.
    _entry: PluginEntry,
}

/// What one plugin says about itself, without being instantiated.
pub struct Described {
    pub id: String,
    pub name: String,
    /// CLAP's own words for what it is. `instrument` and `audio-effect` are the
    /// two that decide how a host has to drive it.
    pub features: Vec<String>,
}

impl Described {
    /// Does it make sound from notes rather than from audio?
    pub fn is_instrument(&self) -> bool {
        self.features.iter().any(|f| f == "instrument")
    }
}

/// What a plugin needs from the host once it has been instantiated.
///
/// This is not decoration. An instrument declares **zero** audio inputs, and
/// handing one an input port anyway is a protocol violation that a plugin is
/// entitled to crash on — DPF's `Kars` trips an assertion and writes garbage.
/// A host that assumes stereo-in/stereo-out works only by luck.
pub struct Ports {
    pub audio_in: u32,
    pub audio_out: u32,
    /// `None` when the plugin does not implement the note-ports extension,
    /// which is how an effect says it wants no notes.
    pub note_in: Option<u32>,
}

/// One of a plugin's parameters, as it describes itself.
///
/// The name is the plugin's own display name — "Brightness", "Cutoff Freq" —
/// and it is the only handle a document has on it. CLAP's *ids* are stable and
/// the names are not guaranteed to be, but an id is a bare number that says
/// nothing to a reader, and a song is meant to be read. Matching by name is the
/// choice that keeps the document legible; a plugin that renames a parameter
/// between versions breaks the song loudly, which is the better failure.
#[derive(Clone, Debug)]
pub struct ParamDesc {
    pub id: ClapId,
    pub name: String,
    pub min: f64,
    pub max: f64,
    pub default: f64,
}

impl ParamDesc {
    /// How a document would write this name: lowercase, spaces as underscores.
    fn key(&self) -> String {
        self.name.trim().to_lowercase().replace([' ', '-'], "_")
    }
}

/// A parameter setting from a document, before it has been matched to a plugin.
#[derive(Clone, Debug)]
pub struct ParamSetting {
    /// The name as the document wrote it.
    pub name: String,
    /// `true` when the value is a position in the parameter's range, `false`
    /// when it is the plugin's own number.
    pub normalized: bool,
    pub value: f64,
}

/// One timed note for an instrument, at an absolute frame of the render.
///
/// This is the *other* shape from how the engine is driven: the engine splits
/// the block at every event boundary, whereas a CLAP event carries its offset
/// inside a whole block. The caller keeps the list sorted by frame.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct NoteEvent {
    pub frame: usize,
    /// `true` for note-on, `false` for note-off — the two kinds the job has.
    pub on: bool,
    /// MIDI key number, 0..=127.
    pub key: u8,
    /// Normalized 0..=1, as the notation writes it and as CLAP wants it.
    pub velocity: f32,
}

/// Where CLAP plugins live on this machine, most specific first.
///
/// A document names a plugin, not a file — `from=studio.kx.distrho.Kars` is a
/// property of the song, while `/usr/lib/clap/Kars.clap` is a property of the
/// machine reading it, and a song that carried the second would stop being
/// portable the moment somebody else opened it. So the path is searched.
///
/// `CLAP_PATH` is the format's own environment variable and comes first;
/// the rest are the standard Linux locations.
pub fn search_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(list) = std::env::var("CLAP_PATH") {
        dirs.extend(list.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    }
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".clap"));
    }
    dirs.push(PathBuf::from("/usr/lib/clap"));
    dirs.push(PathBuf::from("/usr/local/lib/clap"));
    dirs
}

/// Every `.clap` bundle on the search path, in the order it would be found.
fn bundles() -> Vec<PathBuf> {
    let mut found = Vec::new();
    for dir in search_path() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut here: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "clap"))
            .collect();
        // Within a directory, alphabetical: two machines with the same plugins
        // installed should resolve an id the same way.
        here.sort();
        found.extend(here);
    }
    found
}

/// Finds the bundle carrying `id`, searching [`search_path`].
///
/// A bundle that fails to load is skipped rather than fatal — one broken
/// plugin in a directory must not stop a song that does not use it.
pub fn find_by_id(id: &str) -> Result<PathBuf, String> {
    for path in bundles() {
        let Some(text) = path.to_str() else { continue };
        let Ok(found) = describe(text) else { continue };
        if found.iter().any(|p| p.id == id) {
            return Ok(path);
        }
    }
    Err(format!(
        "no plugin with id \"{id}\" is installed. Looked in {}. \
         `sheliak-render --list-clap <file.clap>` prints the ids a bundle carries",
        search_path()
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// Everything a `.clap` bundle offers, for `--list-clap`.
pub fn describe(path: &str) -> Result<Vec<Described>, String> {
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
        .map(|d| Described {
            id: d
                .id()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            name: d
                .name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            features: d
                .features()
                .map(|f| f.to_string_lossy().into_owned())
                .collect(),
        })
        .collect())
}

/// A note-on below full scale but above nothing, for the MIDI dialect. MIDI has
/// no zero-velocity note-on — that byte pattern *is* a note-off — so the floor
/// is 1.
fn midi_velocity(v: f32) -> u8 {
    ((v.clamp(0.0, 1.0) * 127.0).round() as u8).max(1)
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

        // The port layout comes from the plugin, not from assumption: `process`
        // must present exactly the ports a plugin declared, with their channel
        // counts. A plugin without the extension gets CLAP's baseline guess of
        // one stereo pair each way — the only case where guessing is all there is.
        let audio = instance.plugin_handle().get_extension::<PluginAudioPorts>();
        let (in_channels, out_channels) = match audio {
            Some(ext) => {
                let mut handle = instance.plugin_handle();
                let mut buffer = AudioPortInfoBuffer::new();
                let mut channels = |is_input: bool| -> Vec<u32> {
                    (0..ext.count(&mut handle, is_input))
                        .map(|i| {
                            ext.get(&mut handle, i, is_input, &mut buffer)
                                .map(|p| p.channel_count)
                                .unwrap_or(0)
                        })
                        .collect()
                };
                (channels(true), channels(false))
            }
            None => (vec![2], vec![2]),
        };

        let notes = instance.plugin_handle().get_extension::<PluginNotePorts>();
        let mut handle = instance.plugin_handle();
        let note_in = notes.map(|ext| ext.count(&mut handle, true));
        let note_dialect = match (notes, note_in) {
            (Some(ext), Some(n)) if n > 0 => {
                let mut buffer = NotePortInfoBuffer::new();
                ext.get(&mut handle, 0, true, &mut buffer).and_then(|info| {
                    // The port's preference wins when this host speaks it; the
                    // fallbacks are the two dialects a host must know anyway.
                    let speaks = |d: NoteDialect| info.supported_dialects.supports(d).then_some(d);
                    match info.preferred_dialect {
                        Some(d @ (NoteDialect::Clap | NoteDialect::Midi)) => Some(d),
                        _ => speaks(NoteDialect::Clap).or_else(|| speaks(NoteDialect::Midi)),
                    }
                })
            }
            _ => None,
        };

        let mut hosted = HostedPlugin {
            name,
            id: id.to_string_lossy().into_owned(),
            in_channels,
            out_channels,
            note_in,
            note_dialect,
            params: Vec::new(),
            pending: Vec::new(),
            processor: Some(processor.into()),
            instance,
            _entry: entry,
        };
        hosted.params = hosted.read_params();
        Ok(hosted)
    }

    /// Every parameter the plugin declares. A plugin without the params
    /// extension has none, which is not an error — it is a plugin with nothing
    /// to set.
    fn read_params(&mut self) -> Vec<ParamDesc> {
        let Some(ext) = self
            .instance
            .plugin_handle()
            .get_extension::<PluginParams>()
        else {
            return Vec::new();
        };
        let mut handle = self.instance.plugin_handle();
        let count = ext.count(&mut handle);
        let mut buffer = ParamInfoBuffer::new();
        let mut out = Vec::with_capacity(count as usize);
        for index in 0..count {
            let Some(info) = ext.get_info(&mut handle, index, &mut buffer) else {
                continue;
            };
            out.push(ParamDesc {
                id: info.id,
                name: String::from_utf8_lossy(info.name).trim().to_string(),
                min: info.min_value,
                max: info.max_value,
                default: info.default_value,
            });
        }
        out
    }

    /// What this plugin can be told, for `--list-clap --clap-id`.
    pub fn parameters(&self) -> &[ParamDesc] {
        &self.params
    }

    /// Resolves a document's settings against this plugin and queues them.
    ///
    /// Sent as events at frame 0 of the first block rather than flushed on the
    /// main thread, because that is the one moment guaranteed to be before any
    /// audio: a plugin is entitled to ignore a flush it receives while inactive.
    pub fn set_params(&mut self, settings: &[ParamSetting]) -> Result<(), String> {
        for setting in settings {
            let wanted = setting.name.trim().to_lowercase().replace([' ', '-'], "_");
            let Some(desc) = self.params.iter().find(|p| p.key() == wanted) else {
                return Err(format!(
                    "{} has no parameter \"{}\". It has {}",
                    self.name,
                    setting.name,
                    self.parameter_list()
                ));
            };
            let value = if setting.normalized {
                desc.min + setting.value * (desc.max - desc.min)
            } else {
                setting.value
            };
            let (lo, hi) = (desc.min.min(desc.max), desc.min.max(desc.max));
            if value < lo || value > hi {
                // Clamping would be a quieter answer and a worse one: a value
                // outside the range is almost always the wrong unit, and the
                // document should be corrected rather than silently obeyed.
                return Err(format!(
                    "{}: {} is {}, outside its range {}..{}",
                    self.name, desc.name, value, lo, hi
                ));
            }
            self.pending.push((desc.id, value));
        }
        Ok(())
    }

    /// The parameter names, for an error that has to be actionable.
    fn parameter_list(&self) -> String {
        if self.params.is_empty() {
            return "no parameters at all".to_string();
        }
        const SHOWN: usize = 12;
        let names: Vec<String> = self.params.iter().take(SHOWN).map(|p| p.key()).collect();
        if self.params.len() > SHOWN {
            format!(
                "{}, and {} more",
                names.join(", "),
                self.params.len() - SHOWN
            )
        } else {
            names.join(", ")
        }
    }

    /// The queued settings as events for the first block, and clears them.
    fn take_pending(&mut self) -> Vec<ParamValueEvent> {
        self.pending
            .drain(..)
            .map(|(id, value)| {
                ParamValueEvent::new(0, id, Pckn::match_all(), value, Cookie::empty())
            })
            .collect()
    }

    /// What this plugin declares it wants, as queried once at load.
    pub fn ports(&self) -> Ports {
        Ports {
            audio_in: self.in_channels.len() as u32,
            audio_out: self.out_channels.len() as u32,
            note_in: self.note_in,
        }
    }

    /// Runs the whole mix through the plugin, in place.
    ///
    /// Latency is not compensated. A plugin that reports latency will shift the
    /// result by that many samples, which for a reverb is nothing and for a
    /// look-ahead limiter is audible; compensating it is a real feature and it
    /// belongs with the notation that can express a plugin at all, not here.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> Result<(), String> {
        // An instrument declares no audio input, and feeding a port a plugin
        // never declared is a protocol violation rather than a harmless extra:
        // DPF's Kars trips an internal assertion and writes uninitialised frame
        // counts. It can play a track instead — that is the other door.
        if self.in_channels.is_empty() {
            return Err(format!(
                "{} is an instrument: it declares no audio input, {} note input(s), \
                 so it cannot go *on* the mix. Give it a track to play instead: \
                 --clap-instrument <plugin.clap> --clap-track <n>.",
                self.name,
                self.note_in.unwrap_or(0)
            ));
        }
        self.drive(l, r, &[])
    }

    /// Plays `notes` through an instrument, writing its output over `l`/`r`.
    ///
    /// `notes` are absolute frames into the buffers and must be sorted; each
    /// block is handed to the plugin whole, with the events that fall inside it
    /// carrying their offset from the block's start. Sample-accuracy is the
    /// plugin's own contract from there.
    pub fn render_notes(
        &mut self,
        notes: &[NoteEvent],
        l: &mut [f32],
        r: &mut [f32],
    ) -> Result<(), String> {
        if self.note_in.unwrap_or(0) == 0 {
            return Err(format!(
                "{} declares no note input, so it cannot play a track. \
                 An effect goes on the mix instead: --clap <plugin.clap>.",
                self.name
            ));
        }
        if self.note_dialect.is_none() {
            return Err(format!(
                "{} wants a note dialect this host does not speak \
                 (neither CLAP note events nor MIDI 1.0)",
                self.name
            ));
        }
        self.drive(l, r, notes)
    }

    /// One block loop for both ways of driving a plugin: input port 0 carries
    /// `l`/`r` when the plugin declares any input, `notes` become events at
    /// their in-block offsets, and output port 0 comes back as `l`/`r`.
    fn drive(&mut self, l: &mut [f32], r: &mut [f32], notes: &[NoteEvent]) -> Result<(), String> {
        // Taken before the destructure below borrows every field.
        let mut pending = self.take_pending();
        // Field-by-field so the processor's mutable borrow does not lock the
        // layout away.
        let Self {
            name,
            in_channels,
            out_channels,
            note_dialect,
            processor,
            ..
        } = self;
        let processor = processor
            .as_mut()
            .ok_or("the plugin has already been deactivated")?;
        processor
            .ensure_processing_started()
            .map_err(|e| format!("{name} refused to start processing: {e}"))?;

        if out_channels.is_empty() {
            return Err(format!("{name} declares no audio output at all"));
        }

        let mut in_ports = AudioPorts::with_capacity(
            in_channels.iter().map(|c| *c as usize).sum(),
            in_channels.len(),
        );
        let mut out_ports = AudioPorts::with_capacity(
            out_channels.iter().map(|c| *c as usize).sum(),
            out_channels.len(),
        );
        // One buffer per declared channel of every declared port. Ports beyond
        // the first stay silent — a sidechain gets nothing, honestly.
        let mut in_bufs: Vec<Vec<Vec<f32>>> = in_channels
            .iter()
            .map(|c| vec![vec![0.0; BLOCK]; *c as usize])
            .collect();
        let mut out_bufs: Vec<Vec<Vec<f32>>> = out_channels
            .iter()
            .map(|c| vec![vec![0.0; BLOCK]; *c as usize])
            .collect();
        let mut in_events = EventBuffer::new();
        let mut out_events = EventBuffer::new();

        let total = l.len().min(r.len());
        let mut at = 0;
        let mut next_note = 0usize;
        while at < total {
            let n = BLOCK.min(total - at);

            if let Some(port) = in_bufs.first_mut() {
                match port.as_mut_slice() {
                    // A mono input takes the mid signal; halving keeps a
                    // centred source at its own level.
                    [mono] => {
                        for i in 0..n {
                            mono[i] = 0.5 * (l[at + i] + r[at + i]);
                        }
                    }
                    [cl, cr, ..] => {
                        cl[..n].copy_from_slice(&l[at..at + n]);
                        cr[..n].copy_from_slice(&r[at..at + n]);
                    }
                    [] => {}
                }
            }
            for port in out_bufs.iter_mut() {
                for channel in port.iter_mut() {
                    channel[..n].fill(0.0);
                }
            }

            in_events.clear();
            // The document's settings, once, before the first note is heard.
            for event in pending.drain(..) {
                in_events.push(&event);
            }
            while next_note < notes.len() && notes[next_note].frame < at + n {
                let note = &notes[next_note];
                next_note += 1;
                let time = note.frame.saturating_sub(at) as u32;
                match note_dialect {
                    Some(NoteDialect::Clap) => {
                        let pckn = Pckn::new(0u16, 0u16, note.key as u16, Match::<u32>::All);
                        if note.on {
                            in_events.push(&NoteOnEvent::new(time, pckn, note.velocity as f64));
                        } else {
                            in_events.push(&NoteOffEvent::new(time, pckn, note.velocity as f64));
                        }
                    }
                    _ => {
                        // MIDI 1.0, the only other dialect `render_notes` lets
                        // through. Channel 0; the job has no channels to carry.
                        let data = if note.on {
                            [0x90, note.key.min(127), midi_velocity(note.velocity)]
                        } else {
                            [0x80, note.key.min(127), 0x40]
                        };
                        in_events.push(&MidiEvent::new(time, 0, data));
                    }
                }
            }
            out_events.clear();

            let input_audio = in_ports.with_input_buffers(in_bufs.iter_mut().map(|channels| {
                AudioPortBuffer {
                    latency: 0,
                    channels: AudioPortBufferType::f32_input_only(
                        channels
                            .iter_mut()
                            .map(|c| InputChannel::variable(&mut c[..n])),
                    ),
                }
            }));
            let mut output_audio =
                out_ports.with_output_buffers(out_bufs.iter_mut().map(|channels| {
                    AudioPortBuffer {
                        latency: 0,
                        channels: AudioPortBufferType::f32_output_only(
                            channels.iter_mut().map(|c| &mut c[..n]),
                        ),
                    }
                }));

            let input_events = InputEvents::from_buffer(&in_events);
            let mut output_events = OutputEvents::from_buffer(&mut out_events);

            processor
                .ensure_processing_started()
                .map_err(|e| format!("{name} stopped processing early: {e}"))?
                .process(
                    &input_audio,
                    &mut output_audio,
                    &input_events,
                    &mut output_events,
                    None,
                    None,
                )
                .map_err(|e| format!("{name} failed while processing: {e}"))?;

            match out_bufs.first().map(|port| port.as_slice()) {
                Some([mono]) => {
                    l[at..at + n].copy_from_slice(&mono[..n]);
                    r[at..at + n].copy_from_slice(&mono[..n]);
                }
                Some([cl, cr, ..]) => {
                    l[at..at + n].copy_from_slice(&cl[..n]);
                    r[at..at + n].copy_from_slice(&cr[..n]);
                }
                _ => return Err(format!("{name} has an output port with no channels")),
            }
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
