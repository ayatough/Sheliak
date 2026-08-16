//! The instrument: modal strings struck by a nonlinear felt hammer.
//!
//! # Why modal synthesis and not a finite-difference string
//!
//! A finite-difference scheme (the OpenPiano approach) discretises the string
//! in space and marches it in time. It is the more literal simulation, but it
//! buys that literalness with problems this plugin cannot afford: the grid
//! resolution — and with it the sound — depends on the sample rate, the
//! explicit scheme has a stability bound to respect, the cost per sample is
//! high enough that the reference implementation needs a thread pool, and the
//! treble runs out of grid points entirely. A modal string is the same
//! physics written in the frequency domain: each partial is one damped
//! resonator whose frequency, decay and coupling are set directly from the
//! string's physical parameters. It is unconditionally stable, costs the same
//! at every sample rate, and the partial series can be truncated where
//! hearing stops caring.
//!
//! The hammer is where the interesting nonlinearity lives, and it is kept as
//! real simulation: a mass with a nonlinear felt spring (`F = K·ξ^p`,
//! Chaigne & Askenfelt's power law) integrated against the string's actual
//! displacement at the strike point, sub-stepped for stability during the
//! millisecond or two of contact. Loud notes compress the felt further up its
//! stiffening curve, which shortens the force pulse and brightens the
//! spectrum — the velocity-to-timbre behaviour that makes a piano a piano,
//! obtained rather than programmed.
//!
//! # The resonator
//!
//! Each partial runs the "magic circle" recurrence
//! `q += e·v; v -= e·q` with `e = 2·sin(θ/2)`, `θ = ω/fs`, then multiplies
//! both states by a per-sample decay. The usual rotation form stores `cos θ`,
//! which for a bass fundamental sits so close to 1.0 that `f32` quantisation
//! detunes the note audibly; `e` is small exactly when `cos θ` is precise-
//! ness-starved, so the frequency survives single precision at every key.
//!
//! # Rules inherited from the engine next door
//!
//! No allocation happens in [`Piano::process`]; every voice's arrays exist
//! from [`Piano::new`] onward. Nothing here reads a clock or a random source
//! — the per-key variation in `keys.rs` is hashed from the key number — so
//! the same events at the same sample rate render the same samples.

use crate::keys::{key_scaling, stretch_cents, FIRST_KEY, LAST_KEY};

/// Simultaneous voices. A voice is one key strike; the same key struck twice
/// briefly uses two while the first fades.
pub const MAX_VOICES: usize = 24;

/// Resonators per voice: three strings of 72 partials in the tenor is the
/// widest layout `keys.rs` hands out.
const SLOTS: usize = 216;

/// Partials of the first string, the one the hammer's contact dynamics are
/// integrated against.
const EXC_SLOTS: usize = 128;

/// Hammer integration substeps per audio sample while in contact.
const HAMMER_SUBSTEPS: u32 = 8;

/// Per-sample extra decay while a voice is being faded out (a steal or a
/// restrike): about 40 ms to -60 dB at 48 kHz.
const FADE: f32 = 0.9985;

/// Output level such that a fortissimo single note peaks well under full
/// scale, leaving headroom for chords.
const OUTPUT_SCALE: f32 = 0.5;

/// A voice output quieter than this (mean |sample|) is over.
const SILENCE: f32 = 1.0e-7;

// Parameter ids — the CLAP wrapper exposes exactly these.
pub const P_GAIN_DB: u32 = 0;
pub const P_HARDNESS: u32 = 1;
pub const P_DETUNE: u32 = 2;
pub const P_BRIGHTNESS_HZ: u32 = 3;
pub const P_DECAY: u32 = 4;
pub const P_DAMPER_S: u32 = 5;
pub const P_STRETCH: u32 = 6;
pub const P_DYNAMICS: u32 = 7;
pub const P_SUSTAIN: u32 = 8;
pub const PARAM_COUNT: usize = 9;

