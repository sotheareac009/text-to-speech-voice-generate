# Voice Studio

A desktop app that speaks typed text in a chosen or cloned voice — **entirely on
your own machine**. Nothing is uploaded. Khmer is fully supported. Built for
product promos: the **commercial voice tuner** directs the read like an ad and
masters it for delivery.
```ssh
./scripts/build-dmg.sh           # build at the current version

./scripts/build-dmg.sh 0.3.0     # set the version first, then build
```

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
- **Three premium lead voices** — "main character" rather than utility
  announcer: designed from a description, then cached so the same voice comes
  back every time.
- **Voice cloning** from a 20–30s clip.
- **Khmer number normalisation** — `ថ្ងៃទី12` → `ថ្ងៃទីដប់ពីរ`,
  `ឆ្នាំ2026` → `ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ`. Without this, digits come out garbled.
- **Mixed Khmer/English** — each script run is normalised in its own language,
  and the languages are given separate generations where they're long enough to
  stand alone. See [Mixed Khmer and English](#mixed-khmer-and-english).
- **Long-form synthesis** — long text is split into sentence-sized chunks so the
  voice doesn't tear or drift, with the voice pinned across all chunks.
- **Commercial voice tuner** — see below.
- **Share to Telegram and Messenger** — see
  [Sharing to a chat app](#sharing-to-a-chat-app).
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

The limiter runs *after* the loudness normalisation, so whatever it takes off
the peaks comes off the loudness too and the delivered level can sit up to
about 1 LU under the target — measured at -17.1 LUFS against a -16 target on a
dense take. The target is what the chain aims for; the Result card reports what
it actually achieved, which is the number to trust.

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

### Cleaning an imported sample

VoxCPM2 clones the *sound* of the reference, not only the speaker. Whatever is
behind the voice — traffic, a fan, music from the next room — is part of that
sound, so it is learned along with the person and reappears underneath every
sentence the model later speaks. A sample recorded on a phone in a shop gives
a clone that is permanently in that shop.

So imported samples are cleaned on the way in, automatically
(`python/denoise.py`). Measured on a real 26-second phone recording with music
behind it:

| | reference | speech generated from it |
| --- | --- | --- |
| before | 10.7 dB SNR, floor -24.1 dBFS | 21.0 dB SNR, floor -17.1 dBFS |
| after | **34.0 dB SNR**, floor -48.2 dBFS | **47.3 dB SNR**, floor -43.5 dBFS |

47 dB puts a cloned voice level with the built-in ones, which measure 47-50 dB.

The chain is separation (Demucs) → high-pass at 65 Hz → residual spectral gate
→ trim the ends → normalise. Separation is the part that matters and the only
slow step, about 10 s for a 26 s clip on the CPU; it runs on the CPU on purpose,
since the GPU may be holding the 9 GB voice model.

Three things worth knowing:

- **It is skipped on samples that are already clean.** The threshold is 25 dB
  SNR, which sits in the empty middle of the gap between the noisy samples
  measured here (10.7 and 16.2 dB) and the clean ones (31.3 and 43.0 dB).
  Separating a clean sample risks taking more away than it gives.
- **The high-pass is at 65 Hz, not 100 Hz.** 100 Hz would be far better against
  rumble, and would thin out exactly the low male voices it is meant to help —
  a low male fundamental reaches down to about 80 Hz.
- **The original upload is kept** beside the cleaned `.clean.wav`. Cleaning is
  a lossy judgement call, and `POST /voices` takes `clean=false` to skip it.

This reduces, but does not replace, the mastering noise gate described above:
the gate still catches what the model itself generates between words.

### The built-in voices

Both are designed from a description rather than shipped as audio, since
VoxCPM2 can invent a voice from text alone:

| | Description | f0 target |
| --- | --- | --- |
| **Lead female** | young adult, warm and resonant, composed and confident, cinematic narrator | 165–265 Hz |
| **Lead male** | a man in his thirties, warm and resonant, clear and confident, cinematic narrator | 90–150 Hz |
| **Young male** | a young man of about twenty-three, bright and warm, clear and confident, cinematic narrator | 115–175 Hz |

The picker shows one button per `group` and a dropdown for that group's
variants, so **Male** carries both male voices rather than each voice taking its
own button. The variant chosen in a group is remembered when switching away and
back.

Adding a voice is a dict entry in [voices.py](python/voices.py) — the engine
serves the table to the interface, so nothing in the frontend changes. Give it
an `f0_range` that doesn't sit on top of an existing voice's, or the two
converge on the same register and there's no point having both. `group` and
`variant` are presentation only and deliberately excluded from the cache
fingerprint, so renaming them doesn't trigger a redesign.

**The engine reads this table once, at startup.** After editing it, restart the
app — the frontend hot-reloads but the Python process does not.

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

### Mixed Khmer and English

Khmer product copy is full of English words — `ជ្រើសរើសយក Food & Drink រួចចុច
Button Create my store`. Two things were wrong with how that was handled.

**English numbers were spoken in Khmer.** The old code asked "does this text
contain any Khmer?" and, if so, ran Khmer number normalisation over the whole
string, English included:

| input | was | now |
| --- | --- | --- |
| `Save 50% today ជា` | `Save ហាសិបភាគរយ today ជា` | `Save 50 percent today ជា` |
| `Costs $20 ជា` | `Costs ដុល្លារម្ភៃ ជា` | `Costs 20 dollars ជា` |

Text is now normalised run by run, each in its own language. Digits and symbols
join the run they sit in, so `50%` stays Khmer in `តម្លៃ 50%` and English in
`Save 50% today`. English shorthand is spelled out too (`&` → `and`, `u` →
`you`), since the model mumbles bare symbols and single letters.

**One generation had to code-switch repeatedly.** A chunk like the example above
switches language three times inside a single utterance, and the losing language
comes out in the other one's phonetics — a Khmer recogniser transcribed "Food
and Drink" as `ហ្វួត អ៊នរីង` and "Create my store" as `គ្រី អេទ ម៉ៃស្ទោ`. That is
what makes embedded English hard to follow: a speech recogniser still recovers
the words, because it tolerates accent, but a listener expecting English does
not.

Each language now gets its own generation where the runs are long enough to
stand alone, with the reference clip keeping it the same voice throughout. Runs
shorter than 20 characters are merged back into a neighbour, because on their
own they render as padding or a repeat — "Food and Drink" alone came back as
near-silence. So densely interleaved copy, a couple of English words per Khmer
phrase, stays mixed by design: splitting it trades an accent problem for a worse
one. Copy with substantial runs separates cleanly.

**What is still imperfect.** Short English fragments embedded in Khmer are read
with Khmer phonetics, and no text-level change fixes that — the model infers
pronunciation from the surrounding language. Synthesised on their own the same
fragments are word-perfect. If embedded English matters more than compactness,
give it room: a full English sentence between Khmer sentences is rendered as
English, a two-word label inside a Khmer phrase is not.

## Sharing to a chat app

The **Telegram voice** and **Messenger** buttons under a finished clip encode it
into the format that app expects, copy it to the clipboard as a file, and bring
that app to the front. Pick a chat and press ⌘V.

The paste is not laziness — neither service will take a file from a desktop app:

- **Telegram** has exactly one programmatic route, the Bot API's `sendVoice`,
  which needs a bot registered with `@BotFather` and its token and a chat id
  stored in the app. That route is the only way to produce a true voice-message
  bubble; a dragged file arrives as an audio message instead, whatever its
  format.
- **Messenger** has no route at all. Its Send API is for *Pages* replying to
  someone who messaged them first, inside a 24-hour window — it cannot send as
  you, to a friend. The Send Dialog shares a public link, not a file, and a
  `127.0.0.1` URL is not reachable from Facebook's servers.

So the buttons automate everything except the paste. What each one writes:

| Button | Format | Why |
| --- | --- | --- |
| Telegram voice | OGG/Opus, mono, 32 kbit/s, VoIP-tuned | What Telegram's own recorder sends, and the only format it treats as voice |
| Messenger | AAC in an `.m4a`, 128 kbit/s | What Messenger's own recorder produces |

`ffmpeg` does the encoding when it's on `PATH`. Without it, libsndfile stands
in — it writes Opus too, so Telegram is unaffected, and MP3 replaces AAC for
Messenger, which accepts it. The button tells you which format it wrote.

Exports are cached next to the clip and pruned along with it, so re-sharing the
same take is instant.

### Why raising the app is not a URL

A desktop app's URL scheme only activates it when it is **not** already
running. `tg://` carries no action, so macOS delivers it to the running
Telegram, which has nothing to do and stays where it is — the button appears to
do nothing while Telegram sits open behind the window. So `share_to_chat_app`
in `lib.rs` uses `open -b <bundle id>`, which activates the app either way, and
falls back to the web client only when no bundle id resolves. Telegram Desktop
also ships no share extension, so the macOS share sheet is not an option.

The clipboard copy is `NSPasteboard` holding a file *reference*, exactly what
Finder's ⌘C puts there — which is why the chat app attaches the file rather
than pasting a wall of bytes. If the clipboard ever refuses it, the button
falls back to revealing the file in Finder to drag.

Both of these send audio off your machine, which is the one thing the engine
otherwise never does.

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
- **Memory, and the CPU fallback.** VoxCPM2 is a 2B-parameter model that loads
  in float32 — around 9 GB. The MPS allocator's ceiling is a fraction of the
  machine's memory, and on a 16 GB Mac that works out at roughly 9 GB, so the
  load dies partway through:

  ```
  RuntimeError: MPS backend out of memory (MPS allocated: 9.05 GiB, max allowed: 9.07 GiB)
  ```

  The engine now treats that as a fallback rather than a failure: it catches the
  out-of-memory error, releases what it allocated, and reloads on the CPU, which
  has no such ceiling. `/health` then reports `"device": "cpu"` and says why, so
  the app shows it instead of leaving someone wondering. A 24 GB machine never
  reaches the fallback.

  That choice is the user's, not just a fallback. **How it runs**, on the engine
  screen, offers three modes, saved in `data/settings.json` and applied when the
  engine starts — changing it restarts the engine:

  | mode | what it does |
  |---|---|
  | `auto` | GPU when the model fits, CPU when it does not. The default. |
  | `cpu` | Never use the GPU. Slower, but always fits. |
  | `gpu-unlimited` | GPU past its ceiling, swapping to disk. Faster on 16 GB, but PyTorch warns it may make the machine unresponsive. |

  The screen also states how much memory the machine has and what that means
  for the choice, so nobody has to guess. `gpu-unlimited` sets **both** MPS
  watermark ratios to `0.0`: leaving the low one at its 1.4 default while the
  high one is 0.0 is rejected as an invalid pair, which looks exactly like a
  crash on startup.

  `VOICE_DEVICE=mps` or `VOICE_DEVICE=cpu` forces the device for an engine run
  from a terminal, bypassing the saved mode and the fallback.
- **Speed:** measured 3.92 s of audio generated in 8 s on MPS — 2.0× realtime.
  Run two engines at once and both slow down by around 6×, because two 9 GB
  models do not fit in 24 GB; that is memory pressure, not the device.
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
  App.tsx             the interface, including first-run engine setup
  engine.ts           client for the Python engine (HTTP)
  install.ts          client for the Rust side: install / start the engine
src-tauri/src/lib.rs  finds, installs, starts and stops the engine; saves clips
python/
  server.py           FastAPI engine: /health, /voices, /tts, /audio, /tuner, /export
  share.py            re-encodes a clip for Telegram (Opus) or Messenger (AAC)
  khmer_normalize.py  Khmer numbers/dates → spoken words
  longform.py         sentence chunking, voice pinning, re-rolls, level matching
  consistency.py      is this sentence the same voice as the others?
  voices.py           the built-in lead voices + their design cache
  styles.py           commercial tuner presets → VoxCPM2 control instruction
  mastering.py        BS.1770 loudness + the mastering chain
  denoise.py          strips background from an imported cloning sample
  requirements.txt
```

## Building a distributable app

```bash
npm run tauri build
```

Artifacts land under `src-tauri/target/release/bundle/`:

```
macos/Voice Studio.app                 the app
dmg/Voice Studio_0.1.0_aarch64.dmg     what you hand to someone else
```

`aarch64` is Apple Silicon, and a build only runs on the architecture it was
built for. For an Intel Mac: `npm run tauri build --target x86_64-apple-darwin`.

### What is in the bundle, and what isn't

The `.app` carries the interface plus the engine's **Python sources** — about
80 KB of `.py` files, listed under `bundle.resources` in
`src-tauri/tauri.conf.json`. It does not carry the engine itself.

That is deliberate. VoxCPM2 on PyTorch is about 420 MB of wheels that unpack to
roughly 2 GB — `libtorch_cpu.dylib` alone is 402 MB of that — and the voice
model it loads is another 5 GB. Sending someone a 7 GB payload to install a
4 MB app makes no sense when none of those 7 GB are specific to your machine — and GitHub won't take the
wheels either, which is what the `.gitignore` rule about `python/.venv-*/` is
there to prevent.

So the engine installs itself on first launch. The app opens on a checklist of
the libraries it needs, each with its own **Install** button, plus **Install
all** for one click. It looks for a Python 3.10–3.13 already on the machine,
builds a virtualenv, and streams pip's own output into the window while it
works — several silent minutes behind a spinner is indistinguishable from a
hang, which is when people force-quit. When every row is ticked it says the
engine is ready and offers to start it.

The list, and the description under each library, are read from
`python/requirements.txt` — the comment block above each entry is what the UI
shows. Add a requirement there and it appears in the checklist with its
explanation, with nothing to change in the interface.

Installing one at a time is slower than `pip install -r` in one go, because
`voxcpm` pulls in most of the others as dependencies and the remaining rows
then finish instantly. It is worth it for being able to see what is going onto
the machine, and for a failure leaving only one row to retry.

Once everything is installed the checklist is still reachable, from **Engine
libraries…** under the status badge.

| | lives in |
|---|---|
| The app | `/Applications/Voice Studio.app` |
| Engine virtualenv (~2.1 GB) | `~/Library/Application Support/com.sotheareach.voice-clone-tts/engine/` |
| Clips, designed voices, uploads | `~/Library/Application Support/com.sotheareach.voice-clone-tts/data/` |
| Voice model (~5 GB) | `~/.cache/huggingface/` |

Deleting those three removes everything the app ever wrote. Nothing is
installed outside the user's home directory, and nothing needs admin rights.

Ship a new version with changed `requirements.txt` and the app notices: it
compares the file against `engine/installed.json` and offers to update the
virtualenv, with **Use it as it is** to carry on regardless.

If an engine is already answering on port 8008 — one started by hand, or a
leftover from `npm run tauri dev` — the app uses it and never asks to install
anything. That is worth knowing when testing the DMG on your own machine: quit
the dev engine first, or you will not see the setup card at all.

```bash
pkill -f 'python/server.py'       # frees the port so first-run setup appears
```

In development none of this applies — `npm run tauri dev` uses
`python/.venv-voxcpm` directly and writes to `python/data`, so your working
engine is never touched by the installer.

### When the engine misbehaves

The app installs in the GUI, but the same install runs from a terminal:

```bash
cd "/Applications/Voice Studio.app/Contents/MacOS"
./voice-clone-tts --list-libraries                        # the checklist, as JSON
./voice-clone-tts --install-engine                        # every library
./voice-clone-tts --install-library 'scipy>=1.11'         # one row of the list
./voice-clone-tts --engine-mode                           # the saved mode, and the RAM
./voice-clone-tts --engine-mode cpu                       # save a mode
```

Each runs exactly the code the matching button runs, prints every step, and
exits non-zero on failure — the quickest way to see *why* an install failed on
someone else's machine. The in-app log shows the same lines, but a terminal
keeps them after the app closes. `--install-library` only accepts a line that
is actually in the engine's requirements.

The engine's own output goes to `engine.log` beside the clips, in
`~/Library/Application Support/com.sotheareach.voice-clone-tts/data/`. It is
rewritten on each launch, so it always describes the current run.

It is written to a *file* deliberately. Inheriting the app's stdio would mean
writing into a pipe, and a pipe outlives its reader: once whatever started the
engine exits, the engine's next log line raises `BrokenPipeError`. That turned
every synthesis into `Synthesis failed: [Errno 32] Broken pipe`, because
VoxCPM2 draws a progress bar on stderr while it generates — a log line failing
the work it was describing. The engine now also wraps its own streams so a
write can never raise, which covers an engine someone started by hand from a
terminal that has since closed.

If the engine is installed but nothing answers within twenty seconds, the app
stops waiting and offers **Start it again** and **Reinstall the engine**. The
usual cause is a Python upgrade: a virtualenv links to the exact interpreter it
was built from, so `brew upgrade python@3.11` can leave the venv pointing at a
framework that has moved. Reinstalling rebuilds it against the current Python.

### Signing: ad-hoc, not notarised

`bundle.macOS.signingIdentity` is `"-"`, which ad-hoc signs the bundle: no Apple
account, no certificate, but a real `_CodeSignature/CodeResources` sealing the
app. **This is not optional cosmetics.** Without it, Tauri leaves the main
binary linker-signed, and a linker signature *declares* a sealed resource list
that does not exist:

```
$ codesign --verify --deep --strict "Voice Studio.app"
Voice Studio.app: code has no resources but signature indicates they must be present
```

That is an *invalid* signature, not a missing one — and macOS reports an invalid
signature on a quarantined app as:

> "Voice Studio" is damaged and can't be opened. You should move it to the Trash.

with **no "Open Anyway" offered in Privacy & Security**, because that override
exists only for apps whose signature is valid but untrusted. It is a dead end,
and the app is not damaged at all. Ad-hoc signing turns it into the ordinary,
recoverable case.

Because the app is sealed, nothing may write inside the bundle at runtime or the
seal breaks — which is why the engine's bytecode goes to `PYTHONPYCACHEPREFIX`
and its log to the data directory rather than next to the sources.

The recipient still sees a warning, because ad-hoc signing carries no Team ID
and the app is not notarised. Either route works:

```bash
xattr -dr com.apple.quarantine "/Applications/Voice Studio.app"   # then it just opens
```

or open it, let macOS refuse, then **System Settings → Privacy & Security →
Open Anyway** — which now appears. On macOS 13 and 14, right-click → **Open**
also works; macOS 15 removed that shortcut, leaving the two routes above.

Removing the warning entirely needs a real Developer ID certificate plus
notarisation (`codesign` with the certificate, then `notarytool`), which means
the Apple Developer Program at $99/year.

### What to tell whoever you send it to

> **You need:** macOS 12 or later; Apple Silicon strongly preferred (Intel
> works but is several times slower); about **10 GB** of free disk space; an
> internet connection for the first run; and **Python 3.11**, from
> `brew install python@3.11` or the installer at python.org/downloads.
>
> **Installing:** open the DMG, drag Voice Studio to Applications, then run
> `xattr -dr com.apple.quarantine "/Applications/Voice Studio.app"` in Terminal
> once. Open the app.
>
> **First launch** shows a setup card. Press **Install engine** and leave the
> window open — it downloads about 420 MB, unpacks to roughly 2 GB, and takes
> a few minutes, with a running log so you can see it working. When it finishes the app switches to the normal
> interface by itself.
>
> **The first time you clone a voice** it downloads the separation model used to
> strip background from your sample, about 80 MB, once.
> **The first time you press Generate speech** it downloads the voice model,
> another ~5 GB, once. The badge top-right says what it is doing. Every launch
> after that is quick.
>
> Everything runs on your own machine. No text or audio is sent anywhere.

If the setup card reports **no usable Python found**, the machine either has no
Python or only the macOS system 3.9, which is too old for current torch wheels.
Installing Python 3.11 and reopening the app fixes it; the app looks in
`/opt/homebrew/bin`, `/usr/local/bin` and
`/Library/Frameworks/Python.framework` by absolute path, because an app
launched from Finder gets a bare `PATH` and cannot see a shell's Python.
