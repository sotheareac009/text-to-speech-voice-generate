"""Cloned voices that survive a restart.

An uploaded sample used to live only in a dictionary in memory. The audio file
stayed on disk, but the engine forgot which id belonged to it the moment it
stopped, so a voice someone had recorded, cleaned and tuned was gone the next
time they opened the app and had to be uploaded again. Worse, the files piled
up in the voices directory with nothing to say what any of them were.

This keeps a small index beside those files so a clone becomes a voice the
person owns: named, listed in the picker next to the built-ins, and there
tomorrow.

The index is deliberately a plain JSON file rather than a database. It holds
at most a few dozen rows, it is written once per clone, and a human being can
open it and see what happened — which matters when the thing it points at is
someone's own recording of their own voice.

Robustness rules followed here:

* **A damaged index must not stop the engine.** It is read inside a try and a
  broken file yields an empty list, because losing the names is annoying while
  failing to start is not recoverable by the person.
* **Rows whose audio has gone are dropped on load.** A file can be deleted from
  under us, and a picker entry that produces "unknown voice" on click is worse
  than one that quietly disappeared.
* **Writes are atomic.** The file is written beside itself and moved into
  place, so a crash mid-write cannot leave a half-written index that takes the
  whole list with it.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

INDEX_NAME = "saved_voices.json"

#: Shown in the picker as the group these sit under, next to "Female"/"Male".
GROUP = "My voices"


@dataclass
class SavedVoice:
    id: str
    name: str
    #: Absolute path to the audio actually used as the cloning reference —
    #: the cleaned version when there is one.
    file: str
    #: What the clip says, when the person told us. Empty is normal.
    transcript: str = ""
    created: float = 0.0

    def as_catalog_entry(self) -> dict:
        return {
            "key": self.id,
            "label": self.name,
            "blurb": "Your cloned voice — saved on this machine.",
            "describe": "",
            "group": GROUP,
            "variant": self.name,
            "saved": True,
        }


def index_path(data_dir: Path | str) -> Path:
    return Path(data_dir) / INDEX_NAME


def load(data_dir: Path | str) -> list[SavedVoice]:
    """Every saved voice whose audio is still on disk, newest first."""
    path = index_path(data_dir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []

    voices: list[SavedVoice] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        try:
            voice = SavedVoice(
                id=str(row["id"]),
                name=str(row.get("name") or row["id"]),
                file=str(row["file"]),
                transcript=str(row.get("transcript") or ""),
                created=float(row.get("created") or 0.0),
            )
        except (KeyError, TypeError, ValueError):
            continue
        if Path(voice.file).exists():
            voices.append(voice)
    voices.sort(key=lambda v: v.created, reverse=True)
    return voices


def _write(data_dir: Path | str, voices: list[SavedVoice]) -> None:
    path = index_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then move: a crash half way through leaves the old index intact
    # rather than a truncated one that would lose every saved voice.
    temp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    temp.write_text(json.dumps([asdict(v) for v in voices], indent=2), encoding="utf-8")
    os.replace(temp, path)


def add(data_dir: Path | str, voice_id: str, name: str, file: Path | str,
        transcript: str = "") -> SavedVoice:
    """Save a clone, replacing any earlier row with the same id."""
    voices = [v for v in load(data_dir) if v.id != voice_id]
    voice = SavedVoice(
        id=voice_id,
        name=(name or "").strip() or f"Voice {len(voices) + 1}",
        file=str(Path(file).resolve()),
        transcript=transcript.strip(),
        created=time.time(),
    )
    voices.append(voice)
    _write(data_dir, voices)
    return voice


def rename(data_dir: Path | str, voice_id: str, name: str) -> bool:
    voices = load(data_dir)
    for voice in voices:
        if voice.id == voice_id:
            voice.name = name.strip() or voice.name
            _write(data_dir, voices)
            return True
    return False


def remove(data_dir: Path | str, voice_id: str, delete_audio: bool = True) -> bool:
    """Forget a saved voice, and by default delete its recording too.

    The audio goes because that is what "delete my voice" means to the person
    who recorded it; leaving their sample on disk after they asked for it to
    go would be the wrong default for a file of someone speaking.
    """
    voices = load(data_dir)
    keep = [v for v in voices if v.id != voice_id]
    if len(keep) == len(voices):
        return False
    if delete_audio:
        for voice in voices:
            if voice.id == voice_id:
                try:
                    Path(voice.file).unlink()
                except OSError:
                    pass
    _write(data_dir, keep)
    return True


def catalog(data_dir: Path | str) -> list[dict]:
    return [v.as_catalog_entry() for v in load(data_dir)]
