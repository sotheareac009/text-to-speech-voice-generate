"""
The built-in voices.

VoxCPM2 can invent a voice from a natural-language description alone, so the
built-ins are *designed* rather than shipped as audio. All of them are written
as premium lead voices — the main character, not a utility announcer:
resonant, composed, cinematic.

Adding one is a dict entry: the engine serves this table to the UI, so a new
voice shows up as a button without any frontend change. Give it an `f0_range`
that doesn't sit on top of an existing voice's, or the two will converge on the
same register and there'll be no point having both.

A designed voice is re-rolled on every call, which would mean a different
person reading each sentence. So the description is rendered once to a short
clip and that clip becomes the timbre reference for every take afterwards. The
clip is cached under a name carrying a fingerprint of the description and the
design settings, so editing any of them regenerates it instead of silently
serving the old voice forever.

The cached clip is conditioned before it is stored — level and rumble only.
Nothing tonal: a reference is cloned *from*, so presence or air added here
would be baked into every take made with that voice.

    from voices import BUILTIN_VOICES, designed_voice
    path = designed_voice(model, "female", voices_dir, lock)
"""

from __future__ import annotations

import hashlib
import re
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from mastering import condition_reference


@dataclass(frozen=True)
class BuiltinVoice:
    key: str
    label: str
    blurb: str
    #: Handed to VoxCPM2's voice design. Gender, age, tone, emotion, pace — in
    #: that spirit; piling on adjectives past that dilutes it. Wording matters
    #: more than it looks: "deep, rich chest tone" dragged the male voice down
    #: to a 74-87 Hz boom with the sub-100 Hz band louder than its own formants,
    #: and naming an age instead put it at a normal 103 Hz with the steadiest
    #: periodicity of any take measured.
    describe: str
    #: Where this voice's fundamental should land. Design is re-rolled a few
    #: times and the take closest to this range is the one that gets cached.
    f0_range: tuple[float, float]
    #: Voices sharing a group are variants of one choice: the interface shows
    #: one button per group and a dropdown to pick between its variants, which
    #: keeps the picker from growing a button per voice.
    group: str
    #: Short name for the dropdown, where the group is already on the button.
    variant: str


BUILTIN_VOICES: dict[str, BuiltinVoice] = {
    "female": BuiltinVoice(
        key="female",
        label="Lead female",
        blurb="Premium main-character voice — warm, resonant, composed.",
        describe=(
            "A premium leading female voice, young adult, warm and resonant, "
            "composed and confident, cinematic narrator, smooth and unhurried"
        ),
        f0_range=(165.0, 265.0),
        group="Female",
        variant="Lead",
    ),
    "male": BuiltinVoice(
        key="male",
        label="Lead male",
        blurb="Premium main-character voice — warm, resonant, assured.",
        describe=(
            "A premium leading male voice, a man in his thirties, warm and resonant, "
            "clear and confident, cinematic narrator, smooth and unhurried"
        ),
        f0_range=(90.0, 150.0),
        group="Male",
        variant="Lead (30s)",
    ),
    "male_young": BuiltinVoice(
        key="male_young",
        label="Young male",
        blurb="Premium main-character voice — bright and youthful, early twenties.",
        describe=(
            "A premium leading male voice, a young man of about twenty-three, bright "
            "and warm, clear and confident, cinematic narrator, smooth and unhurried"
        ),
        # Skewed above the thirties voice: a younger male voice generally sits a
        # little higher, and keeping the ranges apart stops the two built-ins
        # from converging on the same register.
        f0_range=(115.0, 175.0),
        group="Male",
        variant="Young (23)",
    ),
}

#: Nobody ever hears this — it is phonetic material for the design pass, so it
#: only has to be real Khmer with some variety in it.
SEED_TEXT = "សួស្ដីអ្នកទាំងអស់គ្នា។ ថ្ងៃទីដប់ពីរ ខែឧសភា ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ។"

#: The design pass runs once per voice, so it can afford to be thorough.
DESIGN_CFG = 2.0
DESIGN_TIMESTEPS = 30
#: How many takes to design before picking one. Voice design varies a lot run
#: to run — the same wording measured 74 Hz once and 87 Hz the next time — and
#: whichever take gets cached *becomes* the voice for good. One roll is a
#: lottery, so take a few and keep the best-measuring one. Paid once, ever.
DESIGN_TAKES = 3
#: Where the reference clip is levelled to. Predictable beats loud.
REFERENCE_LUFS = -20.0

_LEGACY_SEEDS = ("_default_female.wav", "_default_male.wav")


#: Fingerprints are exactly this many hex characters. Pinned down because a
#: loose `_builtin_male_*` glob also matches `_builtin_male_young_…`, so
#: redesigning one voice would delete another's cache.
_FINGERPRINT_CHARS = 10