/// The playing parameters, in their own units (the CLAP value is this value).
///
/// Gain, brightness and the pedal act on sounding notes; the rest are read at
/// note-on and shape the voice being built, like a technician's adjustments
/// between strikes rather than a knob on the sound.
pub struct Params {
    pub gain_db: f32,
    pub hardness: f32,
    pub detune: f32,
    pub brightness_hz: f32,
    pub decay: f32,
    pub damper_s: f32,
    pub stretch: f32,
    pub dynamics: f32,
    pub sustain: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            gain_db: 0.0,
            hardness: 0.5,
            detune: 1.0,
            brightness_hz: 7500.0,
            decay: 1.0,
            damper_s: 0.2,
            stretch: 1.0,
            dynamics: 0.5,
            sustain: 0.0,
        }
    }
}

impl Params {
    pub fn set(&mut self, id: u32, value: f64) {
        let v = value as f32;
        match id {
            P_GAIN_DB => self.gain_db = v.clamp(-24.0, 24.0),
            P_HARDNESS => self.hardness = v.clamp(0.0, 1.0),
            P_DETUNE => self.detune = v.clamp(0.0, 2.0),
            P_BRIGHTNESS_HZ => self.brightness_hz = v.clamp(500.0, 16000.0),
            P_DECAY => self.decay = v.clamp(0.25, 4.0),
            P_DAMPER_S => self.damper_s = v.clamp(0.05, 1.0),
            P_STRETCH => self.stretch = v.clamp(0.0, 2.0),
            P_DYNAMICS => self.dynamics = v.clamp(0.0, 1.0),
            P_SUSTAIN => self.sustain = if v >= 0.5 { 1.0 } else { 0.0 },
            _ => {}
        }
    }

    pub fn get(&self, id: u32) -> f64 {
        (match id {
            P_GAIN_DB => self.gain_db,
            P_HARDNESS => self.hardness,
            P_DETUNE => self.detune,
            P_BRIGHTNESS_HZ => self.brightness_hz,
            P_DECAY => self.decay,
            P_DAMPER_S => self.damper_s,
            P_STRETCH => self.stretch,
            P_DYNAMICS => self.dynamics,
            P_SUSTAIN => self.sustain,
            _ => 0.0,
        }) as f64
    }
}

/// The flying mass. Alive from note-on until it has struck and left.
struct Hammer {
    active: bool,
    /// Whether felt has touched string yet — a hammer that never connects is
    /// retired by a timeout instead of flying forever.
    contacted: bool,
    /// Position and velocity toward the string, in metres, string at rest = 0.
    h: f32,
    vh: f32,
    inv_mass: f32,
    k: f32,
    p: f32,
    /// Samples since note-on, for the timeout.
    age: u32,
    /// Force-free samples in a row after first contact. Once this exceeds
    /// `gap_limit` the strike is over and the hammer retires — the model's
    /// backcheck. Without it a treble hammer can bounce on the vibrating
    /// string in phase, pumping one partial far past any physical level.
    release_count: u32,
    gap_limit: u32,
}

/// One sounding key: up to three detuned strings of modal resonators, plus
/// the hammer that set them going.
struct Voice {
    active: bool,
    /// Key held (voice follows the damper) vs released (damper falls unless
    /// the pedal holds it off).
    held: bool,
    /// Stolen or restruck: decays fast regardless of damper state.
    fading: bool,
    has_damper: bool,
    key: i16,
    age: u32,
    quiet_blocks: u32,
    mode_count: usize,
    /// Modes belonging to the first string — the slice of `q` the hammer's
    /// contact displacement is read from.
    string0_modes: usize,
    hammer: Hammer,
    pan_l: f32,
    pan_r: f32,
    // Modal state and per-mode constants, laid out as parallel arrays so the
    // per-sample loop is a straight vectorisable sweep.
    q: [f32; SLOTS],
    v: [f32; SLOTS],
    e: [f32; SLOTS],
    dec_free: [f32; SLOTS],
    dec_damped: [f32; SLOTS],
    wo_l: [f32; SLOTS],
    wo_r: [f32; SLOTS],
    kick: [f32; SLOTS],
    exc: [f32; EXC_SLOTS],
}

