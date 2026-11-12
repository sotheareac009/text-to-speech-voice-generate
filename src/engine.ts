// Thin client for the local VoxCPM2 engine (http://127.0.0.1:8008).
// The Rust side starts that server; here we just talk to it.

const BASE = "http://127.0.0.1:8008";

export type EngineStatus = "loading" | "ready" | "error";

export interface Health {
  status: EngineStatus;
  device: string;
  detail: string;
  model: string;
}

/** A generated clip, kept on disk by the engine and served over HTTP. */
export interface Clip {
  /** 32-char hex id — also what the Rust `save_audio` command takes. */
  id: string;
  /** Absolute http:// URL for the <audio> element. */
  url: string;
  /** Where the engine wrote the WAV. */
  path: string;
  sampleRate: number;
  /** Length of the speech itself, in seconds. */
  durationSec: number;
  /** Wall-clock seconds the engine spent making this clip. */
  renderSec: number;
  /** "mps" or "cpu" — what actually ran it, which is why it took that long. */
  device: string;
  /** Preset used, or "none" when the tuner was off. */
  style: string;
  /** The exact control instruction the model was given. */
  instruction: string;
  mastering: string;
  /** Delivered loudness and true peak; null for a silent clip. */
  lufs: number | null;
  peakDb: number | null;
  gainDb: number;
}

// ─────────────────────────── commercial tuner ────────────────────────────

export interface StyleOption {
  key: string;
  label: string;
  blurb: string;
  /** The wording handed to the model. */
  describe: string;
  /** Where this style's sliders sit by default. */
  mastering: string;
  energy: number;
  pace: string;
}

export interface MasteringOption {
  key: string;
  label: string;
  blurb: string;
  target_lufs: number;
}

/** `phrase` is exactly what the engine appends, so previews are truthful. */
export interface LevelOption<T> {
  value: T;
  label: string;
  phrase: string;
}

export interface BuiltinVoice {
  key: string;
  label: string;
  blurb: string;
  describe: string;
  /** Voices sharing a group are variants of one choice in the picker. */
  group: string;
  /** Short name for the variant dropdown, where the group is on the button. */
  variant: string;
  /** True for one of the person's own cloned voices, kept on this machine. */
  saved?: boolean;
}

export interface TunerCatalog {
  /** The built-in voices, designed from a description by the engine. */
  voices: BuiltinVoice[];
  styles: StyleOption[];
  mastering: MasteringOption[];
  energy: LevelOption<number>[];
  pace: LevelOption<string>[];
  defaults: {
    style: string;
    energy: number;
    pace: string;
    mastering: string;
    /** What still runs when the performance direction is switched off. */
    cleanup: string;
  };
}

/**
 * How the script should be performed and mastered. `style: ""` means no
 * performance direction — `mastering` still applies, because shipping an
 * uncleaned read is never the goal.
 */
export interface Tuning {
  style: string;
  energy: number;
  pace: string;
  mastering: string;
}

