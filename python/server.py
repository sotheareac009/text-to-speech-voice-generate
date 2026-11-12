"""
Local text-to-speech + voice cloning engine for the Tauri app.

Powered by VoxCPM2 (Apache-2.0), which covers 30 languages including Khmer,
clones a voice from a short clip, and can invent a voice from a description.

Pipeline for every request:
    text → normalisation per script run (Khmer numbers/dates → spoken
           words; English symbols and shorthand → words)
         → long-form chunking (keeps long text from tearing)
         → VoxCPM2, with the voice pinned across chunks and, when the
           commercial tuner is on, a style instruction steering the delivery
         → mastering (levelled, brightened, brought to a delivery loudness)
         → 48 kHz WAV on disk, served from /audio/<id>.wav

Listens on 127.0.0.1 only; no audio leaves the machine. Tauri starts/stops it.

Run standalone:
    python server.py
"""

from __future__ import annotations

import math
import os
import re
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

from starlette.concurrency import run_in_threadpool

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


class _UnbreakableStream:
    """A stream whose writes can never raise.

    The engine runs as a child process. If whatever started it exits first,
    the pipe it was writing to loses its reader, and the very next write raises
    BrokenPipeError. Raised from a log line in the middle of a request, that
    aborted the whole job with "Synthesis failed: [Errno 32] Broken pipe" —
    VoxCPM2 draws a progress bar on stderr while it generates, so every
    synthesis hit it. Logging must never be able to fail the work it describes.
    """

    def __init__(self, stream):
        self._stream = stream

    def write(self, data):
        try:
            return self._stream.write(data)
        except (OSError, ValueError):
            return len(data) if data else 0

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        try:
            self._stream.flush()
        except (OSError, ValueError):
            pass

    def __getattr__(self, name):          # isatty, fileno, encoding, …
        return getattr(self._stream, name)


# Before the third-party imports, so uvicorn and transformers capture these.
sys.stdout = _UnbreakableStream(sys.stdout)
sys.stderr = _UnbreakableStream(sys.stderr)

import soundfile as sf  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

import saved_voices  # noqa: E402
from denoise import clean_sample  # noqa: E402
from khmer_normalize import normalize_for_speech  # noqa: E402
from longform import generate_long  # noqa: E402
from mastering import CLEANUP_DEFAULT, master  # noqa: E402
from share import EXPORT_SUFFIXES, TARGETS, export  # noqa: E402
from styles import build_direction, plain_direction, tuner_catalog  # noqa: E402
from voices import BUILTIN_VOICES, SEED_TEXT, designed_voice, voice_catalog  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("VOICE_PORT", "8008"))
MODEL_ID = os.environ.get("VOICE_MODEL", "openbmb/VoxCPM2")
#: "mps", "cpu", or empty to choose automatically.
DEVICE = os.environ.get("VOICE_DEVICE", "").strip().lower()

DATA_DIR = Path(os.environ.get("VOICE_DATA_DIR", Path(__file__).parent / "data"))
VOICES_DIR = DATA_DIR / "voices"
VOICES_DIR.mkdir(parents=True, exist_ok=True)

# Generated clips are written here and served from /audio/<id>.wav rather than
# handed back as bytes: the webview's media player needs a real URL it can make
# byte-range requests against, and the app saves a copy straight from the file.
OUT_DIR = DATA_DIR / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
KEEP_RESULTS = 20               # older clips are pruned after each generation
_ID_RE = re.compile(r"[0-9a-f]{32}")

_model = None
_status = "loading"      # loading | ready | error
_error_detail = ""
#: Which device the model actually ended up on, once it has loaded.
_device = ""
#: Why loading is taking so long, in words the UI can show. On a machine that
#: has never run this model, startup is a ~5 GB download, and a progress-free
#: "Starting engine…" for ten minutes looks indistinguishable from a hang.
_notice = ""
_voice_paths: dict[str, Path] = {}      # voice_id -> uploaded sample
_voice_prompts: dict[str, str] = {}     # voice_id -> transcript of that sample
_design_lock = threading.Lock()


def _restore_saved_voices() -> None:
    """Put previously saved clones back into the lookup tables.

    Without this the index would list a voice the picker could show but /tts
    could not find, which is a worse failure than not listing it: the person
    clicks their own voice and is told it does not exist.
    """
    for voice in saved_voices.load(DATA_DIR):
        _voice_paths[voice.id] = Path(voice.file)
        if voice.transcript:
            _voice_prompts[voice.id] = voice.transcript


_restore_saved_voices()


def _model_is_cached() -> bool:
    """Has huggingface_hub already downloaded this model?

    Only used to word the loading message. Reading the cache layout rather than
    asking the hub keeps startup offline-safe.
    """
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    hub = Path(os.environ.get("HUGGINGFACE_HUB_CACHE", home / "hub"))
    return (hub / ("models--" + MODEL_ID.replace("/", "--"))).exists()