impl Voice {
    fn new() -> Self {
        Voice {
            active: false,
            held: false,
            fading: false,
            has_damper: true,
            key: 0,
            age: 0,
            quiet_blocks: 0,
            mode_count: 0,
            string0_modes: 0,
            hammer: Hammer {
                active: false,
                contacted: false,
                h: 0.0,
                vh: 0.0,
                inv_mass: 0.0,
                k: 0.0,
                p: 0.0,
                age: 0,
                release_count: 0,
                gap_limit: 0,
            },
            pan_l: 0.0,
            pan_r: 0.0,
            q: [0.0; SLOTS],
            v: [0.0; SLOTS],
            e: [0.0; SLOTS],
            dec_free: [0.0; SLOTS],
            dec_damped: [0.0; SLOTS],
            wo_l: [0.0; SLOTS],
            wo_r: [0.0; SLOTS],
            kick: [0.0; SLOTS],
            exc: [0.0; EXC_SLOTS],
        }
    }

    /// Builds this voice for one strike. Everything written here is written
    /// into preallocated arrays; the per-mode transcendentals are a few
    /// thousand operations, done once per note-on.
    fn setup(&mut self, key: i16, velocity: f32, params: &Params, sample_rate: f32) {
        let scale = key_scaling(key);
        let dt = 1.0 / sample_rate;

        self.active = true;
        self.held = true;
        self.fading = false;
        self.has_damper = scale.has_damper;
        self.key = key;
        self.age = 0;
        self.quiet_blocks = 0;

        // Stretch is a retuning of the whole key; detune separates the
        // strings of the key around it.
        let f0 = scale.f0 * 2.0f32.powf(stretch_cents(key, params.stretch) / 1200.0);
        let detune = scale.detune_cents * params.detune;
        let string_offsets = [0.0, detune, -0.7 * detune];
        let string_decay_var = [1.0, 0.93, 1.08];

        // Hardness moves the felt along its stiffening curve: log-scaled K
        // and a slightly higher exponent for a harder, brighter hammer.
        let hardness = params.hardness - 0.5;
        self.hammer = Hammer {
            active: true,
            contacted: false,
            // Starting 1 mm out gives a sub-millisecond flight, so a soft
            // note lands a touch later than a loud one, as it does.
            h: -0.001,
            vh: hammer_velocity(velocity, params.dynamics, scale.velocity_floor),
            inv_mass: 1.0 / scale.hammer_mass,
            k: scale.hammer_k * 10.0f32.powf(hardness * 2.4),
            p: scale.hammer_p + hardness * 0.5,
            age: 0,
            release_count: 0,
            // A genuine contact can have brief force-free gaps while a wave
            // travels the string, so the backcheck waits a fraction of the
            // fundamental period — but never long enough for the hammer to
            // bounce back in on the next cycle.
            gap_limit: ((0.3 * sample_rate / f0) as u32).clamp(2, 24),
        };

        let angle = (scale.pan + 1.0) * core::f32::consts::FRAC_PI_4;
        self.pan_l = angle.cos();
        self.pan_r = angle.sin();

        let sigma_damper = 6.9078 / params.damper_s;
        let inv_b1 = 1.0 / (1.0 + scale.b);
        let nyquist_guard = 0.47 * sample_rate;

        let mut m = 0;
        for s in 0..scale.strings {
            let fs0 = f0 * 2.0f32.powf(string_offsets[s] / 1200.0);
            let svar = string_decay_var[s];
            let mut string_modes = 0;
            for n in 1..=scale.mode_cap {
                if m >= SLOTS {
                    break;
                }
                let nf = n as f32;
                let fn_hz = nf * fs0 * ((1.0 + scale.b * nf * nf) * inv_b1).sqrt();
                if fn_hz > nyquist_guard {
                    break;
                }
                let omega = core::f32::consts::TAU * fn_hz;

                // Held-key decay: the fundamental's rate, growing along the
                // partial series and with frequency; the Decay parameter
                // stretches or shrinks every time constant together.
                let sigma = (scale.sigma0 * (1.0 + 0.05 * (nf - 1.0)) * svar
                    + scale.sigma2 * (fn_hz / 1000.0) * (fn_hz / 1000.0))
                    / params.decay;
                let sigma_d = if scale.has_damper {
                    sigma + sigma_damper * (1.0 + 0.02 * (nf - 1.0))
                } else {
                    sigma
                };

                let excite = (nf * core::f32::consts::PI * scale.strike_pos).sin();
                self.e[m] = 2.0 * (0.5 * omega * dt).sin();
                self.dec_free[m] = (-sigma * dt).exp();
                self.dec_damped[m] = (-sigma_d * dt).exp();
                // Output weight carries omega and the modal mass so that,
                // against the kick below, the radiated level of an impulse is
                // independent of which key's mass received it.
                let radiate = omega * scale.modal_mass * OUTPUT_SCALE;
                self.wo_l[m] = (nf * core::f32::consts::PI * scale.read_l).sin() * radiate;
                self.wo_r[m] = (nf * core::f32::consts::PI * scale.read_r).sin() * radiate;
                self.kick[m] = excite / (scale.modal_mass * omega * scale.strings as f32);
                if s == 0 && string_modes < EXC_SLOTS {
                    self.exc[string_modes] = excite;
                }
                self.q[m] = 0.0;
                self.v[m] = 0.0;
                m += 1;
                string_modes += 1;
            }
            if s == 0 {
                self.string0_modes = string_modes.min(EXC_SLOTS);
            }
        }
        self.mode_count = m;

        // Level the keyboard. A bass key radiates through a hundred partials
        // and a top key through five, which left to physics alone tilts the
        // instrument by tens of dB. Normalise each voice by its own radiated
        // response to a unit impulse — an incoherent (power) sum, since the
        // partials' phases decohere within the first cycle — anchored to the
        // hammer momentum a fortissimo strike delivers.
        let mut power = 0.0f32;
        for (wl, kick) in self.wo_l[..m].iter().zip(&self.kick[..m]) {
            let c = wl * kick;
            power += c * c;
        }
        let response = power.sqrt().max(1.0e-12);
        let momentum =
            scale.hammer_mass * hammer_velocity(1.0, params.dynamics, scale.velocity_floor) * 1.5;
        let norm = 0.35 * scale.output_trim / (response * momentum);
        for w in &mut self.wo_l[..m] {
            *w *= norm;
        }
        for w in &mut self.wo_r[..m] {
            *w *= norm;
        }
    }

