# Voice Studio

A desktop app that speaks typed text in a chosen or cloned voice — **entirely on
your own machine**. Nothing is uploaded. Khmer is fully supported. Built for
product promos: the **commercial voice tuner** directs the read like an ad and
masters it for delivery.

- **UI:** React + TypeScript (Vite)
- **Shell:** Tauri (Rust) — starts/stops the engine, bundles the app
- **Engine:** Python (FastAPI) running **VoxCPM2**

```
React UI  ──HTTP──▶  Python engine (127.0.0.1:8008)  ──▶  VoxCPM2
   ▲                         ▲
   └── Tauri (Rust) starts & stops the engine ──┘
```

## What it does

- **30 languages including Khmer** — the language is detected from the text, so
  there's nothing to select.
- **Two premium lead voices** — "main character" rather than utility announcer:
  designed from a description, then cached so the same voice comes back every
  time.
- **Voice cloning** from a 20–30s clip.
- **Khmer number normalisation** — `ថ្ងៃទី12` → `ថ្ងៃទីដប់ពីរ`,
  `ឆ្នាំ2026` → `ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ`. Without this, digits come out garbled.
- **Long-form synthesis** — long text is split into sentence-sized chunks so the
  voice doesn't tear or drift, with the voice pinned across all chunks.
- **Commercial voice tuner** — see below.
- **48 kHz** output.
- **Apache-2.0 model** — commercial use allowed.

## Commercial voice tuner

Two things turn a correct-but-flat read into something you can put behind a
product video.

**Direction.** VoxCPM2 takes a control instruction in parentheses at the start
of the text and uses it to steer delivery while the reference clip still pins
the timbre — so the same voice, built-in or cloned, can read the same line as a
retail spot or as a premium brand tag. Five presets:

| Preset | For |
| --- | --- |
| **High-energy promo** | Launches, discounts, limited offers |
| **Premium brand** | Calm and deliberate; makes the product sound expensive |
| **Friendly explainer** | Demos, how-it-works, app walkthroughs |
| **Announcer** | Event spots, anything with a deadline |
| **Testimonial** | Sincere and unpolished, like a real customer |

**Energy** (1–5) and **pace** add their own phrases to the instruction and
nudge the guidance scale; each preset starts at the settings that suit it, so
picking one is enough. The panel shows the exact instruction being sent.

**Mastering.** The raw output has wide level swings, thin presence, no fixed
delivery level and peaks wherever the model put them. The chain is

```
trim + fade → high-pass → low-shelf cut → presence peak → air shelf
            → de-ess → expander → compress → loudness normalise → limit
```

The **expander** pushes down whatever sits below the speech, so the gaps go
quiet. It is an expander rather than a gate — below the threshold everything is
pushed further down instead of being cut off, so a trailing word fades out
instead of being chopped. Its threshold is relative to the clip's own speech
level, so a quiet read and a loud one are treated the same.

How much it does depends on the source. On a noisy input it is worth about
18 dB in the pauses; on the built-in voices, whose output already sits 70 dB
below the speech between words, it is worth 6 dB on one take and under 1 dB on
another. It earns its place on **cloned** voices, where room tone or hiss from
the uploaded sample carries through into every take — not on the built-ins,
where the audible gains come from the levelling, the presence and air lifts and
the loudness normalisation instead.

Loudness is measured per **ITU-R BS.1770-4** (K-weighted, gated) — the same
metric streaming platforms normalise to — so the targets mean what they do
everywhere else:

| Voicing | Target | Use |
| --- | --- | --- |
| **Clear & clean** | -16 LUFS | Cleans and opens out without sounding produced |
| **Light polish** | -18 LUFS | Gentler still; keeps the character |
| **Broadcast** | -16 LUFS | Even and present; the tuner's default |
| **Punchy ad** | -14 LUFS | Dense and forward, for short spots |
| **Off** | — | No processing at all, for comparison |

Mastering is **independent of the direction**: switching off the performance
leaves the read undirected but still cleaned, because shipping a raw read is
never the goal. Pick **Off** explicitly to bypass it.

The ceiling is a **true-peak** figure, so the limiter detects on the 4×
oversampled signal: a waveform held at -1 dBFS sample-peak still reconstructs
to about -0.4 dBTP between samples.

### Keeping one voice across a long script

Each sentence is a separate generation, so nothing inherently forces sentence
five to sound like the same person as sentence one. Three things hold it
together.

**A reference the voice can actually hold on to.** See the next section — it is
the largest factor by some way, so it is worth reading first.

**Continuation cloning, when it can be used.** Given a reference clip *and its
exact transcript*, VoxCPM2 clones by continuation and holds the voice markedly
steadier. The built-in voices qualify for free: the transcript is whatever they
were designed from. Pitch spread over the same eight-sentence script, with a
badly- and a well-rolled reference:

| mode | poor reference | good reference |
| --- | --- | --- |
| reference only, undirected | 113 Hz | — |
| **reference + transcript, undirected** | 79 Hz | **40 Hz** |
| reference only, directed | 138 Hz | 63 Hz |

Both axes matter, and they are independent: the reference roughly halves it, the
transcript takes off another third.

**It cannot be combined with a style instruction.** In continuation mode the
text is treated as following on from the prompt transcript, so the parenthetical
stops being an instruction and gets read out loud, once per chunk — the same
script came back as 90 seconds of audio instead of 19. So a directed read drops
the prompt and relies on the reference alone, which is also the mode that drifts
most, which is why the next part matters.

