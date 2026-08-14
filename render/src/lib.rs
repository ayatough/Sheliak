//! The parts of the native renderer that are worth testing on their own.
//!
//! The binary in `main.rs` is the render job reader, the engine driver and the
//! WAV writer, and none of that is interesting without a job in hand. Plugin
//! hosting is: it talks to somebody else's compiled code, which is the one
//! thing in this repository that can break because of a change nobody here
//! made. `tests/clap.rs` drives it against whatever is installed.

pub mod clap_host;
