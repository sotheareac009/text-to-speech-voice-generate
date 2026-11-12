"""
Long-form synthesis for VoxCPM2.

The model generates the whole text in one autoregressive pass, which stays clean
for a sentence or two and then starts to tear, drift or repeat. The fix is to cut
the text into short chunks and synthesise them one at a time.

Doing that naively introduces a second problem: with no reference audio, the
model picks a *different* voice on every call, so the chunks wouldn't match. So
the first chunk's audio is reused as the reference for the rest, which pins the
voice for the whole piece.

The third problem is the voice itself wandering. Each chunk is a separate
generation, and a reference clip steers it without guaranteeing it, so now and
then one sentence comes back sounding like somebody else. Each chunk is
measured against the reference voice and the ones that have drifted are
generated again — see `consistency.py` for what "drifted" means.

A fourth problem shows up on scripts long enough to matter: each chunk is its
own generation, so their levels drift — one sentence lands 4 dB under the next.
`level_match` measures each chunk and pulls them together before they are
joined, which matters most for ad reads where the whole thing gets mastered to
a fixed loudness afterwards.

    from longform import generate_long
    wav, sr = generate_long(model, text)
    wav, sr = generate_long(model, text, control="(energetic promo voice)")
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from consistency import VoicePrint, drift, drift_score, has_drifted, voice_print
from khmer_normalize import split_scripts
from mastering import loudness_lufs

# Khmer sentence enders (khan, bariyoosan) plus Latin ones and newlines.
_SENTENCE_END = re.compile(r"(?<=[។៕!?\.])\s*|\n+")
# Safe places to break a sentence that is still too long.
_SOFT_BREAK = re.compile(r"(?<=[,，;:៖])\s*")

DEFAULT_MAX_CHARS = 90          # ~6–8s of Khmer speech per chunk

#: How long a *single sentence* may get before it is broken up. Larger than
#: `DEFAULT_MAX_CHARS` on purpose: that limit exists to stop the voice drifting
#: across a long script, which is a per-chunk problem, while breaking inside a
#: sentence causes a different and worse one. Each chunk is generated on its
#: own, so a piece ending mid-clause still gets utterance-final intonation and
#: a full pause — the reader hears a full stop where the grammar has none.
#: A 137-character Khmer sentence rendered cleanly as a single chunk, so the
#: old limit was splitting sentences that never needed splitting.
SENTENCE_MAX_CHARS = 160

GAP_SECONDS = 0.18              # pause inserted between sentences
#: Pause used when a break falls *inside* a sentence. Measured on a real Khmer
#: paragraph, the old code gave a mid-clause break 0.22 s against 0.27 s for a
#: real sentence end — indistinguishable to a listener, so the sentence
#: appeared to stop in the middle. This keeps the join audible as a breath
#: rather than as a full stop.
MID_SENTENCE_GAP = 0.06
LEVEL_MATCH_LIMIT_DB = 6.0      # most we'll shift one chunk to match the rest
#: Re-rolls allowed per chunk when the voice has drifted. Each one costs a
#: whole extra generation, so this is deliberately small — it is there to catch
#: the occasional stray sentence, not to grind until perfect.
VOICE_RETRIES = 1

#: Shortest script run worth giving its own generation. Below this the model
#: pads or loops instead of saying the words: splitting "Food and Drink" (14
#: chars) out on its own produced near-silence, and a 6-character Khmer run
#: produced a repeat. Measured on mixed Khmer/English UI copy.
MIN_SCRIPT_RUN = 20


def split_mixed_scripts(chunk: str, min_run: int = MIN_SCRIPT_RUN) -> list[str]:
    """Split a chunk at Khmer/English boundaries — but only where it is safe.

    A single generation containing both scripts has to code-switch mid-utterance,
    and the losing language comes out in the other one's phonetics: "Food and
    Drink" inside Khmer was transcribed by a Khmer recogniser as "ហ្វួត អ៊នរីង".
    Giving each language its own generation fixes the phonetics — a Khmer
    recogniser started reading the English as English — while the reference clip
    keeps it the same voice throughout.

    The catch is length. Runs shorter than `min_run` render badly on their own,
    so they are merged back into whichever neighbour is longer, and a chunk
    whose runs are all short is left mixed. Densely interleaved copy — a couple
    of English words per Khmer phrase — therefore stays as it was, because
    splitting it would trade an accent problem for a worse one.
    """
    runs = [(is_khmer, seg) for is_khmer, seg in split_scripts(chunk) if seg.strip()]
    if len(runs) < 2:
        return [chunk.strip()] if chunk.strip() else []

    # Merge each too-short run into the longer of its neighbours, repeatedly:
    # one merge can leave the result still short.
    while len(runs) > 1:
        shortest = min(range(len(runs)), key=lambda i: len(runs[i][1].strip()))
        if len(runs[shortest][1].strip()) >= min_run:
            break
        if shortest == 0:
            target = 1
        elif shortest == len(runs) - 1:
            target = shortest - 1
        else:
            target = shortest - 1 if len(runs[shortest - 1][1]) >= len(runs[shortest + 1][1]) else shortest + 1
        low, high = min(shortest, target), max(shortest, target)
        merged = (runs[target][0], runs[low][1] + runs[high][1])
        runs = runs[:low] + [merged] + runs[high + 1:]

    return [seg.strip() for _, seg in runs if seg.strip()]


def split_marked(
    text: str,
    max_chars: int = DEFAULT_MAX_CHARS,
    sentence_max_chars: int = SENTENCE_MAX_CHARS,
) -> list[tuple[str, bool]]:
    """Cut text into chunks, each tagged with whether it ends a sentence.

    The tag is what lets the join between two chunks sound like what it
    actually is. A chunk that ends a sentence is followed by a sentence-sized
    pause; one that stops mid-clause gets a breath instead. Without it every
    join sounded like a full stop, including the ones in the middle of a
    thought.

    A sentence is only broken up once it passes `sentence_max_chars`, which is
    deliberately higher than `max_chars` — see the note on that constant.
    """
    text = text.strip()
    if not text:
        return []

    chunks: list[tuple[str, bool]] = []
    for sentence in (s.strip() for s in _SENTENCE_END.split(text)):
        if not sentence:
            continue
        if len(sentence) <= sentence_max_chars:
            chunks.append((sentence, True))
            continue

        # Too long even for one sentence: try commas, then fall back to
        # spaces, which in Khmer separate phrases rather than words and so
        # are a real phrase boundary, not an arbitrary cut.
        buffer = ""
        parts: list[str] = []
        pieces = [p for p in _SOFT_BREAK.split(sentence) if p]
        if len(pieces) == 1:
            pieces = sentence.split(" ")
        for piece in pieces:
            candidate = f"{buffer} {piece}".strip() if buffer else piece
            if len(candidate) <= max_chars:
                buffer = candidate
            else:
                if buffer:
                    parts.append(buffer)
                buffer = piece
        if buffer:
            parts.append(buffer)
        # Only the final piece carries the sentence's own ending.
        chunks.extend((p, i == len(parts) - 1) for i, p in enumerate(parts))

    # Finally, separate the languages where the runs are long enough to stand
    # on their own, so no single generation has to code-switch. These splits
    # are inside a chunk, so only the last piece keeps the chunk's ending.
    out: list[tuple[str, bool]] = []
    for chunk, ends in chunks:
        if not chunk.strip():
            continue
        runs = split_mixed_scripts(chunk)
        out.extend((r, ends and i == len(runs) - 1) for i, r in enumerate(runs))
    return out


def split_text(text: str, max_chars: int = DEFAULT_MAX_CHARS) -> list[str]:
    """Cut text into chunks short enough for the model to render cleanly."""
    return [chunk for chunk, _ in split_marked(text, max_chars)]


def match_levels(pieces: list[np.ndarray], sample_rate: int) -> list[np.ndarray]:
    """Pull chunk loudnesses together so the read doesn't step up and down.

    Each chunk is matched to the median of them all, by at most
    LEVEL_MATCH_LIMIT_DB — enough to fix generation drift without flattening a
    deliberately quiet line.
    """
    measured = [loudness_lufs(p, sample_rate) for p in pieces]
    usable = [m for m in measured if np.isfinite(m)]
    if len(usable) < 2:
        return pieces

    target = float(np.median(usable))
    out = []
    for piece, level in zip(pieces, measured):
        if not np.isfinite(level):
            out.append(piece)
            continue
        gain_db = float(np.clip(target - level, -LEVEL_MATCH_LIMIT_DB, LEVEL_MATCH_LIMIT_DB))
        out.append((piece * 10.0 ** (gain_db / 20.0)).astype("float32"))
    return out


def _consensus(prints: list[VoicePrint]) -> VoicePrint:
    """The voice the chunks agree on: element-wise median of their prints."""
    return VoicePrint(
        f0_hz=float(np.median([p.f0_hz for p in prints])),
        mfcc=np.median(np.stack([p.mfcc for p in prints]), axis=0).astype("float32"),
        voiced_ratio=float(np.median([p.voiced_ratio for p in prints])),
    )


def even_out_voice(render, chunks, pieces, sample_rate, retries) -> list[np.ndarray]:
    """Regenerate the sentences that don't sound like the rest of the read.

    The yardstick is the median of the chunks themselves, not the reference
    clip. Measured on a real eight-sentence script, every chunk sits some way
    off the reference and fairly uniformly so — what a listener actually
    notices is one sentence not matching its neighbours, and that is what the
    median catches. It also means a mediocre reference doesn't condemn the
    whole read to being re-rolled against it.

    Only outliers cost anything; the rest are returned untouched.
    """
    prints = [voice_print(piece, sample_rate) for piece in pieces]
    usable = [p for p in prints if p.usable]
    if len(usable) < 3:
        # Too few measurable chunks for a median to mean anything.
        return pieces

    consensus = _consensus(usable)
    out = list(pieces)
    for index, (chunk, current) in enumerate(zip(chunks, prints)):
        if not current.usable or not has_drifted(consensus, current):
            continue
        pitch, timbre = drift(consensus, current)
        print(
            f"[longform] sentence {index + 1} is {pitch:.1f} semitones off the rest "
            f"(timbre {timbre:.3f}) — regenerating",
            flush=True,
        )
        best, best_score = pieces[index], drift_score(consensus, current)
        for _ in range(retries):
            take = render(chunk)
            score = drift_score(consensus, voice_print(take, sample_rate))
            if score < best_score:
                best, best_score = take, score
            if best_score <= 1.0:          # inside the limits — good enough
                break
        out[index] = best
        kept = "re-roll" if best is not pieces[index] else "original (closest)"
        print(f"[longform]   kept the {kept}", flush=True)
    return out


def generate_long(
    model,
    text: str,
    reference_wav: str | None = None,
    prompt_text: str | None = None,
    max_chars: int = DEFAULT_MAX_CHARS,
    cfg_value: float = 2.0,
    inference_timesteps: int = 10,
    control: str = "",
    gap_seconds: float = GAP_SECONDS,
    level_match: bool = True,
    retries: int = VOICE_RETRIES,
    progress=None,
) -> tuple[np.ndarray, int]:
    """Synthesise `text` of any length, keeping one consistent voice throughout.

    `control` is a VoxCPM2 instruction in parentheses, e.g.
    ``"(energetic upbeat advertising voice)"``. It is prepended to every chunk
    so the performance holds for the whole script, and it is added *after*
    splitting so it never eats into `max_chars` or gets cut in half.

    `prompt_text` must be the real transcript of `reference_wav`. Given one,
    the model clones by continuation ("ultimate cloning"), which holds the
    voice markedly steadier across chunks — measured on an eight-sentence
    script, the pitch spread fell from 113 Hz to 79 Hz. A wrong transcript
    makes it worse, so pass it only when it is certain.

    **`control` and `prompt_text` cannot be combined.** In continuation mode the
    model treats the text as following on from the prompt transcript, and the
    parenthetical instruction stops being an instruction: it gets read out loud,
    once per chunk. The same eight-sentence script came back as 90 seconds of
    audio instead of 19. So when `control` is set the prompt is dropped and the
    voice is held by the reference plus the re-rolls below, which is also why
    those matter most on a directed read — directing it measurably *widens* the
    spread (113 Hz undirected, 138 Hz directed).
    """
    sample_rate = model.tts_model.sample_rate
    marked = split_marked(text, max_chars)
    if not marked:
        return np.zeros(0, dtype="float32"), sample_rate
    chunks = [chunk for chunk, _ in marked]
    ends_sentence = [ends for _, ends in marked]

    gap = np.zeros(max(0, int(sample_rate * gap_seconds)), dtype="float32")
    # A break inside a sentence is a breath, not a full stop.
    short_gap = np.zeros(max(0, int(sample_rate * MID_SENTENCE_GAP)), dtype="float32")
    temp_dir = Path(tempfile.mkdtemp(prefix="voxcpm_ref_"))
    # Mutable so `render` below picks up the seed adopted after the first chunk.
    voice = {"ref": reference_wav, "prompt": prompt_text}

    def render(chunk: str) -> np.ndarray:
        kwargs = dict(
            text=f"{control}{chunk}" if control else chunk,
            cfg_value=cfg_value,
            inference_timesteps=inference_timesteps,
        )
        if voice["ref"]:
            kwargs["reference_wav_path"] = voice["ref"]
            # Only a transcript we can vouch for is usable as a prompt: a wrong
            # one makes the continuation worse, not better. And never alongside
            # a control instruction — see the note on `control` below.
            if voice["prompt"] and not control:
                kwargs["prompt_wav_path"] = voice["ref"]
                kwargs["prompt_text"] = voice["prompt"]
        return np.asarray(model.generate(**kwargs), dtype="float32")

    pieces: list[np.ndarray] = []
    for index, chunk in enumerate(chunks):
        if progress:
            progress(index + 1, len(chunks), chunk)
        audio = render(chunk)
        pieces.append(audio)

        # No reference given: adopt the first chunk's voice for the remainder.
        if not voice["ref"]:
            seed = temp_dir / "voice_seed.wav"
            sf.write(seed, audio, sample_rate)
            voice["ref"] = str(seed)
            voice["prompt"] = None     # we don't have a verified transcript

    if retries > 0 and len(pieces) > 2:
        pieces = even_out_voice(render, chunks, pieces, sample_rate, retries)

    if level_match and len(pieces) > 1:
        pieces = match_levels(pieces, sample_rate)

    out: list[np.ndarray] = []
    for i, piece in enumerate(pieces):
        if i:
            # The pause belongs to the join, so it is chosen by whether the
            # *previous* chunk finished its sentence.
            join = gap if ends_sentence[i - 1] else short_gap
            if join.size:
                out.append(join)
        out.append(piece)
    return np.concatenate(out), sample_rate


if __name__ == "__main__":
    demo = (
        "លោក ប៉េង ពោធិ៍នា រដ្ឋមន្រ្តីក្រសួងសាធារណការ និងដឹកជញ្ជូន ព្រឹកថ្ងៃទីដប់ពីរ ខែឧសភា "
        "ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ បានអញ្ជើញជាអធិបតីក្នុងមហាសន្និបាតភាគហ៊ុនិកលើកទីដប់មួយ "
        "របស់កំពង់ផែស្វយ័តភ្នំពេញ។"
    )
    for i, c in enumerate(split_text(demo), 1):
        print(f"{i}. ({len(c):3d} chars) {c}")
