"""
Voice consistency across chunks.

A long script is synthesised chunk by chunk, each one its own `generate()` call,
so nothing forces chunk five to sound like the same person as chunk one — and
sometimes it doesn't. This measures how far a chunk has drifted from the
reference voice, so the caller can re-roll the ones that wandered off.

Two cues, because each alone has a blind spot:

  * **median f0, in semitones.** Pitch register is the strongest "that's
    somebody else" signal, and it barely depends on what is being said.
  * **mean-MFCC cosine distance.** Catches a timbre change at the same pitch,
    but it also moves with phonetic content — a line of vowels and a line of
    fricatives differ without any drift — so it is the weaker, secondary cue
    and carries a looser threshold.

`yin` is used rather than `pyin`: this runs on every chunk of every request and
the probabilistic version costs several times more for accuracy we don't need
when the question is only "same person or not".
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

#: Frames quieter than this below the chunk's peak are treated as non-speech,
#: so silence and breaths don't drag the pitch estimate around.
_SPEECH_FLOOR_DB = -25.0
_FRAME, _HOP = 2048, 512

# Set from measurement, not taste. On a real eight-sentence script the chunks
# landed within about 2.5 semitones of their own median and their mean-MFCC
# distances sat around 0.005, while a clearly different voice measured 0.038.
# So pitch does the work and timbre only catches gross breaks — which is right,
# given timbre also moves with phonetic content.
#: A chunk beyond *either* limit is re-rolled.
MAX_SEMITONES = 2.0
MAX_TIMBRE = 0.05


@dataclass(frozen=True)
class VoicePrint:
    """Enough of a voice to tell whether two clips are the same person."""

    f0_hz: float
    mfcc: np.ndarray
    voiced_ratio: float

    @property
    def usable(self) -> bool:
        return bool(np.isfinite(self.f0_hz)) and self.mfcc.size > 0


def voice_print(audio: np.ndarray, sample_rate: int) -> VoicePrint:
    x = np.ascontiguousarray(np.asarray(audio, dtype="float32").reshape(-1))
    if x.size < _FRAME or not np.any(x):
        return VoicePrint(float("nan"), np.zeros(0, dtype="float32"), 0.0)

    rms = librosa.feature.rms(y=x, frame_length=_FRAME, hop_length=_HOP)[0]
    f0 = librosa.yin(x, fmin=60.0, fmax=400.0, sr=sample_rate,
                     frame_length=_FRAME, hop_length=_HOP)
    n = min(len(rms), len(f0))
    rms, f0 = rms[:n], f0[:n]

    speech = rms > rms.max() * 10.0 ** (_SPEECH_FLOOR_DB / 20.0)
    pitched = f0[speech & np.isfinite(f0)]
    mfcc = librosa.feature.mfcc(y=x, sr=sample_rate, n_mfcc=20,
                                hop_length=_HOP).mean(axis=1)
    return VoicePrint(
        f0_hz=float(np.median(pitched)) if pitched.size else float("nan"),
        mfcc=np.asarray(mfcc, dtype="float32"),
        voiced_ratio=float(np.mean(speech)),
    )


def semitones_apart(a: VoicePrint, b: VoicePrint) -> float:
    """Pitch difference in semitones — scale-free, so it reads the same for a
    low voice as a high one. nan when either clip has no usable pitch."""
    if not (np.isfinite(a.f0_hz) and np.isfinite(b.f0_hz)) or a.f0_hz <= 0 or b.f0_hz <= 0:
        return float("nan")
    return float(abs(12.0 * np.log2(b.f0_hz / a.f0_hz)))


def timbre_apart(a: VoicePrint, b: VoicePrint) -> float:
    if a.mfcc.size == 0 or b.mfcc.size == 0:
        return float("nan")
    denom = float(np.linalg.norm(a.mfcc) * np.linalg.norm(b.mfcc))
    if denom <= 0:
        return float("nan")
    return float(1.0 - np.dot(a.mfcc, b.mfcc) / denom)


def drift(reference: VoicePrint, chunk: VoicePrint) -> tuple[float, float]:
    return semitones_apart(reference, chunk), timbre_apart(reference, chunk)


def drift_score(
    reference: VoicePrint,
    chunk: VoicePrint,
    max_semitones: float = MAX_SEMITONES,
    max_timbre: float = MAX_TIMBRE,
) -> float:
    """One number for "how far off", for choosing between re-rolls.

    Each cue is divided by its own limit before being added, so the two are
    comparable despite being in different units; 1.0 is roughly "at the limit".
    A cue that couldn't be measured contributes nothing rather than poisoning
    the total with a nan.
    """
    pitch, timbre = drift(reference, chunk)
    total = 0.0
    if np.isfinite(pitch):
        total += pitch / max_semitones
    if np.isfinite(timbre):
        total += timbre / max_timbre
    return total


def has_drifted(
    reference: VoicePrint,
    chunk: VoicePrint,
    max_semitones: float = MAX_SEMITONES,
    max_timbre: float = MAX_TIMBRE,
) -> bool:
    """Whether this chunk is far enough off to be worth generating again.

    Unmeasurable means "keep it": a chunk with no usable pitch is usually a
    short one, and re-rolling on a failed measurement would burn time without
    improving anything.
    """
    if not (reference.usable and chunk.usable):
        return False
    pitch, timbre = drift(reference, chunk)
    if np.isfinite(pitch) and pitch > max_semitones:
        return True
    return bool(np.isfinite(timbre) and timbre > max_timbre)
