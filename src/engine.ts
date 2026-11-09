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
  durationSec: number;
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

/**
 * Upload a voice sample to clone. `transcript` is optional: when it really
 * matches what the clip says, the clone comes out noticeably closer.
 */
export async function registerVoice(sample: File, transcript = ""): Promise<string> {
  const form = new FormData();
  form.append("sample", sample);
  if (transcript.trim()) form.append("transcript", transcript.trim());
  const res = await fetch(`${BASE}/voices`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorText(res));
  const data = (await res.json()) as { voice_id: string };
  return data.voice_id;
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

async function errorText(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.detail ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