    /// One audio sample of hammer flight and contact, returning the force
    /// impulse (N·s) this sample delivered into the strings.
    fn hammer_step(&mut self, dt: f32) -> f32 {
        let hammer = &mut self.hammer;
        if !hammer.active {
            return 0.0;
        }
        hammer.age += 1;

        // String displacement under the hammer, from the first string's
        // modes. The string moves slowly compared with the contact dynamics,
        // so one evaluation per audio sample is enough for the substeps.
        let mut y0 = 0.0;
        for (q, exc) in self.q[..self.string0_modes]
            .iter()
            .zip(&self.exc[..self.string0_modes])
        {
            y0 += q * exc;
        }

        let dts = dt / HAMMER_SUBSTEPS as f32;
        let mut impulse = 0.0;
        for _ in 0..HAMMER_SUBSTEPS {
            let compression = hammer.h - y0;
            let force = if compression > 0.0 {
                hammer.contacted = true;
                // Hunt–Crossley: the felt loses energy while being worked,
                // which is what stops the hammer and string ringing against
                // each other during a long treble contact. The clamps are
                // numerical guards, far above any musical force; Chaigne &
                // Askenfelt measure fortissimo around 40 N.
                let elastic = hammer.k * compression.min(0.02).powf(hammer.p);
                (elastic * (1.0 + 0.5 * hammer.vh).max(0.0)).min(5000.0)
            } else {
                0.0
            };
            // Semi-implicit Euler: velocity first, then position from the
            // new velocity — the stable order for a stiff contact.
            hammer.vh -= force * hammer.inv_mass * dts;
            hammer.h += hammer.vh * dts;
            impulse += force * dts;
        }

        // Retired after rebounding a half millimetre clear of the string, or
        // after 50 ms without ever touching it.
        if hammer.contacted {
            if impulse == 0.0 {
                hammer.release_count += 1;
                if hammer.release_count > hammer.gap_limit {
                    hammer.active = false;
                }
            } else {
                hammer.release_count = 0;
            }
        } else if hammer.age > (0.05 / dt) as u32 {
            hammer.active = false;
        }
        impulse
    }
}

