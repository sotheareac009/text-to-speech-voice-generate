"""
Broadcast-style mastering for commercial voiceovers.

A raw TTS read is clean but flat: wide level swings, thin presence, and peaks
wherever the model put them. Ad reads are mastered — evened out, brightened,
and brought to a fixed loudness so one clip sits at the same level as the next
and as whatever music it ends up over.

The chain, in order:

    trim + fade  →  high-pass  →  low-shelf cut  →  presence peak
                 →  air shelf  →  de-ess  →  expander  →  compress
                 →  loudness normalise  →  limit

Loudness is measured per ITU-R BS.1770-4 (K-weighted, gated), the same metric
streaming platforms normalise to, so `target_lufs` means what it does
everywhere else: -14 LUFS for YouTube/Spotify, -16 for podcasts and most social
video, -23 for EBU broadcast.

    from mastering import MASTERING, master
    audio, report = master(audio, 48000, MASTERING["broadcast"])
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from scipy import signal
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d

EPS = 1e-12


# ─────────────────────────────── presets ────────────────────────────────

@dataclass(frozen=True)
class Mastering:
    """One mastering voicing. `high_pass_hz`..`ratio` shape the tone and
    dynamics; `target_lufs` and `ceiling_db` set the delivery level."""

    key: str
    label: str
    blurb: str
    high_pass_hz: float = 85.0      # rumble and plosive thump
    low_shelf_db: float = -2.0      # tame boxiness around 300 Hz
    presence_db: float = 3.0        # intelligibility lift around 4 kHz
    air_db: float = 2.5             # openness above 8.5 kHz
    deess_db: float = 4.0           # max sibilance reduction
    #: Expander threshold, relative to the clip's own speech level. 0 disables.
    gate_floor_db: float = -28.0
    threshold_db: float = -22.0     # compressor
    ratio: float = 3.0
    attack_ms: float = 8.0
    release_ms: float = 120.0
    target_lufs: float = -16.0
    ceiling_db: float = -1.0        # true-peak ceiling


MASTERING: dict[str, Mastering] = {
    "clean": Mastering(
        key="clean",
        label="Clear & clean",
        blurb="Cleans up and opens out the voice without sounding produced.",
        high_pass_hz=75.0,
        low_shelf_db=-1.5,
        presence_db=2.0,
        air_db=2.5,
        deess_db=3.0,
        gate_floor_db=-28.0,
        threshold_db=-20.0,
        ratio=1.8,
        target_lufs=-16.0,
        ceiling_db=-1.0,
    ),
    "light": Mastering(
        key="light",
        label="Light polish",
        blurb="Cleans up and evens out without changing the character.",
        high_pass_hz=70.0,
        low_shelf_db=-1.0,
        presence_db=1.5,
        air_db=1.5,
        deess_db=2.0,
        gate_floor_db=-32.0,
        threshold_db=-20.0,
        ratio=2.0,
        target_lufs=-18.0,
        ceiling_db=-1.5,
    ),
    "broadcast": Mastering(
        key="broadcast",
        label="Broadcast",
        blurb="Even, present and loud enough to sit under music. Start here.",
    ),
    "punchy": Mastering(
        key="punchy",
        label="Punchy ad",
        blurb="Dense and forward, for short retail spots. Can get fatiguing.",
        high_pass_hz=95.0,
        low_shelf_db=-2.5,
        presence_db=4.5,
        air_db=3.5,
        deess_db=5.0,
        gate_floor_db=-24.0,
        threshold_db=-26.0,
        ratio=4.0,
        attack_ms=5.0,
        release_ms=90.0,
        target_lufs=-14.0,
    ),
    # `master` returns early on this one, so none of it runs — but every field
    # is neutral anyway, so the preset doesn't read as if it did something.
    "off": Mastering(
        key="off",
        label="Off (raw model output)",
        blurb="No processing at all. For comparing against the cleaned version.",
        high_pass_hz=0.0,
        low_shelf_db=0.0,
        presence_db=0.0,
        air_db=0.0,
        deess_db=0.0,
        gate_floor_db=0.0,
        ratio=1.0,
    ),
}

#: What the commercial tuner reaches for when a style doesn't say otherwise.
DEFAULT_MASTERING = "broadcast"
#: What runs when the tuner is off. Never "off" — a raw read is never the goal.
CLEANUP_DEFAULT = "clean"


def mastering_catalog() -> list[dict]:
    """The presets as plain data, for the UI."""
    return [
        {"key": m.key, "label": m.label, "blurb": m.blurb, "target_lufs": m.target_lufs}
        for m in MASTERING.values()
    ]


# ──────────────────────────────── biquads ───────────────────────────────
# RBJ audio-EQ-cookbook forms, so the same coefficients work at any rate.

def _high_pass(fc: float, q: float, fs: int) -> tuple[np.ndarray, np.ndarray]:
    w0 = 2.0 * np.pi * fc / fs
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    b = np.array([(1 + cos_w0) / 2, -(1 + cos_w0), (1 + cos_w0) / 2])
    a = np.array([1 + alpha, -2 * cos_w0, 1 - alpha])
    return b / a[0], a / a[0]


def _low_shelf(gain_db: float, fc: float, q: float, fs: int) -> tuple[np.ndarray, np.ndarray]:
    amp = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * fc / fs
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    sqrt_a = 2.0 * np.sqrt(amp) * alpha
    b = np.array([
        amp * ((amp + 1) - (amp - 1) * cos_w0 + sqrt_a),
        2 * amp * ((amp - 1) - (amp + 1) * cos_w0),
        amp * ((amp + 1) - (amp - 1) * cos_w0 - sqrt_a),
    ])
    a = np.array([
        (amp + 1) + (amp - 1) * cos_w0 + sqrt_a,
        -2 * ((amp - 1) + (amp + 1) * cos_w0),
        (amp + 1) + (amp - 1) * cos_w0 - sqrt_a,
    ])
    return b / a[0], a / a[0]


def _high_shelf(gain_db: float, fc: float, q: float, fs: int) -> tuple[np.ndarray, np.ndarray]:
    amp = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * fc / fs
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    sqrt_a = 2.0 * np.sqrt(amp) * alpha
    b = np.array([
        amp * ((amp + 1) + (amp - 1) * cos_w0 + sqrt_a),
        -2 * amp * ((amp - 1) + (amp + 1) * cos_w0),
        amp * ((amp + 1) + (amp - 1) * cos_w0 - sqrt_a),
    ])
    a = np.array([
        (amp + 1) - (amp - 1) * cos_w0 + sqrt_a,
        2 * ((amp - 1) - (amp + 1) * cos_w0),
        (amp + 1) - (amp - 1) * cos_w0 - sqrt_a,
    ])
    return b / a[0], a / a[0]


def _peaking(gain_db: float, fc: float, q: float, fs: int) -> tuple[np.ndarray, np.ndarray]:
    amp = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * fc / fs
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    b = np.array([1 + alpha * amp, -2 * cos_w0, 1 - alpha * amp])
    a = np.array([1 + alpha / amp, -2 * cos_w0, 1 - alpha / amp])
    return b / a[0], a / a[0]


def _apply(x: np.ndarray, b: np.ndarray, a: np.ndarray) -> np.ndarray:
    """Filter without the start-up transient a zero initial state would give."""
    zi = signal.lfilter_zi(b, a) * x[0]
    out, _ = signal.lfilter(b, a, x, zi=zi)
    return out


# ───────────────────────────── measurement ──────────────────────────────

# BS.1770 specifies its two pre-filters as fixed coefficients at 48 kHz. The
# forms below reproduce those exactly and stay correct at any sample rate (De
# Man, "Evaluation of implementations of the EBU R128 loudness measurement").
# Note these are *not* the RBJ shelf above: that one has a different shape and
# reads ~0.25 LU low, which would quietly bias every target in this file.
_K_SHELF_GAIN_DB = 3.999843853973347
_K_SHELF_HZ, _K_SHELF_Q = 1681.974450955533, 0.7071752369554196
_K_HPF_HZ, _K_HPF_Q = 38.13547087602444, 0.5003270373238773


def _k_shelf(fs: int) -> tuple[np.ndarray, np.ndarray]:
    k = np.tan(np.pi * _K_SHELF_HZ / fs)
    vh = 10.0 ** (_K_SHELF_GAIN_DB / 20.0)
    vb = vh**0.499666774155
    norm = 1.0 + k / _K_SHELF_Q + k * k
    b = np.array([
        (vh + vb * k / _K_SHELF_Q + k * k) / norm,
        2.0 * (k * k - vh) / norm,
        (vh - vb * k / _K_SHELF_Q + k * k) / norm,
    ])
    a = np.array([
        1.0,
        2.0 * (k * k - 1.0) / norm,
        (1.0 - k / _K_SHELF_Q + k * k) / norm,
    ])
    return b, a


def _k_high_pass(fs: int) -> tuple[np.ndarray, np.ndarray]:
    k = np.tan(np.pi * _K_HPF_HZ / fs)
    norm = 1.0 + k / _K_HPF_Q + k * k
    b = np.array([1.0, -2.0, 1.0])
    a = np.array([1.0, 2.0 * (k * k - 1.0) / norm, (1.0 - k / _K_HPF_Q + k * k) / norm])
    return b, a


def _k_weight(x: np.ndarray, fs: int) -> np.ndarray:
    """The two BS.1770 pre-filters: a head-related shelf, then an RLB high-pass."""
    b, a = _k_shelf(fs)
    y = _apply(x, b, a)
    b, a = _k_high_pass(fs)
    return _apply(y, b, a)


def loudness_lufs(x: np.ndarray, fs: int) -> float:
    """Integrated loudness, ITU-R BS.1770-4 (mono, gated). -inf for silence."""
    x = np.asarray(x, dtype="float64")
    if x.size == 0 or not np.any(x):
        return float("-inf")

    weighted = _k_weight(x, fs)
    block = int(0.400 * fs)
    if weighted.size < block:                     # too short to gate — plain mean square
        power = float(np.mean(weighted**2))
        return -0.691 + 10.0 * np.log10(power + EPS)

    step = max(1, block // 4)                     # 75% overlap
    starts = np.arange(0, weighted.size - block + 1, step)
    squared = np.concatenate(([0.0], np.cumsum(weighted**2)))
    power = (squared[starts + block] - squared[starts]) / block
    block_lufs = -0.691 + 10.0 * np.log10(power + EPS)

    keep = block_lufs > -70.0                     # absolute gate
    if not np.any(keep):
        return float("-inf")
    ungated = -0.691 + 10.0 * np.log10(np.mean(power[keep]) + EPS)
    keep &= block_lufs > ungated - 10.0           # relative gate
    if not np.any(keep):
        return float(ungated)
    return float(-0.691 + 10.0 * np.log10(np.mean(power[keep]) + EPS))


def true_peak_db(x: np.ndarray, fs: int) -> float:
    """Inter-sample peak in dBTP, via 4x oversampling as BS.1770 prescribes."""
    x = np.asarray(x, dtype="float64")
    if x.size == 0 or not np.any(x):
        return float("-inf")
    peak = float(np.max(np.abs(signal.resample_poly(x, 4, 1)))) if x.size > 32 else float(np.max(np.abs(x)))
    peak = max(peak, float(np.max(np.abs(x))))
    return 20.0 * np.log10(peak + EPS)


# ─────────────────────────────── processing ─────────────────────────────

def _env_db(x: np.ndarray, fs: int, window_ms: float) -> np.ndarray:
    """Sliding-window RMS in dB."""
    win = max(1, int(window_ms * fs / 1000.0))
    mean_square = uniform_filter1d(x.astype("float64") ** 2, size=win, mode="nearest")
    return 10.0 * np.log10(mean_square + EPS)


def _shape_gain(gain_db: np.ndarray, fs: int, attack_ms: float, release_ms: float) -> np.ndarray:
    """Give a static gain curve an attack and a release.

    This approximates a feed-forward detector rather than running a per-sample
    loop: the attack is a look-ahead minimum filter, so the gain is already
    down when the transient lands, and the release is a one-pole smoother. For
    speech that is indistinguishable from the sample-accurate version and it
    stays vectorised, which matters on a minute-long read.
    """
    attack = max(1, int(attack_ms * fs / 1000.0))
    gain_db = minimum_filter1d(gain_db, size=2 * attack + 1, mode="nearest")
    coeff = float(np.exp(-1.0 / max(1.0, release_ms * fs / 1000.0)))
    b, a = np.array([1.0 - coeff]), np.array([1.0, -coeff])
    smoothed = _apply(gain_db, b, a)
    return np.minimum(smoothed, 0.0)


def _shape_gate(
    gain_db: np.ndarray, fs: int, open_ms: float, hold_ms: float, smooth_ms: float = 12.0
) -> np.ndarray:
    """Let a gate open early and close late.

    `_shape_gain` dips the gain *before* a transient, which is right for
    catching a peak and exactly wrong for a gate — it would mute the start of
    every word. A gate has to be back up before the word arrives and stay up
    after it, so the window here is a maximum filter spanning `open_ms` ahead
    and `hold_ms` behind. The hold also stops it chattering inside a pause.

    Their sum is the shortest pause that can be cleaned at all — a window
    wider than the gap always finds speech at one end and stays open — so it
    has to stay well under the length of a real pause between words.
    """
    look = max(1, int(open_ms * fs / 1000.0))
    hold = max(1, int(hold_ms * fs / 1000.0))
    size = look + hold + 1
    # scipy's `origin` shifts the window: negative looks ahead, positive behind.
    origin = int(np.clip((hold - look) // 2, -(size // 2), size // 2))
    opened = maximum_filter1d(gain_db, size=size, origin=origin, mode="nearest")

    coeff = float(np.exp(-1.0 / max(1.0, smooth_ms * fs / 1000.0)))
    b, a = np.array([1.0 - coeff]), np.array([1.0, -coeff])
    return np.minimum(_apply(opened, b, a), 0.0)


def _expand(
    x: np.ndarray, fs: int, floor_db: float, ratio: float = 2.0, max_cut_db: float = 18.0
) -> np.ndarray:
    """Push down whatever sits below the speech, so the gaps go quiet.

    Model output isn't silent between words — there's a low-level haze, and the
    presence and air lifts above make it more audible, not less. This is a
    downward expander rather than a hard gate: below the threshold everything
    gets pushed further down instead of being cut off, so a trailing word fades
    out instead of being chopped.

    `floor_db` is relative to the clip's own speech level, so a quiet read and
    a loud one are treated the same.
    """
    if floor_db >= 0.0 or not np.any(x):
        return x
    env_db = _env_db(x, fs, window_ms=15.0)
    speech_db = float(np.percentile(env_db, 90))
    below = np.minimum(0.0, env_db - (speech_db + floor_db))
    gain_db = np.clip(below * (ratio - 1.0), -max_cut_db, 0.0)
    return x * 10.0 ** (_shape_gate(gain_db, fs, open_ms=20.0, hold_ms=70.0) / 20.0)


def _compress(
    x: np.ndarray, fs: int, threshold_db: float, ratio: float,
    attack_ms: float, release_ms: float, knee_db: float = 6.0,
) -> np.ndarray:
    """Downward compression with a soft knee."""
    if ratio <= 1.0:
        return x
    over = _env_db(x, fs, window_ms=10.0) - threshold_db
    slope = 1.0 - 1.0 / ratio

    gain_db = np.zeros_like(over)
    in_knee = (over > -knee_db / 2) & (over <= knee_db / 2)
    above = over > knee_db / 2
    gain_db[in_knee] = -slope * (over[in_knee] + knee_db / 2) ** 2 / (2 * knee_db)
    gain_db[above] = -slope * over[above]

    return x * 10.0 ** (_shape_gain(gain_db, fs, attack_ms, release_ms) / 20.0)


def _deess(x: np.ndarray, fs: int, amount_db: float) -> np.ndarray:
    """Pull down the hottest sibilance only, in the 5.5–9.5 kHz band.

    The presence lift above makes "s" and "sh" harsh, so this runs after it.
    The threshold is taken from the clip's own sibilance distribution — an
    absolute one would do nothing on a quiet read and wreck a loud one.
    """
    high = min(9500.0, fs / 2.0 * 0.95)
    if amount_db <= 0 or high <= 5500.0:
        return x
    sos = signal.butter(2, [5500.0, high], btype="bandpass", fs=fs, output="sos")
    band = signal.sosfilt(sos, x)
    if not np.any(band):
        return x

    env_db = _env_db(band, fs, window_ms=4.0)
    threshold = float(np.percentile(env_db, 95)) - 3.0
    gain_db = np.clip(-(env_db - threshold) * (1.0 - 1.0 / 3.0), -amount_db, 0.0)
    gain_db = _shape_gain(gain_db, fs, attack_ms=1.0, release_ms=30.0)
    return x + band * (10.0 ** (gain_db / 20.0) - 1.0)


_OVERSAMPLE = 4     # BS.1770's true-peak rate


def _limit(x: np.ndarray, fs: int, ceiling_db: float) -> np.ndarray:
    """Look-ahead true-peak limiter, then a hard guard so nothing clips the WAV.

    The detector runs on the 4x oversampled signal, not on the samples. A
    waveform held at -1 dBFS sample-peak still reconstructs to roughly
    -0.4 dBTP between samples, so limiting the samples alone would miss the
    ceiling by over half a dB — and `ceiling_db` is a *true-peak* figure.
    """
    ceiling = 10.0 ** (ceiling_db / 20.0)
    look = max(1, int(0.002 * fs))

    if x.size > 32:
        upsampled = np.abs(signal.resample_poly(x, _OVERSAMPLE, 1))
        env_up = maximum_filter1d(upsampled, size=2 * look * _OVERSAMPLE + 1, mode="nearest")
        # Fold back to the base rate, keeping the worst case in each group.
        env = env_up[: x.size * _OVERSAMPLE].reshape(-1, _OVERSAMPLE).max(axis=1)
        env = np.maximum(env, maximum_filter1d(np.abs(x), size=2 * look + 1, mode="nearest"))
    else:
        env = maximum_filter1d(np.abs(x), size=2 * look + 1, mode="nearest")

    needed = np.minimum(0.0, 20.0 * np.log10(ceiling / np.maximum(env, EPS)))
    gain_db = _shape_gain(needed, fs, attack_ms=1.0, release_ms=50.0)
    # Smoothing lifts the dips back up, so re-impose the hard requirement.
    y = x * 10.0 ** (np.minimum(gain_db, needed) / 20.0)
    return np.clip(y, -ceiling, ceiling)


def trim_and_fade(
    x: np.ndarray, fs: int, floor_db: float = -45.0,
    pad_ms: float = 60.0, fade_ms: float = 15.0,
) -> np.ndarray:
    """Cut dead air off both ends, leaving a little padding, and fade the edges
    so there's no click where the clip starts."""
    if x.size == 0:
        return x
    env_db = _env_db(x, fs, window_ms=20.0)
    loud = np.flatnonzero(env_db > env_db.max() + floor_db)
    if loud.size == 0:
        return x

    pad = int(pad_ms * fs / 1000.0)
    start = max(0, int(loud[0]) - pad)
    end = min(x.size, int(loud[-1]) + pad)
    out = np.array(x[start:end], dtype="float64")

    fade = min(int(fade_ms * fs / 1000.0), out.size // 2)
    if fade > 1:
        ramp = np.linspace(0.0, 1.0, fade)
        out[:fade] *= ramp
        out[-fade:] *= ramp[::-1]
    return out


# ──────────────────────────────── the chain ─────────────────────────────

def condition_reference(
    audio: np.ndarray, sample_rate: int, target_lufs: float = -20.0
) -> np.ndarray:
    """Tidy a clip that will be used as a *voice reference*, not listened to.

    Deliberately only level and rumble: trim the dead air, lose everything
    under 60 Hz, and set a predictable loudness. No compression, no presence,
    no air — a reference is cloned from, so any tone shaping here would be
    baked into every take made with that voice. Leaving the level to chance is
    the one thing worth fixing, since the model reads timbre off it.
    """
    x = np.asarray(audio, dtype="float64").reshape(-1)
    if x.size == 0 or not np.any(x):
        return np.asarray(audio, dtype="float32").reshape(-1)

    # Rumble first, and steeply: one biquad only reaches about -15 dB an octave
    # down, so a 25 Hz thump survives it and the normaliser below then amplifies
    # what is left. Trimming afterwards also stops the thump from being mistaken
    # for signal when the dead air is measured.
    sos = signal.butter(4, 60.0, btype="highpass", fs=sample_rate, output="sos")
    x = signal.sosfilt(sos, x)
    x = trim_and_fade(x, sample_rate, pad_ms=40.0)

    # A quiet reference can legitimately need a lot of gain, so this clamp is
    # looser than the one in `master` — it is only there to stop near-silence
    # from being amplified into noise.
    measured = loudness_lufs(x, sample_rate)
    if not np.isfinite(measured):
        # Under BS.1770's -70 LUFS absolute gate, which calls that silence. A
        # reference this quiet isn't silent, just faint, and it is exactly the
        # case that needs the gain — so measure it ungated instead. The meter
        # itself keeps the gate; it has to stay compliant.
        weighted = _k_weight(x, sample_rate)
        measured = -0.691 + 10.0 * np.log10(float(np.mean(weighted**2)) + EPS)
    if np.isfinite(measured):
        x = x * 10.0 ** (float(np.clip(target_lufs - measured, -30.0, 30.0)) / 20.0)
    # A reference never needs to be loud, only unclipped.
    return _limit(x, sample_rate, -3.0).astype("float32")


def master(
    audio: np.ndarray, sample_rate: int, preset: Mastering | str = DEFAULT_MASTERING,
) -> tuple[np.ndarray, dict]:
    """Master `audio` for delivery. Returns the audio and what was done to it."""
    if isinstance(preset, str):
        preset = MASTERING.get(preset, MASTERING[DEFAULT_MASTERING])

    x = np.asarray(audio, dtype="float64").reshape(-1)
    report: dict = {"preset": preset.key, **asdict(preset)}
    report["lufs_in"] = loudness_lufs(x, sample_rate)
    report["peak_in_db"] = true_peak_db(x, sample_rate)

    # Nothing to do: bypassed, empty, or silent.
    if preset.key == "off" or x.size == 0 or not np.any(x):
        report.update(lufs_out=report["lufs_in"], peak_out_db=report["peak_in_db"], gain_db=0.0)
        return np.asarray(audio, dtype="float32").reshape(-1), report

    x = trim_and_fade(x, sample_rate)

    if preset.high_pass_hz > 0:
        b, a = _high_pass(preset.high_pass_hz, 0.707, sample_rate)
        x = _apply(x, b, a)
    if preset.low_shelf_db:
        b, a = _low_shelf(preset.low_shelf_db, 300.0, 0.707, sample_rate)
        x = _apply(x, b, a)
    if preset.presence_db:
        b, a = _peaking(preset.presence_db, 4000.0, 0.9, sample_rate)
        x = _apply(x, b, a)
    if preset.air_db:
        b, a = _high_shelf(preset.air_db, 8500.0, 0.707, sample_rate)
        x = _apply(x, b, a)

    # De-ess then expand, in that order: both lifts above make sibilance harsher
    # and the noise floor louder, so each is dealt with after it is at its worst.
    x = _deess(x, sample_rate, preset.deess_db)
    x = _expand(x, sample_rate, preset.gate_floor_db)
    x = _compress(
        x, sample_rate, preset.threshold_db, preset.ratio, preset.attack_ms, preset.release_ms
    )

    # Bring it to the delivery loudness, then stop the peaks.
    measured = loudness_lufs(x, sample_rate)
    gain_db = 0.0 if measured == float("-inf") else float(
        np.clip(preset.target_lufs - measured, -24.0, 24.0)
    )
    x = x * 10.0 ** (gain_db / 20.0)
    x = _limit(x, sample_rate, preset.ceiling_db)

    report.update(
        gain_db=round(gain_db, 2),
        lufs_out=loudness_lufs(x, sample_rate),
        peak_out_db=true_peak_db(x, sample_rate),
    )
    return x.astype("float32"), report
