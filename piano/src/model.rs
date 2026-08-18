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

use crate::keys::{key_hash, key_scaling, stretch_cents, FIRST_KEY, LAST_KEY};

/// Deterministic per-mode radiation ripple, standing in for the soundboard's
/// mobility peaks and dips: log-uniform within about ±4 dB, hashed from the
/// key, the partial number and a channel salt — no random source anywhere.
fn mobility(key: i16, n: u32, salt: u32) -> f32 {
    let h = key_hash(key, salt.wrapping_add(97 * n));
    10.0f32.powf(((h & 0xFFFF) as f32 / 32768.0 - 1.0) * 0.2)
}

/// Simultaneous voices. A voice is one key strike; the same key struck twice
/// briefly uses two while the first fades.
pub const MAX_VOICES: usize = 24;

/// Resonators per voice: the widest layouts `keys.rs` hands out are a bass
/// single of 128 partials doubled by its aftersound bank, and a tenor pair
/// of 96 partials with aftersound — each plus the longitudinal bank on
/// wound keys (2·96 + 96 + 12 = 300).
const SLOTS: usize = 304;

/// Radiation corner in Hz: partials below this radiate progressively worse,
/// as a soundboard does. Fitted against the reference recordings: at 105 Hz
/// the model's low-partial levels match the measured ones — A0's
/// fundamental lands ~22 dB down, exactly where the real instrument has it,
/// while C2's second partial (131 Hz), the loudest line of that note on the
/// real piano, keeps its body.
const RADIATION_HZ: f32 = 105.0;

/// The other side of the soundboard's shaping: above this corner its
/// response falls away. Fitted against the reference recordings — the real
/// board's radiativity already declines through the midrange, which is what
/// keeps a note's energy concentrated in its lowest partials. The exponent
/// makes the slope steeper than one pole (≈10 dB/octave); the per-key
/// output trim absorbs the absolute level, so only the shape within each
/// note matters here.
const SOUNDBOARD_HZ: f32 = 200.0;
const SOUNDBOARD_POW: f32 = 0.85;
/// The decline bottoms out near the board's critical frequency, where
/// radiation efficiency recovers: a -20 dB shelf floor, fitted so the
/// treble keys keep their upper partials the way the recordings do.
const SOUNDBOARD_FLOOR: f32 = 0.1;

/// Partials of the first string, the one the hammer's contact dynamics are
/// integrated against.
const EXC_SLOTS: usize = 128;

/// Hammer integration substeps per audio sample while in contact.
const HAMMER_SUBSTEPS: u32 = 8;

// The strike noise — key knock, hammer-shank thunk, soundboard thump — as a
// deterministic noise burst fired at the moment of first felt contact and
// routed through the same radiation/soundboard shaping as the strings, so it
// sits inside the instrument rather than on top of it. The burst's level
// rises faster with hammer velocity than the string tone does: it dominates
// a fortissimo attack and all but vanishes at pianissimo.

/// Burst level at fortissimo, before the `Knock` parameter scales it.
const KNOCK_SCALE: f32 = 1.1;
/// Colour of the burst, low key to high: a dark bass thump to a brighter,
/// clickier treble knock (one-pole lowpass corner, applied twice).
const KNOCK_LP_LOW_HZ: f32 = 300.0;
const KNOCK_LP_HIGH_HZ: f32 = 3000.0;
/// Length of the burst, low key to high: the bass thump breathes for a few
/// milliseconds, the treble knock is over almost at once.
const KNOCK_TAU_LOW_S: f32 = 0.0035;
const KNOCK_TAU_HIGH_S: f32 = 0.0010;
/// Body corner of the knock path. The impact thump reaches the listener
/// through the case and board more directly than the strings' bridge force
/// does, so it keeps a wider band than the string radiation path.
const KNOCK_BODY_HZ: f32 = 1500.0;

// The longitudinal bank — the metallic bite of a struck wound string. The
// transverse deflection stretches the string along its length, driving a
// second, much higher mode series (`keys.rs` sets its fundamental and
// count). The stretch grows with the square of the contact force, so these
// modes are driven by `impulse²/dt`: twice the dB-per-dB slope of the tone,
// which is why a forte bass note bites and a piano one stays round — and
// why a model without them reads as a plucked bass.