def fingerprint(voice: BuiltinVoice) -> str:
    """Identifies this voice *and* how it was designed."""
    recipe = "\x00".join([
        voice.describe,
        SEED_TEXT,
        str(DESIGN_CFG),
        str(DESIGN_TIMESTEPS),
        str(REFERENCE_LUFS),
        str(DESIGN_TAKES),
        str(voice.f0_range),
    ])
    return hashlib.sha256(recipe.encode("utf-8")).hexdigest()[:_FINGERPRINT_CHARS]


def seed_name(voice: BuiltinVoice) -> str:
    return f"_builtin_{voice.key}_{fingerprint(voice)}.wav"


def _drop_stale_seeds(voices_dir: Path, key: str, keep: Path) -> None:
    """Remove earlier takes of *this* voice only.

    The name has to be matched exactly, not globbed: `_builtin_male_*` also
    matches `_builtin_male_young_…`, so a loose pattern would have the thirties
    voice delete the young one's cache every time it was redesigned. User
    uploads live in this directory too, under their uuid, and are never touched.
    """
    pattern = re.compile(rf"^_builtin_{re.escape(key)}_[0-9a-f]{{{_FINGERPRINT_CHARS}}}\.wav$")
    for stale in voices_dir.iterdir():
        if stale != keep and pattern.match(stale.name):
            try:
                stale.unlink()
            except OSError:
                pass
    legacy = voices_dir / f"_default_{key}.wav"
    if legacy.name in _LEGACY_SEEDS and legacy.exists():
        try:
            legacy.unlink()
        except OSError:
            pass


def designed_voice(
    model, key: str, voices_dir: Path, lock: threading.Lock | None = None
) -> str:
    """Path to this voice's reference clip, designing it on first use."""
    voice = BUILTIN_VOICES.get(key)
    if voice is None:
        raise KeyError(f"No built-in voice {key!r}.")

    path = voices_dir / seed_name(voice)
    if path.exists():
        return str(path)

    with lock if lock is not None else threading.Lock():
        if path.exists():                       # another request got there first
            return str(path)
        print(
            f"[engine] designing the built-in {key} voice — {DESIGN_TAKES} takes, "
            f"keeping the best. Once only.",
            flush=True,
        )
        rate = model.tts_model.sample_rate

        best: np.ndarray | None = None
        best_score: tuple | None = None
        for take in range(DESIGN_TAKES):
            audio = np.asarray(
                model.generate(
                    text=f"({voice.describe}){SEED_TEXT}",
                    cfg_value=DESIGN_CFG,
                    inference_timesteps=DESIGN_TIMESTEPS,
                ),
                dtype="float32",
            ).reshape(-1)
            if audio.size < int(0.4 * rate) or not np.any(audio):
                print(f"[engine]   take {take + 1}: empty, skipping", flush=True)
                continue

            audio = condition_reference(audio, rate, REFERENCE_LUFS)
            score, note = _score_take(audio, rate, voice)
            print(f"[engine]   take {take + 1}: {note}", flush=True)
            if best_score is None or score > best_score:
                best, best_score = audio, score

        if best is None:
            raise RuntimeError(
                f"Every {key} voice design came back empty. Nothing is cached, so "
                f"the next request will try again."
            )

        sf.write(path, best, rate)
        _drop_stale_seeds(voices_dir, key, keep=path)
        print(f"[engine] built-in {key} voice ready: {path.name}", flush=True)
    return str(path)


def _score_take(audio: np.ndarray, rate: int, voice: BuiltinVoice) -> tuple[tuple, str]:
    """Rank one design take. Higher is better.

    Two things decide it: whether the fundamental landed in the range this voice
    is meant to occupy, and how much of the clip is steadily pitched. A low
    voiced ratio means a creaky or breathy take, which makes a poor reference —
    everything cloned from it inherits the wobble.
    """
    from consistency import voice_print

    print_ = voice_print(audio, rate)
    low, high = voice.f0_range
    in_range = bool(np.isfinite(print_.f0_hz) and low <= print_.f0_hz <= high)
    # Distance outside the range, so a near miss still beats a wild one.
    if not np.isfinite(print_.f0_hz):
        miss = float("inf")
    else:
        miss = max(0.0, low - print_.f0_hz, print_.f0_hz - high)
    score = (in_range, -miss, print_.voiced_ratio)
    note = (
        f"f0 {print_.f0_hz:6.1f} Hz "
        f"({'in range' if in_range else f'{miss:+.0f} Hz outside {low:.0f}-{high:.0f}'}), "
        f"voiced {100 * print_.voiced_ratio:4.1f}%, {len(audio) / rate:4.2f}s"
    )
    return score, note


def voice_catalog() -> list[dict]:
    """The built-ins as plain data, for the UI."""
    return [
        {
            "key": v.key,
            "label": v.label,
            "blurb": v.blurb,
            "describe": v.describe,
            "group": v.group,
            "variant": v.variant,
        }
        for v in BUILTIN_VOICES.values()
    ]