Directing only the first sentence and then anchoring the rest to *that* audio
was tried, to get the performance from the prompt instead of restating it. It
works — nothing is read aloud and the pace does carry — but consistency came out
*worse* than simply directing every sentence (74 Hz spread against 63 Hz), so it
isn't used.

**Re-rolling the sentences that don't match.** Every chunk is fingerprinted —
median f0 in semitones, plus mean-MFCC distance — and compared against *the
median of the other chunks*, not against the reference clip. That distinction is
the whole trick: every chunk sits some way off the reference, fairly uniformly,
so measuring against it would re-roll nearly everything. What a listener
notices is one sentence not matching its neighbours. Outliers are generated
again and the closest take kept; a consistent read costs nothing extra. See
[consistency.py](python/consistency.py).

**Matching their levels.** Chunk loudnesses also drift, so they are measured
and pulled together (by up to 6 dB) before being joined.

### The built-in voices

Both are designed from a description rather than shipped as audio, since
VoxCPM2 can invent a voice from text alone:

| | Description |
| --- | --- |
| **Lead female** | young adult, warm and resonant, composed and confident, cinematic narrator, smooth and unhurried |
| **Lead male** | adult, deep and resonant with a rich chest tone, calm and commanding, cinematic narrator, smooth and unhurried |

A designed voice is re-rolled on every call, which would mean a different
person reading each sentence — so the description is rendered once and that
clip becomes the timbre reference for everything afterwards. The cache name
carries a fingerprint of the description and the design settings, so editing
[voices.py](python/voices.py) regenerates it instead of silently serving the
old voice forever.

This is the single biggest factor in whether a long read holds together.
Measured over an eight-sentence script, a poorly-rolled reference gave a 79 Hz
pitch spread undirected and 138 Hz directed; a well-chosen one gave 40 Hz and
63 Hz. Which is why the clip is not left to a single roll. Voice design varies a lot run to run — the same female description
measured 195 Hz once and 351 Hz another time, and the same male wording gave
74 Hz and then 87 Hz. So three takes are designed and the best-measuring one is
kept, scored on whether the fundamental landed in the range the voice is meant
to occupy and on how much of the clip is steadily pitched (a creaky reference
passes its wobble to everything cloned from it). That makes first launch about
three times longer for the two built-ins, once ever.

Wording matters more than it looks. "Deep and resonant with a rich chest tone"
dragged the male voice down to a 74–87 Hz boom with the sub-100 Hz band louder
than its own formants; naming an age instead put it at a normal 103 Hz with the
steadiest periodicity of any take measured.

The cached clip is conditioned before being stored — **level and rumble only**.
Nothing tonal: a reference is cloned *from*, so presence or air added there
would be baked into every take made with that voice.

## Responsible use

Only clone voices you have permission to use — your own, or someone who has
agreed. Don't impersonate real people without consent.

## Prerequisites

- **Rust** (stable) and **Node 18+**
- **Python 3.11** (`brew install python@3.11`) — the system 3.9 is too old
- Apple Silicon uses the GPU through PyTorch's MPS backend automatically

## One-time setup

```bash
cd python
python3.11 -m venv .venv-voxcpm
.venv-voxcpm/bin/pip install --upgrade pip
.venv-voxcpm/bin/pip install -r requirements.txt

cd ..
npm install
```

The first run downloads the VoxCPM2 weights (~5 GB) into
`~/.cache/huggingface`. That happens once.

## Run

```bash
npm run tauri dev
```

The badge top-right shows **Starting engine…** → **Engine ready**. Then pick a
voice, pick a tuner preset, type your copy (Khmer or otherwise), and click
**Generate speech**. The clip plays in the Result card, which reports the
delivered loudness and true peak; **Save WAV…** opens a native save dialog.

## Notes

- **Speed:** roughly 1.8× realtime on Apple Silicon — a 10s clip takes ~18s.
- **Force CPU** if MPS misbehaves: `VOICE_DEVICE=cpu npm run tauri dev`.
- **Run the engine alone** (useful for reading errors):
  `cd python && .venv-voxcpm/bin/python server.py`, then `curl localhost:8008/health`.
  Use `VOICE_PORT=8009` to run it beside the app.
- **Generated clips live in `python/data/out/`** (the 20 most recent) and the UI
  plays them from `http://127.0.0.1:8008/audio/<id>.wav`. They are *not* passed
  to the webview as `blob:` URLs: WKWebView needs a URL it can make byte-range
  requests against, and it ignores `<a download>` entirely — so saving goes
  through a native dialog in Rust (`save_audio`) instead of an anchor.
- **Whisper is deliberately not used.** It was tried for auto-transcribing voice
  samples, but it fails badly on Khmer (it returns repeated garbage), so the
  transcript field is optional and typed by hand instead.

## Project layout

```
src/
  App.tsx             the interface
  engine.ts           client for the Python engine
src-tauri/src/lib.rs  starts/stops the engine, saves clips via a native dialog
python/
  server.py           FastAPI engine: /health, /voices, /tts, /audio, /tuner
  khmer_normalize.py  Khmer numbers/dates → spoken words
  longform.py         sentence chunking, voice pinning, re-rolls, level matching
  consistency.py      is this sentence the same voice as the others?
  voices.py           the built-in lead voices + their design cache
  styles.py           commercial tuner presets → VoxCPM2 control instruction
  mastering.py        BS.1770 loudness + the mastering chain
  requirements.txt
```

## Building a distributable app

`npm run tauri build` compiles the Rust/JS. Shipping the Python engine inside the
bundle needs it packaged (e.g. PyInstaller) and added to Tauri's
`bundle.resources`; that step isn't wired up yet, so use `npm run tauri dev`.
