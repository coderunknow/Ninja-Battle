#!/usr/bin/env python3
"""Perceptual/technical analysis of a rendered WAV.

Reports what actually matters for a mix: integrated loudness (approximate
ITU-R BS.1770 style K-weighting + gating), true peak, crest factor, clipping,
spectral balance across octave bands, and a per-second level trace so you can
see whether the score has dynamics or is a flat wall of sound.

    python3 tools/audio-analyse.py qa-out/audio-0-258.wav
"""
import sys, wave, math
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else 'qa-out/audio-0-8.wav'
with wave.open(path, 'rb') as w:
    ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    raw = w.readframes(n)
assert sw == 2, 'expected 16-bit'
x = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
x = x.reshape(-1, ch).T          # (channels, frames)
mono = x.mean(axis=0)

def db(v):
    return -999.0 if v <= 1e-12 else 20 * math.log10(v)

peak = float(np.max(np.abs(x)))
# true peak: 4x oversample via linear interp on the abs envelope (cheap proxy)
up = np.interp(np.arange(0, len(mono), 0.25), np.arange(len(mono)), np.abs(mono))
true_peak = float(up.max())
rms = float(np.sqrt(np.mean(mono ** 2)))
crest = db(true_peak) - db(rms)
clipped = int(np.sum(np.abs(x) >= 0.999))
nan = int(np.sum(~np.isfinite(x)))

# ---- K-weighted integrated loudness (BS.1770)
def kweight(sig, sr):
    # high-shelf +4 dB above 1.5 kHz, high-pass 38 Hz (single-pole approximations)
    b = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285])
    a = np.array([1.0, -1.69065929318241, 0.73248077421585])
    y = np.zeros_like(sig)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(sig):
        o = b[0] * v + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        x2, x1, y2, y1 = x1, v, y1, o
        y[i] = o
    return y

kw = kweight(mono, sr)
# 400 ms blocks, 75% overlap
blk = int(0.4 * sr)
hop = blk // 4
z = []
for s in range(0, len(kw) - blk, hop):
    seg = kw[s:s + blk]
    z.append(np.mean(seg ** 2))
z = np.array(z)
zabs = -0.691 + 10 * np.log10(np.maximum(z, 1e-12))
gated = z[zabs > -70.0]
if len(gated):
    rel = -0.691 + 10 * np.log10(np.mean(gated)) - 10
    gated2 = gated[(-0.691 + 10 * np.log10(gated)) > rel]
    lufs = -0.691 + 10 * np.log10(np.mean(gated2)) if len(gated2) else float('nan')
else:
    lufs = float('nan')

# ---- octave-band balance
def band_energy(sig, sr, lo, hi):
    n = len(sig)
    if n < 4096:
        return 0.0
    win = np.hanning(min(n, 1 << 16))
    seg = sig[:len(win)] * win
    sp = np.abs(np.fft.rfft(seg)) ** 2
    fr = np.fft.rfftfreq(len(seg), 1 / sr)
    m = (fr >= lo) & (fr < hi)
    return float(sp[m].sum())

bands = [(20, 60), (60, 120), (120, 250), (250, 500), (500, 1000),
         (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000), (16000, 24000)]
total = sum(band_energy(mono, sr, lo, hi) for lo, hi in bands) or 1e-30

print(f'file          {path}')
print(f'duration      {len(mono)/sr:.2f} s  |  {ch} ch @ {sr} Hz')
print(f'true peak     {db(true_peak):7.2f} dBFS   ({"OK" if db(true_peak) < -1 else "TOO HOT"})')
print(f'sample peak   {db(peak):7.2f} dBFS')
print(f'rms           {db(rms):7.2f} dBFS')
print(f'crest factor  {crest:7.2f} dB      ({"dynamic" if crest > 12 else "compressed/flat"})')
print(f'loudness      {lufs:7.2f} LUFS   (streaming target ≈ -14, cinematic ≈ -18..-23)')
print(f'clipped       {clipped} samples   non-finite {nan}')
print('spectral balance (octave bands, % of energy):')
for (lo, hi) in bands:
    e = band_energy(mono, sr, lo, hi) / total * 100
    bar = '#' * int(e / 2)
    print(f'  {lo:5d}-{hi:<5d} {e:6.2f}%  {bar}')

# ---- per-second level trace (dynamics over time)
if len(mono) > sr:
    print('level per second (dBFS rms):')
    rows = []
    for i in range(int(len(mono) / sr)):
        seg = mono[i * sr:(i + 1) * sr]
        rows.append(f'{i:3d}s {db(np.sqrt(np.mean(seg**2))):6.1f}')
    for i in range(0, len(rows), 6):
        print('   ' + '  '.join(rows[i:i + 6]))
