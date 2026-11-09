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
import threading
import traceback
import uuid
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import soundfile as sf  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

from khmer_normalize import normalize_for_speech  # noqa: E402
from longform import generate_long  # noqa: E402
from mastering import CLEANUP_DEFAULT, master  # noqa: E402
from styles import build_direction, plain_direction, tuner_catalog  # noqa: E402
from voices import BUILTIN_VOICES, SEED_TEXT, designed_voice, voice_catalog  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("VOICE_PORT", "8008"))
MODEL_ID = os.environ.get("VOICE_MODEL", "openbmb/VoxCPM2")

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
_voice_paths: dict[str, Path] = {}      # voice_id -> uploaded sample
_voice_prompts: dict[str, str] = {}     # voice_id -> transcript of that sample
_design_lock = threading.Lock()


def _load_model() -> None:
    global _model, _status, _error_detail
    try:
        from voxcpm import VoxCPM
        print(f"[engine] loading {MODEL_ID} (first run downloads ~5GB)…", flush=True)
        _model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)
        _status = "ready"
        print("[engine] ready", flush=True)
    except Exception as exc:  # noqa: BLE001
        _status = "error"
        _error_detail = f"{type(exc).__name__}: {exc}"
        print("[engine] model failed to load:\n" + traceback.format_exc(), flush=True)


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
    return JSONResponse({**tuner_catalog(), "voices": voice_catalog()})


@app.get("/health")
def health() -> JSONResponse:
    device = ""
    try:
        import torch
        device = "mps" if torch.backends.mps.is_available() else (
            "cuda" if torch.cuda.is_available() else "cpu")
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse(
        {"status": _status, "device": device, "detail": _error_detail, "model": MODEL_ID}
    )


@app.post("/voices")
async def register_voice(
    sample: UploadFile = File(...),
    transcript: str = Form(""),
) -> JSONResponse:
    """Save a voice sample to clone from. `transcript` is optional but, when the
    text really matches the clip, it makes the clone noticeably closer."""
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
    _voice_paths[voice_id] = path
    if transcript.strip():
        _voice_prompts[voice_id] = transcript.strip()
    return JSONResponse({"voice_id": voice_id})


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
        try:
            stale.unlink()
        except OSError:
            pass


@app.get("/audio/{name}")
def get_audio(name: str) -> FileResponse:
    """Serve a generated clip. Range requests are handled by FileResponse, which
    the webview's audio element relies on for playback and seeking."""
    stem = Path(name).stem
    if not _ID_RE.fullmatch(stem):
        raise HTTPException(status_code=404, detail="No such clip.")
    path = OUT_DIR / f"{stem}.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="That clip is gone — generate it again.")
    return FileResponse(path, media_type="audio/wav")


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
        direction = plain_direction(mastering or CLEANUP_DEFAULT)
    print(
        f"[engine] {len(text)} chars · voice={voice} · style={direction.style} "
        f"· cfg={direction.cfg_value} · master={direction.mastering}",
        flush=True,
    )

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
            "duration": round(len(audio) / float(sample_rate), 2),
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