/// Longitudinal drive relative to the transverse kick.
const LONG_SCALE: f32 = 0.0035;
/// Base decay rate (1/s) of the longitudinal modes: they ring well under a
/// second, a metallic halo on the attack rather than a second tone.
const LONG_SIGMA: f32 = 9.0;

/// Frequency-dependent extra decay of the aftersound bank, the counterpart
/// of `sigma2` for the late stage — measured shallower than the early
/// stage's on the reference set.
const SIGMA_LATE2: f32 = 0.2;

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
pub const P_KNOCK: u32 = 9;
pub const PARAM_COUNT: usize = 10;

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
    pub knock: f32,
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
            knock: 1.0,
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
            P_KNOCK => self.knock = v.clamp(0.0, 2.0),
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
            P_KNOCK => self.knock,
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
    /// Index of the first longitudinal mode; `long_start..mode_count` is the
    /// longitudinal bank, driven quadratically instead of by the impulse.
    long_start: usize,
    hammer: Hammer,
    pan_l: f32,
    pan_r: f32,
    // The strike-noise burst: a keyed deterministic noise sequence, an
    // exponential envelope armed at note-on and fired at first felt contact,
    // and the one-pole chain that shapes it (colour lowpass twice, the
    // strings' radiation highpass twice, the soundboard corner once).
    knock_rng: u32,
    knock_amp: f32,
    knock_env: f32,
    knock_decay: f32,
    knock_lp_c: f32,
    knock_hp_c: f32,
    knock_sb_c: f32,
    knock_lp1: f32,
    knock_lp2: f32,
    knock_hp1: f32,
    knock_hp2: f32,
    knock_sb: f32,
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
            long_start: 0,
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
            knock_rng: 1,
            knock_amp: 0.0,
            knock_env: 0.0,
            knock_decay: 0.0,
            knock_lp_c: 0.0,
            knock_hp_c: 0.0,
            knock_sb_c: 0.0,
            knock_lp1: 0.0,
            knock_lp2: 0.0,
            knock_hp1: 0.0,
            knock_hp2: 0.0,
            knock_sb: 0.0,
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
        //
        // Every key is two stages of physics: the primary string banks (the
        // vertical polarisation of the unison, radiating hard into the
        // bridge and dying at the fast early rate) and one quiet aftersound
        // bank — the horizontal polarisation and residual unison coupling,
        // slightly detuned, ringing long. Their crossfade is the two-stage
        // decay measured on the reference recordings; without the fast
        // first stage a piano note reads as a sustained (plucked) string.
        let f0 = scale.f0 * 2.0f32.powf(stretch_cents(key, params.stretch) / 1200.0);
        let detune = scale.detune_cents * params.detune;
        let banks = scale.strings + 1;
        let after = scale.strings;
        let mut string_offsets = [0.0f32; 4];
        let mut bank_gain = [1.0f32; 4];
        let mut string_decay_var = [1.0f32; 4];
        if scale.strings >= 2 {
            string_offsets[1] = detune;
            string_decay_var[1] = 0.93;
        }
        if scale.strings >= 3 {
            string_offsets[2] = -0.7 * detune;
            string_decay_var[2] = 1.08;
        }
        string_offsets[after] = 0.4 * detune;
        bank_gain[after] = scale.after_gain;

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

        // Arm the strike noise. `strike` is the note-on velocity through the
        // Dynamics curve (0..1); raising it past 1 makes the burst grow
        // faster with touch than the string tone, whose level follows the
        // hammer speed itself.
        let along = (key - FIRST_KEY) as f32 / (LAST_KEY - FIRST_KEY) as f32;
        let strike = ((self.hammer.vh - scale.velocity_floor) / (7.0 - scale.velocity_floor))
            .clamp(0.0, 1.0);
        // Register weight, measured against each key's own string peak: the
        // bottom octave's thump is lifted, and the top octaves are pulled
        // back — their string tone is weak enough that a flat burst level
        // would read as all click.
        let register = 1.0 + 0.5 * ((0.2 - along) / 0.2).max(0.0)
            - 0.6 * ((along - 0.55) / 0.2).clamp(0.0, 1.0);
        self.knock_rng = key_hash(key, 4) | 1;
        self.knock_amp = KNOCK_SCALE * params.knock * register * strike.powf(1.4);
        self.knock_env = 0.0;
        let tau = KNOCK_TAU_LOW_S + (KNOCK_TAU_HIGH_S - KNOCK_TAU_LOW_S) * along;
        self.knock_decay = (-dt / tau).exp();
        let lp_hz = KNOCK_LP_LOW_HZ * (KNOCK_LP_HIGH_HZ / KNOCK_LP_LOW_HZ).powf(along);
        let pole = |hz: f32| 1.0 - (-core::f32::consts::TAU * hz * dt).exp();
        self.knock_lp_c = pole(lp_hz);
        self.knock_hp_c = pole(RADIATION_HZ);
        self.knock_sb_c = pole(KNOCK_BODY_HZ);
        self.knock_lp1 = 0.0;
        self.knock_lp2 = 0.0;
        self.knock_hp1 = 0.0;
        self.knock_hp2 = 0.0;
        self.knock_sb = 0.0;

        let sigma_damper = 6.9078 / params.damper_s;
        let inv_b1 = 1.0 / (1.0 + scale.b);
        let nyquist_guard = 0.47 * sample_rate;

        let mut m = 0;
        for s in 0..banks {
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

                // Held-key decay: the early rate for the primary strings,
                // the late rate for the aftersound bank, each growing along
                // the partial series and with frequency; the Decay parameter
                // stretches or shrinks every time constant together.
                let sigma = if s == after {
                    (scale.sigma_late0 * (1.0 + 0.02 * (nf - 1.0))
                        + SIGMA_LATE2 * (fn_hz / 1000.0) * (fn_hz / 1000.0))
                        / params.decay
                } else {
                    (scale.sigma0 * (1.0 + 0.05 * (nf - 1.0)) * svar
                        + scale.sigma2 * (fn_hz / 1000.0) * (fn_hz / 1000.0))
                        / params.decay
                };
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
                // independent of which key's mass received it — then the
                // soundboard's band shape (radiation rolloff below, declining
                // radiativity above), and a hashed per-mode mobility ripple
                // standing in for the board's resonance peaks and dips. The
                // ripple differs between the channels, which is what
                // decorrelates them.
                let radiation = fn_hz * fn_hz / (fn_hz * fn_hz + RADIATION_HZ * RADIATION_HZ);
                let soundboard = (1.0 / (1.0 + (fn_hz / SOUNDBOARD_HZ) * (fn_hz / SOUNDBOARD_HZ)))
                    .powf(SOUNDBOARD_POW)
                    .max(SOUNDBOARD_FLOOR);
                let radiate =
                    omega * scale.modal_mass * OUTPUT_SCALE * radiation * soundboard * bank_gain[s];
                self.wo_l[m] = mobility(key, n as u32, 6) * radiate;
                self.wo_r[m] = mobility(key, n as u32, 7) * radiate;
                self.kick[m] = excite / (scale.modal_mass * omega * banks as f32);
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
        self.long_start = m;

        // The longitudinal bank, where `keys.rs` grants one: a harmonic
        // series on the longitudinal fundamental, radiated through the same
        // soundboard shaping as the strings. Its kick is scaled for the
        // quadratic drive (`impulse²/dt`) it receives in `process`.
        for n in 1..=scale.long_modes {
            if m >= SLOTS {
                break;
            }
            let nf = n as f32;
            let fn_hz = nf * scale.long_f1;
            if fn_hz > nyquist_guard {
                break;
            }
            let omega = core::f32::consts::TAU * fn_hz;
            let sigma = (LONG_SIGMA + 0.3 * (fn_hz / 1000.0) * (fn_hz / 1000.0)) / params.decay;
            let sigma_d = if scale.has_damper {
                sigma + sigma_damper
            } else {
                sigma
            };
            let excite =
                (nf * core::f32::consts::PI * scale.strike_pos).sin() / (1.0 + 0.15 * (nf - 1.0));
            // ∫F²dt grows steeply toward the bottom of the keyboard (heavier
            // hammer, larger forces, longer contact), which left alone makes
            // the lowest keys all bite; this tilt levels the bank's measured
            // prominence across the wound range.
            let long_gain = 10.0f32.powf(0.045 * (key as f32 - 36.0));
            self.e[m] = 2.0 * (0.5 * omega * dt).sin();
            self.dec_free[m] = (-sigma * dt).exp();
            self.dec_damped[m] = (-sigma_d * dt).exp();
            // Longitudinal force drives the bridge end-on, which the board
            // radiates far better at these frequencies than it does the
            // transverse midrange — hence the gentler body corner here.
            let radiation = fn_hz * fn_hz / (fn_hz * fn_hz + RADIATION_HZ * RADIATION_HZ);
            let soundboard = 1.0 / (1.0 + (fn_hz / KNOCK_BODY_HZ) * (fn_hz / KNOCK_BODY_HZ)).sqrt();
            let radiate = omega * scale.modal_mass * OUTPUT_SCALE * radiation * soundboard;
            self.wo_l[m] = mobility(key, n as u32, 8) * radiate;
            self.wo_r[m] = mobility(key, n as u32, 9) * radiate;
            self.kick[m] = LONG_SCALE * long_gain * excite / (scale.modal_mass * omega);
            self.q[m] = 0.0;
            self.v[m] = 0.0;
            m += 1;
        }
        self.mode_count = m;

        // Level the keyboard. A bass key radiates through a hundred partials
        // and a top key through five, which left to physics alone tilts the
        // instrument by tens of dB. Normalise each voice by its own radiated
        // response to a unit impulse — an incoherent (power) sum, since the
        // partials' phases decohere within the first cycle — anchored to the
        // hammer momentum a fortissimo strike delivers.
        // The longitudinal modes are excluded from the impulse response —
        // their kick answers a different (quadratic) drive — but their
        // output weights are normalised along with everything else, so the
        // bank rides the voicing.
        let mut power = 0.0f32;
        for (wl, kick) in self.wo_l[..self.long_start]
            .iter()
            .zip(&self.kick[..self.long_start])
        {
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
                let pre_contact = voice.hammer.contacted;
                let impulse = voice.hammer_step(dt);
                if impulse != 0.0 {
                    let ls = voice.long_start;
                    for (v, kick) in voice.v[..ls].iter_mut().zip(&voice.kick[..ls]) {
                        *v += impulse * kick;
                    }
                    // The longitudinal bank takes the square of the contact
                    // force: `impulse²/dt` sums to ∫F²dt over the contact,
                    // which is what keeps the drive — and the pitch of the
                    // bite — independent of the sample rate.
                    let drive = impulse * impulse / dt;
                    for (v, kick) in voice.v[ls..m].iter_mut().zip(&voice.kick[ls..m]) {
                        *v += drive * kick;
                    }
                    if !pre_contact {
                        voice.knock_env = voice.knock_amp;
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

                // The strike noise, while its burst still breathes. The
                // xorshift step is a fixed sequence from the key's seed, so
                // the "noise" renders the same samples every strike.
                if voice.knock_env > 1.0e-9 {
                    let mut s = voice.knock_rng;
                    s ^= s << 13;
                    s ^= s >> 17;
                    s ^= s << 5;
                    voice.knock_rng = s;
                    let white = (s as i32 as f32) * (1.0 / 2_147_483_648.0) * voice.knock_env;
                    voice.knock_env *= voice.knock_decay;
                    voice.knock_lp1 += voice.knock_lp_c * (white - voice.knock_lp1);
                    voice.knock_lp2 += voice.knock_lp_c * (voice.knock_lp1 - voice.knock_lp2);
                    voice.knock_hp1 += voice.knock_hp_c * (voice.knock_lp2 - voice.knock_hp1);
                    let high1 = voice.knock_lp2 - voice.knock_hp1;
                    voice.knock_hp2 += voice.knock_hp_c * (high1 - voice.knock_hp2);
                    let high2 = high1 - voice.knock_hp2;
                    voice.knock_sb += voice.knock_sb_c * (high2 - voice.knock_sb);
                    sum_l += voice.knock_sb;
                    sum_r += voice.knock_sb;
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
