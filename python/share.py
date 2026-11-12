"""
Re-encode a finished clip into the format a chat app expects.

Telegram treats only OGG/Opus, mono as voice — a WAV arrives as a file
attachment. The format is necessary but not sufficient: the waveform bubble
comes from its own recorder or the Bot API's sendVoice, so a dragged file is an
audio message however it is encoded. Messenger is not fussy and gets AAC in an
.m4a, which is what its own recorder produces.

ffmpeg is the better encoder and is used whenever it is on PATH. libsndfile
covers the bundled app, where no Homebrew binary is guaranteed: it writes Opus
too, and MP3 stands in for AAC, which it cannot write.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

# libopus accepts only these input rates. Everything here is already 48 kHz,
# so the resample below is a guard, not a normal step.
OPUS_RATES = (8000, 12000, 16000, 24000, 48000)


@dataclass(frozen=True)
class Target:
    key: str
    label: str
    ext: str                        # what ffmpeg writes
    fallback_ext: str               # what libsndfile writes when ffmpeg is absent
    mono: bool
    ffmpeg_args: tuple[str, ...]
    sf_format: tuple[str, str]      # (format, subtype) for the fallback
    note: str


TARGETS: dict[str, Target] = {
    "telegram": Target(
        key="telegram",
        label="Telegram voice",
        ext=".ogg",
        fallback_ext=".ogg",
        mono=True,
        # Mono and VoIP-tuned is what Telegram's own recorder sends.
        ffmpeg_args=(
            "-c:a", "libopus", "-b:a", "32k", "-ac", "1",
            "-ar", "48000", "-application", "voip",
        ),
        sf_format=("OGG", "OPUS"),
        note="OGG/Opus, mono — the format Telegram shows as a voice message.",
    ),
    "messenger": Target(
        key="messenger",
        label="Messenger audio",
        ext=".m4a",
        fallback_ext=".mp3",
        mono=False,
        ffmpeg_args=("-c:a", "aac", "-b:a", "128k"),
        sf_format=("MP3", "MPEG_LAYER_III"),
        note="AAC in an .m4a — what Messenger's own recorder produces.",
    ),
}

# Every extension any target can produce, so the HTTP layer knows what to serve
# and the pruner knows what to clean up alongside the WAV.
EXPORT_SUFFIXES = tuple(
    sorted({t.ext for t in TARGETS.values()} | {t.fallback_ext for t in TARGETS.values()})
)


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


# One lock per destination: concurrent requests for the same clip and target
# would otherwise write the same file at once and leave a truncated one behind.
# FastAPI runs these handlers in a threadpool, so this really can happen.
_locks: dict[Path, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(dest: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(dest, threading.Lock())


def _encode_with_ffmpeg(binary: str, source: Path, dest: Path, target: Target) -> None:
    # -y: the export is a cache keyed by clip id, so overwriting is correct.
    result = subprocess.run(
        [binary, "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(source), *target.ffmpeg_args, str(dest)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0 or not dest.exists():
        raise RuntimeError(result.stderr.strip() or f"ffmpeg exited {result.returncode}")


def _encode_with_libsndfile(source: Path, dest: Path, target: Target) -> None:
    audio, rate = sf.read(str(source), dtype="float32", always_2d=True)
    if target.mono and audio.shape[1] > 1:
        audio = audio.mean(axis=1, keepdims=True)

    fmt, subtype = target.sf_format
    if fmt == "OGG" and subtype == "OPUS" and rate not in OPUS_RATES:
        from scipy.signal import resample_poly  # local: only needed off the happy path
        from math import gcd
        divisor = gcd(int(rate), 48000)
        audio = resample_poly(audio, 48000 // divisor, int(rate) // divisor, axis=0)
        rate = 48000

    sf.write(str(dest), audio, int(rate), format=fmt, subtype=subtype)


def _done(dest: Path) -> bool:
    """A previous export that actually finished writing."""
    return dest.exists() and dest.stat().st_size > 0


def export(source: Path, target_key: str, out_dir: Path | None = None) -> tuple[Path, Target, str]:
    """Write `source` beside itself in `target_key`'s format.

    Returns the file, the target it was built for, and which encoder did it —
    the caller surfaces that, because the fallback produces a different
    container and the UI should not claim otherwise.
    """
    target = TARGETS.get(target_key)
    if target is None:
        raise KeyError(target_key)
    if not source.exists():
        raise FileNotFoundError(source)

    out_dir = source.parent if out_dir is None else out_dir
    binary = _ffmpeg()
    encoder = "ffmpeg" if binary else "libsndfile"
    dest = out_dir / f"{source.stem}{target.ext if binary else target.fallback_ext}"

    # Exports are deterministic for a given clip, so a finished one is reusable.
    if _done(dest):
        return dest, target, encoder

    with _lock_for(dest):
        # Whoever held the lock may have just built it.
        if _done(dest):
            return dest, target, encoder

        if binary:
            try:
                _encode_with_ffmpeg(binary, source, dest, target)
                return dest, target, encoder
            except Exception:
                # A broken ffmpeg should not cost the user the share: fall
                # through to libsndfile, which is always present here.
                dest.unlink(missing_ok=True)
                dest = out_dir / f"{source.stem}{target.fallback_ext}"
                encoder = "libsndfile"

    with _lock_for(dest):
        if _done(dest):
            return dest, target, encoder
        _encode_with_libsndfile(source, dest, target)
    return dest, target, encoder
