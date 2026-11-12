"""
Commercial voice tuner: delivery presets for product promos.

VoxCPM2 takes a control instruction in parentheses at the start of the text and
uses it to steer delivery — emotion, pace, emphasis — while a reference clip
still pins the timbre. So the same voice, built-in or cloned, can read the same
script as a hard-sell retail spot or as a calm premium brand line.

    (energetic upbeat advertising voice, very high energy)Buy one, get one free!

The instruction never gets spoken; it shapes how the rest is read. This module
turns a preset plus two sliders into that string and the matching synthesis
settings. The chunker prepends it to every chunk, so a long script keeps one
performance from start to finish.

    from styles import build_direction
    d = build_direction("promo", energy=4, pace="fast")
    d.instruction   # "(energetic upbeat advertising voice, ...)"
"""

from __future__ import annotations

from dataclasses import dataclass

from mastering import CLEANUP_DEFAULT, DEFAULT_MASTERING


@dataclass(frozen=True)
class Style:
    key: str
    label: str
    blurb: str
    #: Fed to VoxCPM2 as the parenthetical control instruction.
    describe: str
    #: Guidance scale. Higher follows the instruction harder but can get stiff.
    cfg_value: float
    #: Default mastering voicing for this kind of read.
    mastering: str
    #: Where the sliders sit for this style. Pushing a calm style to energy 5
    #: produces a self-contradicting instruction, so each one starts where it
    #: actually reads — the UI snaps the sliders here when the preset changes.
    energy: int
    pace: str


STYLES: dict[str, Style] = {
    "promo": Style(
        key="promo",
        label="High-energy promo",
        blurb="Retail-ad energy. Launches, discounts, limited offers.",
        describe="energetic upbeat advertising voice, bright and smiling, punchy emphasis",
        cfg_value=2.3,
        mastering="punchy",
        energy=4,
        pace="fast",
    ),
    "premium": Style(
        key="premium",
        label="Premium brand",
        blurb="Calm, low and deliberate. Makes the product sound expensive.",
        describe="calm confident voice, warm and low, cinematic and deliberate, trustworthy",
        cfg_value=2.0,
        mastering="broadcast",
        energy=3,
        pace="slow",
    ),
    "friendly": Style(
        key="friendly",
        label="Friendly explainer",
        blurb="Natural and approachable. Demos, how-it-works, app walkthroughs.",
        describe="friendly conversational voice, natural and approachable, light smile",
        cfg_value=1.9,
        mastering="broadcast",
        energy=3,
        pace="natural",
    ),
    "announcer": Style(
        key="announcer",
        label="Announcer",
        blurb="Bold and urgent. Event spots and anything with a deadline.",
        describe="bold authoritative announcer voice, strong projection, urgent and commanding",
        cfg_value=2.4,
        mastering="punchy",
        energy=5,
        pace="fast",
    ),
    # The five presets above are all advertising reads, which left anything
    # that is simply *told* — a story, a report, a piece of news, a personal
    # account — with no setting that fits. Every option pushed a sell onto
    # copy that was not selling anything, so the honest answer to "which one
    # should I use" was "none of them". These two close that gap.
    "narrative": Style(
        key="narrative",
        label="Storyteller",
        blurb="Telling, not selling. Stories, reports, explanation, news.",
        describe="measured storytelling voice, natural and expressive, unhurried and clear",
        cfg_value=1.9,
        mastering="broadcast",
        energy=3,
        pace="natural",
    ),
    "heartfelt": Style(
        key="heartfelt",
        label="Heartfelt",
        blurb="Gentle and sincere, with weight. Difficult or moving subjects.",
        describe="gentle sincere voice, warm and unhurried, quietly emotional, thoughtful",
        cfg_value=1.8,
        # Light, not broadcast: compressing an emotional read flattens the very
        # dynamics that carry the feeling.
        mastering="light",
        energy=2,
        pace="slow",
    ),
    "testimonial": Style(
        key="testimonial",
        label="Testimonial",
        blurb="Sincere and unpolished, like a real customer talking.",
        describe="sincere natural voice, relaxed and unhurried, speaking from experience",
        cfg_value=1.8,
        mastering="light",
        energy=2,
        pace="natural",
    ),
}

DEFAULT_STYLE = "promo"

# Energy 1–5: how hard the read pushes. Each step is (UI label, phrase added to
# the instruction, nudge to the guidance scale). Level 3 adds nothing — the
# style's own wording stands.
ENERGY_LEVELS: dict[int, tuple[str, str, float]] = {
    1: ("Understated", "understated and calm", -0.4),
    2: ("Gentle", "gently expressive", -0.2),
    3: ("As written", "", 0.0),
    4: ("Strong", "strongly expressive, clear emphasis", 0.2),
    5: ("Full tilt", "very high energy, excited", 0.4),
}

# Pace: (UI label, phrase for the model, pause left between sentences).
PACE_LEVELS: dict[str, tuple[str, str, float]] = {
    "slow": ("Slow", "slower, deliberate pace", 0.30),
    "natural": ("Natural", "", 0.18),
    "fast": ("Fast", "slightly faster pace", 0.10),
}

DEFAULT_ENERGY = 4
DEFAULT_PACE = "natural"