/// MIDI-style velocity (0..1) to hammer speed in m/s, between the key's own
/// floor and a fortissimo blow.
///
/// The Dynamics parameter sets the curve's power: high dynamics flattens it
/// (a small touch range covers the whole loudness range), low dynamics
/// steepens it.
fn hammer_velocity(velocity: f32, dynamics: f32, floor: f32) -> f32 {
    let gamma = 3.0 - 2.0 * dynamics.clamp(0.0, 1.0);
    floor + (7.0 - floor) * velocity.clamp(0.0, 1.0).powf(gamma)
}

/// The whole instrument: voices, pedal, and the master path (gain, tone
/// filter, DC blocker).
pub struct Piano {
    voices: Box<[Voice]>,
    params: Params,
    sample_rate: f32,
    /// CC64 state, OR-ed with the Sustain parameter.
    pedal_cc: bool,
    counter: u32,
    gain: f32,
    tone_coeff: f32,
    tone_l: f32,
    tone_r: f32,
    dc_r_coeff: f32,
    dc_xl: f32,
    dc_yl: f32,
    dc_xr: f32,
    dc_yr: f32,
}

impl Piano {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = if sample_rate.is_finite() {
            sample_rate.clamp(8000.0, 384_000.0)
        } else {
            48_000.0
        };
        let params = Params::default();
        let mut piano = Piano {
            voices: (0..MAX_VOICES).map(|_| Voice::new()).collect(),
            params,
            sample_rate,
            pedal_cc: false,
            counter: 0,
            gain: 1.0,
            tone_coeff: 0.0,
            tone_l: 0.0,
            tone_r: 0.0,
            dc_r_coeff: 1.0 - core::f32::consts::TAU * 10.0 / sample_rate,
            dc_xl: 0.0,
            dc_yl: 0.0,
            dc_xr: 0.0,
            dc_yr: 0.0,
        };
        piano.refresh_tone();
        piano.gain = 10.0f32.powf(piano.params.gain_db / 20.0);
        piano
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn set_param(&mut self, id: u32, value: f64) {
        self.params.set(id, value);
        if id == P_BRIGHTNESS_HZ {
            self.refresh_tone();
        }
    }

    pub fn param(&self, id: u32) -> f64 {
        self.params.get(id)
    }

    fn refresh_tone(&mut self) {
        let fc = self.params.brightness_hz.min(0.45 * self.sample_rate);
        self.tone_coeff = 1.0 - (-core::f32::consts::TAU * fc / self.sample_rate).exp();
    }

    fn pedal(&self) -> bool {
        self.pedal_cc || self.params.sustain >= 0.5
    }

    pub fn set_pedal(&mut self, down: bool) {
        self.pedal_cc = down;
    }

    pub fn note_on(&mut self, key: i16, velocity: f32) {
        if !(FIRST_KEY..=LAST_KEY).contains(&key) {
            return;
        }
        let velocity = velocity.clamp(0.005, 1.0);

        // A restrike: the old voice of this key gets out of the way quickly
        // (the real hammer throws the old vibration off the string) while the
        // new strike gets a fresh voice.
        for voice in self.voices.iter_mut() {
            if voice.active && voice.key == key && voice.held {
                voice.held = false;
                voice.fading = true;
            }
        }

        let slot = self.pick_voice();
        let params = &self.params;
        let sample_rate = self.sample_rate;
        self.voices[slot].setup(key, velocity, params, sample_rate);
        self.counter += 1;
        self.voices[slot].age = 0;
    }

    /// A free voice, or the most expendable sounding one: fading beats
    /// released beats held, older beats newer.
    fn pick_voice(&self) -> usize {
        let mut best = 0;
        let mut best_score = u64::MAX;
        for (i, voice) in self.voices.iter().enumerate() {
            if !voice.active {
                return i;
            }
            let class: u64 = if voice.fading {
                0
            } else if !voice.held {
                1
            } else {
                2
            };
            // Older = larger age = smaller score within the class.
            let score = (class << 32) | (u32::MAX - voice.age.min(u32::MAX - 1)) as u64;
            if score < best_score {
                best_score = score;
                best = i;
            }
        }
        best
    }

    pub fn note_off(&mut self, key: i16) {
        for voice in self.voices.iter_mut() {
            if voice.active && voice.key == key {
                voice.held = false;
            }
        }
    }

