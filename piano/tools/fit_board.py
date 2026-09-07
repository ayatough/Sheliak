#!/usr/bin/env python3
"""Fit the soundboard's modal table from a recorded board tap.

Usage: fit_board.py <impulse-response.wav> [modes]

Prints the `BOARD_MODES` table for `src/board.rs`: one row per mode as
(frequency Hz, decay rate 1/s, amplitude, phase rad), fitted with the
matrix-pencil method to the first 300 ms of the recording, at the
recording's own sample rate (`BOARD_FIT_RATE`). The table that ships was
fitted to the grand-piano tap distributed with
Lorenzoncina/Physical-Modeling-Piano-Synthesis (`AudioFile_IR/Piano_IR.wav`,
44.1 kHz), which the author's ears picked out of an A/B against the old
shelving-filter board. Needs numpy and scipy.
"""
import sys

import numpy as np
from scipy.io import wavfile


def matrix_pencil(h, order, pencil=300):
    """Poles of the best `order`-pole model of the impulse response `h`."""
    hankel = np.lib.stride_tricks.sliding_window_view(h, pencil + 1)
    _, _, vh = np.linalg.svd(hankel, full_matrices=False)
    v = vh.conj().T[:, :order]
    return np.linalg.eigvals(np.linalg.pinv(v[:-1, :]) @ v[1:, :])


def main():
    path = sys.argv[1]
    modes = int(sys.argv[2]) if len(sys.argv) > 2 else 48
    rate, ir = wavfile.read(path)
    ir = ir.astype(float) / 32768.0
    if ir.ndim > 1:
        ir = ir.mean(1)
    onset = np.argmax(np.abs(ir) > 0.02 * np.abs(ir).max())
    h = ir[onset : onset + int(0.30 * rate)]

    z = matrix_pencil(h, 2 * modes)
    z = z[np.abs(z) < 1.0]
    n = np.arange(len(h))
    amps, *_ = np.linalg.lstsq(z[None, :] ** n[:, None], h.astype(complex), rcond=None)

    keep = z.imag > 0
    freq = np.angle(z[keep]) * rate / (2 * np.pi)
    decay = -np.log(np.abs(z[keep])) * rate
    amp = 2 * np.abs(amps[keep])
    phase = np.angle(amps[keep])
    order = np.argsort(freq)

    print(f"// Fitted from {path.split('/')[-1]} at {rate} Hz: {keep.sum()} modes.")
    print(f"pub const BOARD_FIT_RATE: f32 = {rate}.0;")
    print(f"pub const BOARD_MODES: [[f32; 4]; {keep.sum()}] = [")
    for i in order:
        print(f"    [{freq[i]:.1f}, {decay[i]:.1f}, {amp[i]:.6f}, {phase[i]:.4f}],")
    print("];")


if __name__ == "__main__":
    main()
