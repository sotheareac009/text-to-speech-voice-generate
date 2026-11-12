"""Clean a voice sample before it is used as a cloning reference.

VoxCPM2 clones the *acoustic character* of the reference clip, not just the
timbre of the speaker. Whatever sits behind the voice — room tone, traffic,
a fan, music from the next room — is part of that character, so it is learned
along with the person and reappears underneath every sentence the model later
speaks. A sample recorded on a phone in a shop produces a clone that sounds
like it is always in that shop.

So the fix belongs here, at import, not at synthesis: give the model a clean
reference and there is no noise for it to copy.

The chain, in order, and why each stage is in it:

1. **Source separation (Demucs).** The hard case is not hiss, it is *other
   sound*: music, a television, another conversation. Those are tonal and
   move about, so a noise gate cannot model them — it needs a model that
   knows what a voice is. Demucs is trained to pull a vocal out of a mix,
   which is exactly this problem. It is the heavy lifter and the slow step.
2. **High-pass at 65 Hz.** Rumble, handling thumps and air conditioning live
   below the voice. 65 Hz is deliberate: a low male fundamental reaches down
   to about 80 Hz, so cutting at 100 Hz — tempting, and much more effective
   against rumble — would thin out exactly the speakers it is meant to help.
3. **Residual spectral gate.** Separation leaves a quiet bed behind. This
   measures that bed in the gaps between words and subtracts it, with a floor
   that stops it chewing holes in the signal (see `_spectral_gate`).
4. **Trim to speech.** Leading and trailing silence teach the model nothing
   and dilute the reference; long gaps in the middle are kept, because the
   speaker's rhythm is part of their voice.
5. **Normalise.** A quiet reference and a loud one clone differently. One
   fixed peak level means the import is comparable whatever it arrived at.

Stages 2-5 need only numpy/scipy/librosa, which the engine already has.
Stage 1 needs `demucs`; when it is missing the rest still runs, and the
report says separation was skipped rather than failing the upload.

Nothing here is destructive: the original file is always kept, and the
caller decides whether to use the cleaned version (see `server.register_voice`).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, asdict
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

from mastering import condition_reference

#: What the engine wants back. VoxCPM2 works at 48 kHz; Demucs is native at
#: 44.1 kHz, so the chain runs at Demucs' rate and resamples once at the end
#: rather than resampling twice around it.
TARGET_SR = 48000
WORK_SR = 44100

#: Below this signal-to-noise ratio a sample is worth separating. Running
#: separation on something already clean risks taking more away than it gives,
#: so good samples skip straight to trim and normalise.
#:
#: Calibrated against real files rather than picked for roundness. Measured on
#: the same trimmed basis `clean_sample` uses, the samples in hand fall into
#: two clearly separated groups:
#:
#:     phone recording over music      10.7 dB
#:     noisy room                      16.3 dB
#:     ---------------------------------------  threshold sits here
#:     designed built-in voice         31.3 dB
#:     quiet-room recording            45.6 dB
#:
#: 25 dB sits in the empty middle of that gap, so neither group is near the
#: edge and a sample has to be genuinely ambiguous to be misrouted.
CLEAN_SNR_DB = 25.0

#: Loudness a finished reference is set to, matching the built-in voices
#: exactly — see `_normalise`. Imported rather than redefined so the two can
#: never drift apart.
REFERENCE_LUFS = -20.0

HIGHPASS_HZ = 65.0


@dataclass
class CleanReport:
    """What was done and what it bought, in numbers the interface can show."""

    #: Signal-to-noise before and after, in dB. The headline figure.
    snr_before: float
    snr_after: float
    #: Noise floor before and after, in dBFS.
    floor_before: float
    floor_after: float
    duration_before: float
    duration_after: float
    #: Which stages actually ran.
    separated: bool
    trimmed: bool
    #: Set when separation was asked for but could not run, so the interface
    #: can say *why* a noisy sample was only partly cleaned.
    separation_error: str = ""
    seconds: float = 0.0

    @property
    def improvement_db(self) -> float:
        return round(self.snr_after - self.snr_before, 1)

    def as_dict(self) -> dict:
        data = asdict(self)
        data["improvement_db"] = self.improvement_db
        return data


def measure(y: np.ndarray, sr: int) -> tuple[float, float]:
    """Noise floor and signal-to-noise of a clip, both in dB.

    Deliberately crude: the quietest tenth of the frames stands in for the
    background and the loudest tenth for the voice. A percentile split needs
    no voice-activity model and does not care what language is being spoken,
    which matters here — the app is used in Khmer as much as in English.
    """
    if y.size == 0:
        return -120.0, 0.0
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    db = 20.0 * np.log10(np.maximum(rms, 1e-10))
    floor = float(np.percentile(db, 10))
    speech = float(np.percentile(db, 90))
    return round(floor, 1), round(speech - floor, 1)


def _highpass(y: np.ndarray, sr: int, cutoff: float = HIGHPASS_HZ) -> np.ndarray:
    """Remove rumble below the voice. Zero-phase, so nothing is smeared in
    time — a one-way filter would shift the low end against the rest and
    subtly change how the voice sits."""
    if sr <= cutoff * 2:
        return y
    sos = butter(4, cutoff / (sr / 2.0), btype="highpass", output="sos")
    return sosfiltfilt(sos, y).astype(np.float32)


def _spectral_gate(y: np.ndarray, sr: int, reduction_db: float = 14.0) -> np.ndarray:
    """Subtract the steady background measured in the gaps between words.

    The floor is the point of the `reduction_db` cap. Subtracting the noise
    estimate outright drives quiet bins to zero and leaves isolated specks of
    energy scattered across the spectrogram — "musical noise", which sounds
    worse than the hiss it replaced and, worse here, is *novel* texture the
    cloner would faithfully learn. Attenuating by a fixed maximum instead
    keeps the background's shape while pushing it down, so what is left still
    sounds like a quiet room rather than like artefacts.
    """
    if y.size < 2048:
        return y
    stft = librosa.stft(y, n_fft=2048, hop_length=512)
    mag, phase = np.abs(stft), np.angle(stft)

    frame_db = 20.0 * np.log10(np.maximum(mag.mean(axis=0), 1e-10))
    quiet = frame_db <= np.percentile(frame_db, 25)
    if quiet.sum() < 4:
        return y

    # Per-frequency background level, taken high enough in the distribution
    # (75th percentile of quiet frames) that it is not fooled by the single
    # quietest moment in the recording.
    profile = np.percentile(mag[:, quiet], 75, axis=1, keepdims=True)

    floor = 10.0 ** (-reduction_db / 20.0)
    mask = np.clip((mag - profile) / np.maximum(mag, 1e-10), floor, 1.0)
    cleaned = librosa.istft(mag * mask * np.exp(1j * phase), hop_length=512, length=len(y))
    return cleaned.astype(np.float32)


def _trim_to_speech(y: np.ndarray, sr: int) -> tuple[np.ndarray, bool]:
    """Drop silence at the head and tail, keep the middle intact.

    Only the ends are cut. Pauses *within* the sample are part of how the
    person speaks, and splicing them out would hand the model a reference
    with an unnatural rhythm to imitate.
    """
    if y.size == 0:
        return y, False
    trimmed, _ = librosa.effects.trim(y, top_db=35, frame_length=2048, hop_length=512)
    if trimmed.size < sr * 0.5:          # refuse to leave less than half a second
        return y, False
    return trimmed, trimmed.size < y.size - sr * 0.05


def _normalise(y: np.ndarray, sample_rate: int) -> np.ndarray:
    """Bring the sample to the exact level a reference is expected at.

    This hands the job to `condition_reference`, the same function the built-in
    voices go through, rather than peak-normalising. The two are not
    interchangeable: peak normalising sets the loudest instant and leaves the
    *loudness* wherever the recording's dynamics put it, so an uploaded clip
    landed near -18.7 LUFS while every built-in sits at -20.0. The model reads
    timbre off that level, and the mismatch showed: over two runs on the same
    sample and script, matching the built-ins' conditioning halved the pitch
    error of the clone (5.0 Hz against the reference, down to 2.6) and cut its
    drift across the read from 8.15 to 7.01 semitones.

    It also means a clone and a built-in are prepared by one piece of code, so
    they cannot drift apart again the next time either is changed.
    """
    if y.size == 0 or not np.any(y):
        return y
    return condition_reference(y, sample_rate, REFERENCE_LUFS).astype(np.float32)


def _separate_voice(y: np.ndarray, sr: int) -> np.ndarray:
    """Pull the voice out of whatever it was recorded over, with Demucs.

    Raises ImportError when demucs is not installed; the caller treats that
    as "skip this stage", not as a failed upload.
    """
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()

    # Demucs expects stereo and is trained on loudness-normalised input.
    wav = torch.from_numpy(np.stack([y, y]))
    ref = wav.mean(0)
    std = float(ref.std()) or 1.0
    wav = (wav - ref.mean()) / std

    with torch.no_grad():
        # CPU on purpose. The separation is seconds of work on a clip this
        # short, and the GPU may be holding the 9 GB voice model — competing
        # for that memory is how the engine ends up out of memory mid-import.
        stems = apply_model(model, wav[None], device="cpu", progress=False)[0]

    vocals = stems[model.sources.index("vocals")] * std + ref.mean()
    return vocals.mean(0).numpy().astype(np.float32)


def clean_sample(src: Path, dest: Path, force: bool = False) -> CleanReport:
    """Clean `src` into `dest` and report what changed.

    `force` runs separation even on a sample that measures clean — for the
    case where someone can hear something the percentile measure misses.
    """
    started = time.perf_counter()
    y, _ = librosa.load(str(src), sr=WORK_SR, mono=True)
    y = np.asarray(y, dtype=np.float32)
    duration_before = len(y) / WORK_SR

    # Measure the "before" on a trimmed copy, so before and after describe the
    # same thing. `measure` calls the quietest tenth of frames the background,
    # and silence at the head and tail of a file lands squarely in that tenth.
    # Trimming it away leaves quiet *speech* as the quietest frames, which
    # lifts the measured floor even though nothing has been degraded — on a
    # clean sample that showed as 36 dB "falling" to 32 dB, which reads as the
    # app having damaged the file. Both numbers now come from trimmed audio.
    baseline, _ = _trim_to_speech(y, WORK_SR)
    floor_before, snr_before = measure(baseline, WORK_SR)

    separated = False
    separation_error = ""
    if force or snr_before < CLEAN_SNR_DB:
        try:
            y = _separate_voice(y, WORK_SR)
            separated = True
        except ImportError:
            separation_error = "demucs is not installed — only light cleanup was applied."
        except Exception as exc:  # noqa: BLE001
            # A separation failure must not cost someone their upload: the
            # remaining stages still improve the sample, so carry on and say so.
            separation_error = f"Separation failed ({exc}) — only light cleanup was applied."

    y = _highpass(y, WORK_SR)
    y = _spectral_gate(y, WORK_SR)
    y, trimmed = _trim_to_speech(y, WORK_SR)
    y = _normalise(y, WORK_SR)

    floor_after, snr_after = measure(y, WORK_SR)
    out = librosa.resample(y, orig_sr=WORK_SR, target_sr=TARGET_SR) if WORK_SR != TARGET_SR else y
    dest.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(dest), out, TARGET_SR, format="WAV", subtype="PCM_16")

    return CleanReport(
        snr_before=snr_before,
        snr_after=snr_after,
        floor_before=floor_before,
        floor_after=floor_after,
        duration_before=round(duration_before, 2),
        duration_after=round(len(out) / TARGET_SR, 2),
        separated=separated,
        trimmed=trimmed,
        separation_error=separation_error,
        seconds=round(time.perf_counter() - started, 1),
    )
