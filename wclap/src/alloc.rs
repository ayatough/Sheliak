//! `malloc` and `free`, because a WCLAP host cannot allocate on its own.
//!
//! A native CLAP host hands the plugin pointers to memory the host owns. A
//! browser host cannot: the plugin's address space *is* a `WebAssembly.Memory`
//! belonging to the module, and JavaScript has no way to reserve a byte of it
//! without asking. So the draft requires the module to export "`malloc()` or
//! something like it", and every `clap_host`, `clap_process`, audio buffer and
//! event the host builds is written into memory obtained from here.
//!
//! Rust's allocator needs the size back at `dealloc`, and C's `free` does not
//! take one, so the size is stored in a header before the returned pointer.
//!
//! The header is 16 bytes, which is also the alignment: enough for the `f64`
//! and 8-byte-aligned structs in the CLAP ABI, whatever the host puts there.
//!
//! The C names are exported **on wasm only**. A `#[no_mangle] malloc` in a
//! native test binary would take precedence over libc's for the whole process,
//! including for the Rust allocator these functions call — which is a stack
//! overflow, and was one until this was written down.

use core::ffi::c_void;
use std::alloc::{alloc, dealloc, Layout};
use std::ptr::null_mut;

/// Bytes reserved before the returned pointer, and the alignment of the whole
/// block. Must stay a multiple of 8 for the `f64` fields in `clap_event_*`.
const HEADER: usize = 16;

/// # Safety
///
/// The returned pointer is valid for `size` bytes until passed to [`free`].
/// Returns null when the size is unrepresentable or the allocator is out of
/// memory; a host must check.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    let Some(total) = size.checked_add(HEADER) else {
        return null_mut();
    };
    let Ok(layout) = Layout::from_size_align(total, HEADER) else {
        return null_mut();
    };
    let base = alloc(layout);
    if base.is_null() {
        return null_mut();
    }
    (base as *mut usize).write(total);
    base.add(HEADER) as *mut c_void
}

/// # Safety
///
/// `ptr` must be null or a pointer returned by [`malloc`] and not yet freed.
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub unsafe extern "C" fn free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let base = (ptr as *mut u8).sub(HEADER);
    let total = (base as *mut usize).read();
    dealloc(base, Layout::from_size_align_unchecked(total, HEADER));
}