@dataclass(frozen=True)
class Direction:
    """Everything the engine needs to perform one take."""

    style: str
    energy: int
    pace: str
    #: "(...)" to prepend to each chunk, or "" for an undirected read.
    instruction: str
    cfg_value: float
    gap_seconds: float
    mastering: str


def build_direction(
    style: str = DEFAULT_STYLE,
    energy: int | None = None,
    pace: str | None = None,
    mastering: str | None = None,
) -> Direction:
    """Turn a preset and the two sliders into a concrete direction.

    `energy`, `pace` and `mastering` fall back to the preset's own settings, so
    picking a style alone already gives a coherent read.
    """
    preset = STYLES.get(style) or STYLES[DEFAULT_STYLE]
    energy = int(energy) if energy in ENERGY_LEVELS else preset.energy
    pace = pace if pace in PACE_LEVELS else preset.pace

    _, energy_phrase, cfg_shift = ENERGY_LEVELS[energy]
    _, pace_phrase, gap = PACE_LEVELS[pace]

    parts = [preset.describe, energy_phrase, pace_phrase]
    instruction = "(" + ", ".join(p for p in parts if p) + ")"

    return Direction(
        style=preset.key,
        energy=energy,
        pace=pace,
        instruction=instruction,
        # Keep guidance in the range the model behaves in: below ~1.4 it wanders
        # off the instruction, above ~3.0 it goes flat and clipped.
        cfg_value=round(min(3.0, max(1.4, preset.cfg_value + cfg_shift)), 2),
        gap_seconds=gap,
        mastering=mastering if mastering is not None else preset.mastering,
    )


def plain_direction(mastering: str = CLEANUP_DEFAULT, pace: str = "natural") -> Direction:
    """An undirected read — the tuner switched off — optionally paced.

    Still mastered. Switching off the *performance* is a reasonable thing to
    want; shipping an uncleaned read is not, so this defaults to the cleanup
    voicing rather than to no processing. "off" remains available explicitly.

    Wanting to slow a read down without also making it sound like an advert is
    an ordinary thing to want, so `pace` is honoured here as well. It is the
    one tuner control that still means something with no style attached, and
    it works on two levels:

    * **"natural" sends no instruction at all.** That is what keeps the
      default path undirected in the strict sense, which matters because an
      instruction and a reference transcript cannot be combined — the moment
      there is one, continuation cloning is dropped and the voice holds less
      steadily (113 Hz spread undirected against 138 Hz directed).
    * **"fast" sends the pace phrase on its own.** That measurably speeds the
      read up (-8% on a Khmer sentence, three runs each), at the cost of the
      continuation cloning above. It is the smallest instruction that can do
      the job: it directs the speed without dictating a performance the copy
      may not want.
    * **"slow" sends the same kind of phrase, but do not expect much of it.**
      VoxCPM2 does not obey it in Khmer. Measured over three runs each on one
      sentence, against a 3.52 s baseline:

          (slower, deliberate pace)                 3.47 s   -1.5%
          (speaking very slowly)                    3.36 s   -4.5%
          (slow unhurried delivery, taking time)    3.57 s   +1.5%
          (slower, deliberate pace) at cfg 2.6      3.63 s   +3.0%
          (speaking very slowly) at cfg 2.6         3.41 s   -3.0%

      Every one of those is smaller than the run-to-run spread, so there is no
      wording here worth preferring — the model simply does not slow down for
      Khmer. What "slow" *does* reliably change is the gap below. Genuinely
      slowing the delivery would need the audio time-stretched after the fact,
      which is a quality trade-off nobody has asked for yet.

    The inter-sentence gap follows the pace either way, since that needs no
    instruction at all, and it is the part that works in both directions.
    """
    pace = pace if pace in PACE_LEVELS else "natural"
    _, phrase, gap = PACE_LEVELS[pace]
    return Direction(
        style="none", energy=DEFAULT_ENERGY, pace=pace,
        instruction=f"({phrase})" if phrase else "",
        cfg_value=2.0, gap_seconds=gap, mastering=mastering,
    )


def style_catalog() -> list[dict]:
    """The presets as plain data, for the UI."""
    return [
        {
            "key": s.key,
            "label": s.label,
            "blurb": s.blurb,
            "describe": s.describe,
            "mastering": s.mastering,
            "energy": s.energy,
            "pace": s.pace,
        }
        for s in STYLES.values()
    ]


def tuner_catalog() -> dict:
    """Everything the UI needs to build the tuner panel."""
    from mastering import mastering_catalog

    return {
        "styles": style_catalog(),
        "mastering": mastering_catalog(),
        # `phrase` is exactly what gets added to the instruction, so the UI can
        # preview the real thing rather than an approximation of it.
        "energy": [
            {"value": v, "label": label, "phrase": phrase}
            for v, (label, phrase, _) in sorted(ENERGY_LEVELS.items())
        ],
        "pace": [
            {"value": k, "label": label, "phrase": phrase}
            for k, (label, phrase, _) in PACE_LEVELS.items()
        ],
        "defaults": {
            "style": DEFAULT_STYLE,
            "energy": DEFAULT_ENERGY,
            "pace": DEFAULT_PACE,
            "mastering": DEFAULT_MASTERING,
            # What still runs when the tuner is switched off.
            "cleanup": CLEANUP_DEFAULT,
        },
    }