/** The tuner's presets. Owned by the engine so the UI can't drift from it. */
export async function getTuner(): Promise<TunerCatalog> {
  const res = await fetch(`${BASE}/tuner`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** Poll until `status` is "ready" — the model takes a while to load. */
export async function getHealth(): Promise<Health> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return res.json();
}

/** What the engine did to a sample on the way in. */
export interface Cleanup {
  /** Signal-to-noise before and after, in dB. */
  snr_before: number;
  snr_after: number;
  floor_before: number;
  floor_after: number;
  duration_before: number;
  duration_after: number;
  improvement_db: number;
  /** Whether the voice was actually separated from the background. */
  separated: boolean;
  trimmed: boolean;
  /** Set when separation was wanted but unavailable. */
  separation_error: string;
  seconds: number;
  /** Present instead of the rest when cleanup failed outright. */
  failed?: string;
}

export interface RegisteredVoice {
  voiceId: string;
  /** Null when cleaning was switched off, or the engine predates it. */
  cleanup: Cleanup | null;
  /** The name it was saved under, so it can be shown and renamed. */
  name: string;
}

/**
 * Upload a voice sample to clone. `transcript` is optional: when it really
 * matches what the clip says, the clone comes out noticeably closer.
 *
 * The engine strips background from the sample before using it. That is on
 * by default because the model clones the *sound* of the reference, not only
 * the speaker — a clip recorded over music gives a voice with music under
 * everything it later says.
 */
export async function registerVoice(
  sample: File,
  transcript = "",
  clean = true,
  name = "",
): Promise<RegisteredVoice> {
  const form = new FormData();
  form.append("sample", sample);
  if (transcript.trim()) form.append("transcript", transcript.trim());
  form.append("clean", clean ? "true" : "false");
  if (name.trim()) form.append("name", name.trim());
  const res = await fetch(`${BASE}/voices`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorText(res));
  const data = (await res.json()) as {
    voice_id: string;
    cleanup?: Cleanup | null;
    name?: string;
  };
  return { voiceId: data.voice_id, cleanup: data.cleanup ?? null, name: data.name ?? "" };
}

/** Rename one of the saved clones. */
export async function renameVoice(voiceId: string, name: string): Promise<void> {
  const form = new FormData();
  form.append("name", name);
  const res = await fetch(`${BASE}/voices/${voiceId}`, { method: "PATCH", body: form });
  if (!res.ok) throw new Error(await errorText(res));
}

/** Forget a saved clone and delete its recording. */
export async function forgetVoice(voiceId: string): Promise<void> {
  const res = await fetch(`${BASE}/voices/${voiceId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorText(res));
}

/**
 * Speak `text`. `voice` is "female", "male", or a voice id from registerVoice.
 * Language is detected from the text itself — no need to pick one. Pass
 * `tuning` to direct the read like an ad and master it for delivery.
 *
 * The engine returns a URL rather than the audio itself: the webview's media
 * player needs a real URL it can issue byte-range requests against, and a
 * `blob:` URL from `URL.createObjectURL` does not reliably play in WKWebView.
 */
export async function synthesize(
  voice: string,
  text: string,
  tuning?: Tuning,
): Promise<Clip> {
  const form = new FormData();
  form.append("text", text);
  form.append("voice", voice);
  // Mastering is independent of the performance direction, so it goes either way.
  if (tuning?.mastering) form.append("mastering", tuning.mastering);
  if (tuning?.style) {
    form.append("style", tuning.style);
    form.append("energy", String(tuning.energy));
    form.append("pace", tuning.pace);
  }
  const res = await fetch(`${BASE}/tts`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorText(res));
  const data = (await res.json()) as {
    id: string;
    url: string;
    path: string;
    sample_rate: number;
    duration: number;
    render_seconds: number;
    device: string;
    style: string;
    instruction: string;
    mastering: string;
    lufs: number | null;
    peak_db: number | null;
    gain_db: number;
  };
  return {
    id: data.id,
    url: `${BASE}${data.url}`,
    path: data.path,
    sampleRate: data.sample_rate,
    durationSec: data.duration,
    renderSec: data.render_seconds,
    device: data.device,
    style: data.style,
    instruction: data.instruction,
    mastering: data.mastering,
    lufs: data.lufs,
    peakDb: data.peak_db,
    gainDb: data.gain_db,
  };
}

/** Fetch a clip's bytes — used by the browser download fallback. */
export async function fetchClip(clip: Clip): Promise<Blob> {
  const res = await fetch(clip.url);
  if (!res.ok) throw new Error(await errorText(res));
  return res.blob();
}

// ──────────────────────────── sharing to chat apps ────────────────────────

/** Where a clip can be sent. The engine owns the encoding for each one. */
export type ShareTarget = "telegram" | "messenger";

/** A clip re-encoded for one chat app. */
export interface Export {
  target: ShareTarget;
  label: string;
  /** What the format is and why, straight from the engine. */
  note: string;
  /** "ogg", "m4a" or "mp3" — the fallback encoder changes the container. */
  format: string;
  /** "ffmpeg" or "libsndfile"; the UI says so when the format is not the ideal one. */
  encoder: string;
  /** Absolute path on disk, for revealing the file in Finder. */
  path: string;
  /** Absolute http:// URL, for the browser download fallback. */
  url: string;
  bytes: number;
}

/**
 * Re-encode a clip for a chat app.
 *
 * Telegram only draws the voice-message bubble for OGG/Opus, so sending the
 * WAV would arrive as a file attachment instead. The engine caches the result
 * next to the clip, so re-sharing the same take is instant.
 */
export async function exportFor(clip: Clip, target: ShareTarget): Promise<Export> {
  const form = new FormData();
  form.append("target", target);
  const res = await fetch(`${BASE}/export/${clip.id}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorText(res));
  const data = (await res.json()) as Export;
  return { ...data, url: `${BASE}${data.url}` };
}

async function errorText(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.detail ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
