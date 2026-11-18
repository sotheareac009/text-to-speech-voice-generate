/**
 * Client for the Shorts Studio engine.
 *
 * That engine is a separate process (`npm run dev` in ../shorts-studio) rather
 * than something this app starts: it needs Node, the Claude CLI and an ffmpeg
 * with libass, none of which Voice Studio installs. So this talks to it when it
 * is there and says plainly when it is not — see `getShortsConfig`.
 */

const BASE = "http://127.0.0.1:8787";

export interface Capability {
  ok: boolean;
  detail: string;
}

export interface ShortsVoice {
  key: string;
  label: string;
  group: string;
}

export interface ShortsConfig {
  ffmpeg: Capability;
  claude: Capability;
  voice: Capability & { voices: ShortsVoice[] };
  images: Capability;
}

export interface Niche {
  name: string;
  why: string;
  audience: string;
  ideas: string[];
}

export interface Scene {
  text: string;
  imagePrompt: string;
  chunks: string[];
}

export interface Script {
  title: string;
  scenes: Scene[];
  caption: string;
  hashtags: string[];
  musicMood: "upbeat" | "calm" | "dramatic" | "mysterious" | "inspiring";
}

export interface ShortVideo {
  id: string;
  file: string;
  srt: string;
  title: string;
  seconds: number;
  bytes: number;
  created: number;
  request?: { script: Script };
}

/** Absolute, because the engine is on another origin than this window. */
export const videoUrl = (file: string) => `${BASE}/videos/${file}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `The shorts engine answered ${res.status}.`);
  }
  return res.json() as Promise<T>;
}

export async function getShortsConfig(): Promise<ShortsConfig> {
  const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`The shorts engine answered ${res.status}.`);
  return res.json() as Promise<ShortsConfig>;
}

export const getShorts = () =>
  fetch(`${BASE}/api/jobs`).then((r) => r.json() as Promise<ShortVideo[]>);

/**
 * Start a slow call and wait for its answer by asking, not by holding.
 *
 * A script from opus takes about fifty seconds and web research can take
 * minutes, while WebKit aborts any request at sixty — which surfaced as
 * "Failed to fetch" on a script that had in fact been written perfectly. The
 * engine now answers immediately with an id and keeps the result until it is
 * collected.
 */
async function waitFor<T>(path: string, body: unknown): Promise<T> {
  const { workId } = await post<{ workId: string }>(path, body);
  const until = Date.now() + 20 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${BASE}/api/work/${workId}`);
    if (res.status === 404) throw new Error("The engine forgot this request — try again.");
    const data = (await res.json()) as { status?: string; result?: T; error?: string };
    if (!res.ok) throw new Error(data.error || `The engine answered ${res.status}.`);
    if (data.status === "done") return data.result as T;
    if (Date.now() > until) throw new Error("Gave up waiting for the engine.");
  }
}

export const research = (interest: string, platform: string, web: boolean) =>
  waitFor<{ niches: Niche[] }>("/api/research", { interest, platform, web });

export const writeScript = (idea: string, seconds: number, tone: string, language: string) =>
  waitFor<Script>("/api/script", { idea, seconds, tone, language });

export const startRender = (request: unknown) => post<{ jobId: string }>("/api/render", request);

/**
 * Hand a video over to be dubbed.
 *
 * Multipart rather than JSON because the video itself goes with it, and the
 * engine streams it to disk instead of holding it in memory.
 */
export async function startDub(form: FormData): Promise<{ jobId: string }> {
  const res = await fetch(`${BASE}/api/dub`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `The shorts engine answered ${res.status}.`);
  }
  return res.json() as Promise<{ jobId: string }>;
}

export const eventsUrl = (jobId: string) => `${BASE}/api/jobs/${jobId}/events`;

/** Where a finished file is on disk, for showing it in Finder. */
export const filePath = (file: string) =>
  fetch(`${BASE}/api/videos/${encodeURIComponent(file)}/path`).then(async (r) => {
    if (!r.ok) throw new Error(`The engine could not find ${file}.`);
    return ((await r.json()) as { path: string }).path;
  });

export const deleteShort = (id: string) =>
  fetch(`${BASE}/api/jobs/${id}`, { method: "DELETE" }).then((r) => r.json());

/**
 * How long a script will run.
 *
 * Khmer is counted in characters because it has no word spaces; this engine
 * speaks it at about 16 a second, measured. Everything else is counted in
 * words at 2.5 a second.
 */
export function estimateSeconds(script: Script): number {
  const text = script.scenes.map((s) => s.text).join(" ");
  if (/[ក-៿]/.test(text)) return [...text.replace(/\s/g, "")].length / 16;
  return text.split(/\s+/).filter(Boolean).length / 2.5;
}