    /// A choke silences the key fast, damper or no damper.
    pub fn choke(&mut self, key: i16) {
        for voice in self.voices.iter_mut() {
            if voice.active && voice.key == key {
                voice.held = false;
                voice.fading = true;
            }
        }
    }

    pub fn all_notes_off(&mut self) {
        for voice in self.voices.iter_mut() {
            voice.held = false;
        }
    }

    pub fn all_sound_off(&mut self) {
        for voice in self.voices.iter_mut() {
            if voice.active {
                voice.held = false;
                voice.fading = true;
            }
        }
    }

    pub fn reset(&mut self) {
        for voice in self.voices.iter_mut() {
            voice.active = false;
            voice.hammer.active = false;
        }
        self.pedal_cc = false;
        self.tone_l = 0.0;
        self.tone_r = 0.0;
        self.dc_xl = 0.0;
        self.dc_yl = 0.0;
        self.dc_xr = 0.0;
        self.dc_yr = 0.0;
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|voice| voice.active).count()
    }

    /// Renders `left.len()` samples. The instrument owns its output: the
    /// buffers are overwritten, silence included.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let frames = left.len().min(right.len());
        let left = &mut left[..frames];
        let right = &mut right[..frames];
        left.fill(0.0);
        right.fill(0.0);
        if frames == 0 {
            return;
        }

        let dt = 1.0 / self.sample_rate;
        let pedal = self.pedal();

        for voice in self.voices.iter_mut() {
            if !voice.active {
                continue;
            }
            let damped = voice.has_damper && !voice.held && !pedal;
            let fade = if voice.fading { FADE } else { 1.0 };
            let m = voice.mode_count;
            let mut level = 0.0f32;

            for i in 0..frames {
                let impulse = voice.hammer_step(dt);
                if impulse != 0.0 {
                    for (v, kick) in voice.v[..m].iter_mut().zip(&voice.kick[..m]) {
                        *v += impulse * kick;
                    }
                }

                let mut sum_l = 0.0f32;
                let mut sum_r = 0.0f32;
                let dec = if damped {
                    &voice.dec_damped[..m]
                } else {
                    &voice.dec_free[..m]
                };
                for (((((q, v), e), g), wl), wr) in voice.q[..m]
                    .iter_mut()
                    .zip(voice.v[..m].iter_mut())
                    .zip(&voice.e[..m])
                    .zip(dec)
                    .zip(&voice.wo_l[..m])
                    .zip(&voice.wo_r[..m])
                {
                    *q += e * *v;
                    *v -= e * *q;
                    let g = g * fade;
                    *q *= g;
                    *v *= g;
                    sum_l += wl * *v;
                    sum_r += wr * *v;
                }

                left[i] += sum_l * voice.pan_l;
                right[i] += sum_r * voice.pan_r;
                level += sum_l.abs() + sum_r.abs();
            }

            voice.age = voice.age.saturating_add(frames as u32);
            // A voice is reclaimed once inaudible — but not while its hammer
            // is still in flight, when silence is just the note not having
            // landed yet.
            if level / (frames as f32) < SILENCE && !voice.hammer.active {
                voice.quiet_blocks += 1;
                if voice.quiet_blocks > 3 {
                    voice.active = false;
                }
            } else {
                voice.quiet_blocks = 0;
            }
        }

        // Master path: smoothed gain, the tone one-pole, and a DC blocker —
        // a struck stiff string leaves a small static offset behind and the
        // blocker is cheaper than arguing with it.
        let gain_target = 10.0f32.powf(self.params.gain_db / 20.0);
        let a = self.tone_coeff;
        let r = self.dc_r_coeff;
        for i in 0..frames {
            self.gain += 0.002 * (gain_target - self.gain);
            self.tone_l += a * (left[i] - self.tone_l);
            self.tone_r += a * (right[i] - self.tone_r);

            let xl = self.tone_l * self.gain;
            let yl = xl - self.dc_xl + r * self.dc_yl;
            self.dc_xl = xl;
            self.dc_yl = yl;
            left[i] = yl;

            let xr = self.tone_r * self.gain;
            let yr = xr - self.dc_xr + r * self.dc_yr;
            self.dc_xr = xr;
            self.dc_yr = yr;
            right[i] = yr;
        }
    }
}