def _devices_to_try() -> list[str]:
    """Devices to attempt, best first.

    The GPU is far faster, but VoxCPM2 is a 2B-parameter model that loads in
    float32 — around 9 GB. The MPS allocator's ceiling is a fraction of the
    machine's memory, and on a 16 GB Mac that works out at about 9 GB, so the
    load dies partway through with "MPS backend out of memory". The CPU has no
    such ceiling, so it is a fallback rather than a failure: slower, but it
    runs. A machine with more memory never reaches the fallback.
    """
    if DEVICE in {"cpu", "mps"}:
        return [DEVICE]
    try:
        import torch
        if torch.backends.mps.is_available():
            return ["mps", "cpu"]
    except Exception:  # noqa: BLE001
        pass
    return ["cpu"]


def _release_memory() -> None:
    """Hand back whatever a failed load managed to allocate."""
    try:
        import gc
        import torch
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _out_of_memory(exc: BaseException) -> bool:
    return "out of memory" in str(exc).lower()


def _load_model() -> None:
    global _model, _status, _error_detail, _notice, _device
    if _model_is_cached():
        _notice = "Loading the voice model…"
    else:
        _notice = (
            "First run: downloading the voice model (about 5 GB). "
            "This happens once — later launches take seconds."
        )

    try:
        from voxcpm import VoxCPM
    except Exception as exc:  # noqa: BLE001
        _status = "error"
        _error_detail = f"{type(exc).__name__}: {exc}"
        _notice = ""
        print("[engine] voxcpm failed to import:\n" + traceback.format_exc(), flush=True)
        return

    candidates = _devices_to_try()
    failure: BaseException | None = None
    for index, device in enumerate(candidates):
        last = index + 1 >= len(candidates)
        try:
            print(f"[engine] loading {MODEL_ID} on {device} — {_notice}", flush=True)
            _model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False, device=device)
            _device = device
            _status = "ready"
            # Say so permanently when the GPU could not be used: it is the
            # difference between roughly 2x realtime and something far slower,
            # and the user should not have to wonder why it feels sluggish.
            _notice = (
                ""
                if device != "cpu" or candidates == ["cpu"]
                else "Not enough GPU memory for the voice model, so it is running on the "
                "CPU. Everything works, but generating takes longer."
            )
            print(f"[engine] ready on {device}", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            failure = exc
            _model = None
            print(
                f"[engine] loading on {device} failed:\n" + traceback.format_exc(),
                flush=True,
            )
            _release_memory()
            if _out_of_memory(exc) and not last:
                print("[engine] out of GPU memory — retrying on the CPU", flush=True)
                continue
            break

    _status = "error"
    _error_detail = f"{type(failure).__name__}: {failure}"
    _notice = ""


app = FastAPI(title="Voice Engine")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.on_event("startup")
def _startup() -> None:
    threading.Thread(target=_load_model, daemon=True).start()


@app.get("/tuner")
def tuner() -> JSONResponse:
    """The built-in voices and the tuner's presets, so the UI doesn't hard-code
    them and can't drift from what the engine actually does."""
    # Built-ins first, then the person's own clones. Theirs come second
    # because the built-ins are what a new install can use immediately.
    voices = voice_catalog() + saved_voices.catalog(DATA_DIR)
    return JSONResponse({**tuner_catalog(), "voices": voices})


@app.get("/health")
def health() -> JSONResponse:
    # Once loaded, report where the model actually is rather than what the
    # machine is capable of — those differ whenever the fallback was taken.
    device = _device
    if not device:
        try:
            import torch
            device = "mps" if torch.backends.mps.is_available() else (
                "cuda" if torch.cuda.is_available() else "cpu")
        except Exception:  # noqa: BLE001
            pass
    return JSONResponse(
        {
            "status": _status,
            "device": device,
            # An error when there is one, otherwise what loading is busy with.
            "detail": _error_detail or _notice,
            "model": MODEL_ID,
        }
    )


@app.post("/voices")
async def register_voice(
    sample: UploadFile = File(...),
    transcript: str = Form(""),
    clean: bool = Form(True),
    name: str = Form(""),
) -> JSONResponse:
    """Save a voice sample to clone from, cleaned of background by default.

    `transcript` is optional but, when the text really matches the clip, it
    makes the clone noticeably closer.

    `clean` runs the sample through `denoise.clean_sample` first. It is on by
    default because the model clones the whole sound of the reference, not
    only the speaker: a sample recorded over traffic produces a voice with
    traffic under every sentence it later speaks. Measured on a real 26 s
    phone recording, cleaning the reference took the *generated* speech from a
    -17.1 dB noise floor to -43.5 dB.

    The original upload is always kept beside the cleaned version. Cleaning is
    a lossy judgement call, and someone who dislikes the result needs the file
    they actually sent to still be there.
    """
    raw = await sample.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")

    allowed = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm", ".aac"}
    ext = Path(sample.filename or "").suffix.lower()
    if ext not in allowed:
        ext = ".wav"

    voice_id = uuid.uuid4().hex
    path = VOICES_DIR / f"{voice_id}{ext}"
    path.write_bytes(raw)

    report: dict | None = None
    if clean:
        cleaned = VOICES_DIR / f"{voice_id}.clean.wav"
        try:
            # Off the event loop. Separation is tens of seconds of CPU work,
            # and this endpoint is `async`, so running it inline would stall
            # every other request for the duration — including the /health
            # poll the interface uses to draw the engine badge. `/tts` gets
            # this for free by being a sync `def`, which FastAPI already
            # hands to a worker thread.
            result = await run_in_threadpool(clean_sample, path, cleaned)
            report = result.as_dict()
            path = cleaned
            print(
                f"[engine] cleaned voice sample: SNR {result.snr_before} -> "
                f"{result.snr_after} dB (+{result.improvement_db}) in {result.seconds}s"
                + (f" | {result.separation_error}" if result.separation_error else ""),
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            # Never lose an upload over the cleanup step: fall back to the
            # original file, which is exactly what the app did before this
            # existed, and tell the interface why it is not cleaned.
            print("[engine] voice cleanup failed:\n" + traceback.format_exc(), flush=True)
            report = {"failed": str(exc)}

    _voice_paths[voice_id] = path
    if transcript.strip():
        _voice_prompts[voice_id] = transcript.strip()

    # Keep it. A clone someone recorded, cleaned and checked should still be
    # there tomorrow, under a name they recognise — not something they have to
    # upload again every session. `path` is the cleaned file when cleaning ran,
    # which is the one that should be cloned from later as well.
    saved = saved_voices.add(
        DATA_DIR,
        voice_id,
        name or Path(sample.filename or "").stem or "",
        path,
        transcript,
    )
    return JSONResponse({"voice_id": voice_id, "cleanup": report, "name": saved.name})


@app.patch("/voices/{voice_id}")
def rename_voice(voice_id: str, name: str = Form(...)) -> JSONResponse:
    if not saved_voices.rename(DATA_DIR, voice_id, name):
        raise HTTPException(status_code=404, detail="No such saved voice.")
    return JSONResponse({"ok": True, "name": name.strip()})


@app.delete("/voices/{voice_id}")
def forget_voice(voice_id: str) -> JSONResponse:
    """Forget a saved voice and delete its recording."""
    if not saved_voices.remove(DATA_DIR, voice_id):
        raise HTTPException(status_code=404, detail="No such saved voice.")
    _voice_paths.pop(voice_id, None)
    _voice_prompts.pop(voice_id, None)
    return JSONResponse({"ok": True})


def _finite(value) -> float | None:
    """JSON has no -inf: a silent clip reports a null loudness instead."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 2) if math.isfinite(number) else None


def _prune_results(keep: int | None = None) -> None:
    """Keep only the most recent clips so the data dir doesn't grow forever."""
    keep = KEEP_RESULTS if keep is None else keep
    clips = sorted(OUT_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in clips[keep:]:
        # Drop the chat-app exports built from this clip too, or they outlive
        # the WAV and the directory fills up with orphans.
        for suffix in (".wav", *EXPORT_SUFFIXES):
            try:
                stale.with_suffix(suffix).unlink()
            except OSError:
                pass


MEDIA_TYPES = {
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
}


@app.get("/audio/{name}")
def get_audio(name: str) -> FileResponse:
    """Serve a generated clip, or one of the chat-app exports built from it.

    Range requests are handled by FileResponse, which the webview's audio
    element relies on for playback and seeking."""
    requested = Path(name)
    stem = requested.stem
    suffix = requested.suffix.lower() or ".wav"
    if not _ID_RE.fullmatch(stem) or suffix not in MEDIA_TYPES:
        raise HTTPException(status_code=404, detail="No such clip.")
    path = OUT_DIR / f"{stem}{suffix}"
    if not path.exists():
        raise HTTPException(status_code=404, detail="That clip is gone — generate it again.")
    return FileResponse(path, media_type=MEDIA_TYPES[suffix])


@app.post("/export/{audio_id}")
def export_clip(audio_id: str, target: str = Form(...)) -> JSONResponse:
    """Re-encode a finished clip for a chat app.

    Telegram treats only OGG/Opus as voice, so sharing the WAV would arrive as a
    file attachment. The result is cached next to the clip: re-sharing the same
    take costs nothing. See `share.py` for what each target wants.
    """
    if not _ID_RE.fullmatch(audio_id):
        raise HTTPException(status_code=404, detail="No such clip.")
    if target not in TARGETS:
        raise HTTPException(status_code=400, detail=f"Unknown share target {target!r}.")

    source = OUT_DIR / f"{audio_id}.wav"
    if not source.exists():
        raise HTTPException(status_code=404, detail="That clip is gone — generate it again.")

    try:
        path, spec, encoder = export(source, target)
    except Exception as exc:  # noqa: BLE001
        print("[engine] export failed:\n" + traceback.format_exc(), flush=True)
        raise HTTPException(
            status_code=500, detail=f"Could not encode for {target}: {exc}"
        ) from exc

    return JSONResponse(
        {
            "id": audio_id,
            "target": spec.key,
            "label": spec.label,
            "note": spec.note,
            "format": path.suffix.lstrip("."),
            "encoder": encoder,
            "path": str(path),
            "url": f"/audio/{path.name}",
            "bytes": path.stat().st_size,
        }
    )


@app.post("/tts")
def synthesize(
    text: str = Form(...),
    voice: str = Form("female"),     # "female" | "male" | a voice_id
    # Commercial tuner. `style` empty or "none" means an undirected read.
    style: str = Form(""),
    energy: int | None = Form(None),
    pace: str = Form(""),
    mastering: str = Form(""),
) -> JSONResponse:
    if _status != "ready" or _model is None:
        raise HTTPException(status_code=503, detail=f"Engine not ready ({_status}). {_error_detail}")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text to speak.")

    # Khmer digits are read as digits by the model, so spell them out first.
    # Runs as a whole, not only on Khmer text: a mixed string needs its English
    # run normalised in English, and an English-only one still has symbols and
    # shorthand to spell out.
    text = normalize_for_speech(text)

    if voice in BUILTIN_VOICES:
        reference = designed_voice(_model, voice, VOICES_DIR, _design_lock)
        # We know this clip's transcript exactly — it is what the voice was
        # designed from — so the read can use continuation cloning and hold the
        # voice steadier across sentences. `generate_long` drops it by itself
        # when a style instruction is in play, since the two don't mix.
        prompt_text = SEED_TEXT
    else:
        path = _voice_paths.get(voice)
        if not path or not path.exists():
            raise HTTPException(status_code=404, detail="Unknown voice — upload the sample again.")
        reference = str(path)
        prompt_text = _voice_prompts.get(voice)

    # How it should be read, and how it should be mastered afterwards.
    if style and style != "none":
        direction = build_direction(style, energy, pace, mastering or None)
    else:
        direction = plain_direction(mastering or CLEANUP_DEFAULT, pace)
    print(
        f"[engine] {len(text)} chars · voice={voice} · style={direction.style} "
        f"· cfg={direction.cfg_value} · master={direction.mastering}",
        flush=True,
    )

    # Wall-clock cost of this read. Measured around synthesis *and* mastering,
    # because that is the whole wait the person sits through after pressing
    # Generate — splitting it would report a number smaller than their
    # experience. The device is reported alongside it: 50 s means something
    # very different on the GPU than on the CPU, and without it the figure
    # invites the wrong conclusion about the machine.
    started = time.perf_counter()
    try:
        audio, sample_rate = generate_long(
            _model,
            text,
            reference_wav=reference,
            prompt_text=prompt_text,
            control=direction.instruction,
            cfg_value=direction.cfg_value,
            gap_seconds=direction.gap_seconds,
        )
        audio, report = master(audio, sample_rate, direction.mastering)
    except Exception as exc:  # noqa: BLE001
        print("[engine] synthesis failed:\n" + traceback.format_exc(), flush=True)
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}")

    render_seconds = time.perf_counter() - started
    spoken_seconds = len(audio) / float(sample_rate)
    print(
        f"[engine] rendered {spoken_seconds:.1f}s of speech in "
        f"{render_seconds:.1f}s on {_device or 'unknown'} "
        # Spelled out rather than given as "Nx realtime": that phrase is read
        # both ways round, and here the engine is always the slow side of it.
        f"({render_seconds / spoken_seconds:.1f}x the length of the audio)",
        flush=True,
    )

    audio_id = uuid.uuid4().hex
    out_path = OUT_DIR / f"{audio_id}.wav"
    sf.write(out_path, audio, sample_rate, format="WAV", subtype="PCM_16")
    _prune_results()

    return JSONResponse(
        {
            "id": audio_id,
            "url": f"/audio/{audio_id}.wav",
            "path": str(out_path),
            "sample_rate": int(sample_rate),
            "duration": round(spoken_seconds, 2),
            "render_seconds": round(render_seconds, 1),
            "device": _device,
            "style": direction.style,
            "instruction": direction.instruction,
            "mastering": direction.mastering,
            "lufs": _finite(report.get("lufs_out")),
            "peak_db": _finite(report.get("peak_out_db")),
            "gain_db": report.get("gain_db", 0.0),
        }
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
