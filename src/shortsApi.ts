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
  /** What it was made of, so opening it restores the whole workbench. */
  project?: string;
  shots?: SceneShot[];
  takes?: SceneTake[];
  file: string;
  srt: string;
  title: string;
  seconds: number;
  bytes: number;
  created: number;
  /** Everything the video was made with — saved beside it by the engine. */
  request?: {
    script: Script;
    voice?: { key: string; style: string; pace: string; speed: number; energy?: number };
    visuals?: { style: string };
    transition?: { name: string; seconds: number };
    captions?: { on: boolean; style: string; position: string; uppercase: boolean };
    music?: { on: boolean; volume: number };
  };
}

/** Absolute, because the engine is on another origin than this window. */
export const videoUrl = (file: string) => `${BASE}/videos/${file}`;
export const pictureUrl = (file: string) => `${BASE}/pictures/${file}`;

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

/* ── Scene pictures, made before the video ─────────────────────────────── */

export interface SceneShot {
  index: number;
  /** Absent on a shot read back from a finished video: only the name matters. */
  file?: string;
  /** What it is served as — see `sceneUrl`. */
  name: string;
  source?: string;
  prompt: string;
  seed: number;
}

export const sceneUrl = (name: string) => `${BASE}/scenes/${name}`;

export const startSceneImages = (script: unknown, style: string, project?: string) =>
  post<{ jobId: string; project: string }>("/api/scene-images", { script, style, project });

export interface SceneTake {
  index: number;
  name: string;
  seconds: number;
}

export const startSceneVoice = (body: {
  /** Left out for the first scene spoken: the engine makes one and says so. */
  project?: string;
  index: number;
  text: string;
  voice: {
    key: string;
    style: string;
    energy: number;
    pace: string;
    mastering: string;
    speed: number;
  };
}) => post<{ jobId: string; project: string }>("/api/scene-voice", body);

export const startSceneImage = (body: {
  project: string;
  index: number;
  prompt: string;
  style: string;
  seed?: number;
}) => post<{ jobId: string }>("/api/scene-image", body);

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

/** Stop a running job. Never removes a finished video — see deleteShort. */
export const cancelJob = (jobId: string) =>
  fetch(`${BASE}/api/jobs/${jobId}/cancel`, { method: "POST" })
    .then((r) => r.json() as Promise<{ cancelled: boolean }>)
    .catch(() => ({ cancelled: false }));

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


/* ── Pictures ─────────────────────────────────────────────────────────────
 *
 * A picture drawn by the model on this Mac. The engine answers with a job id
 * rather than the picture, because one takes about forty seconds and WebKit
 * abandons a request at sixty.
 */

export interface PictureSize {
  key: string;
  label: string;
  width: number;
  height: number;
}

export interface Picture {
  id: string;
  file: string;
  prompt: string;
  /** What was actually drawn, when Claude put the description into English. */
  drawn?: string;
  /** Words set on the picture afterwards, in a real font. */
  text?: string;
  size: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  model: string;
  seconds: number;
  bytes: number;
  created: number;
}

export interface PictureDesk {
  sizes: PictureSize[];
  model: string;
  steps: number;
  /** False when the model has not been installed on this machine yet. */
  ready: boolean;
  items: Picture[];
}

export const getPictures = () =>
  fetch(`${BASE}/api/pictures`).then((r) => {
    if (!r.ok) throw new Error(`The shorts engine answered ${r.status}.`);
    return r.json() as Promise<PictureDesk>;
  });

export const startPicture = (body: {
  prompt: string;
  size: string;
  steps: number;
  seed?: number;
  improve: boolean;
  khmer: boolean;
  text?: string;
  textPlace?: string;
}) => post<{ jobId: string }>("/api/picture", body);

/** Where a picture is on disk, for showing it in Finder. */
export const picturePath = (file: string) =>
  fetch(`${BASE}/api/pictures/${encodeURIComponent(file)}/path`).then(async (r) => {
    if (!r.ok) throw new Error(`The engine could not find ${file}.`);
    return ((await r.json()) as { path: string }).path;
  });

export const deletePicture = (id: string) =>
  fetch(`${BASE}/api/pictures/${id}`, { method: "DELETE" }).then((r) => r.json());

/** A poster: real type at an exact size, the model used only for a background. */
export const startPoster = (body: {
  heading: string;
  sub?: string;
  colour?: string;
  width: number;
  height: number;
  background?: string;
  place?: string;
  steps?: number;
  layout?: string;
  hero?: string;
  call?: string;
  phoneLabel?: string;
  phone?: string;
  telegramLabel?: string;
  telegram?: string;
  website?: string;
}) => post<{ jobId: string }>("/api/poster", body);

/**
 * Put a file where the engine can reach it; returns its path there.
 *
 * Pictures for a poster, music for a video — the engine accepts either and
 * keeps it in its work folder under a name of its own choosing.
 */
export async function uploadFile(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file, file.name);
  const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `The engine answered ${res.status}.`);
  }
  return ((await res.json()) as { path: string }).path;
}

/** The old name, kept so the poster page does not have to change. */
export const uploadImage = uploadFile;

/* ── Motion films ────────────────────────────────────────────────────────
 *
 * The other kind of video, on its own endpoints and in its own folder on the
 * engine. Nothing here touches the shorts library: a film is not a short and
 * a list that mixed them would hand one to a screen that cannot open it.
 */

export interface MotionSceneText {
  say: string;
  headline: string;
  highlight?: string[];
  chips?: string[];
  kicker?: string;
  art?: Record<string, unknown>;
}

export interface MotionScript {
  title: string;
  caption: string;
  hashtags: string[];
  musicMood: Script["musicMood"];
  scenes: MotionSceneText[];
}

export interface MotionItem {
  id: string;
  project?: string;
  script: MotionScript;
  look?: string;
  design?: MotionStyle["design"];
  file: string;
  title: string;
  seconds: number;
  bytes: number;
  created: number;
  request?: {
    idea?: string;
    language?: string;
    tone?: string;
    seconds?: number;
    voice?: { key: string; style?: string };
    music?: { on: boolean; volume: number; file?: string };
    look?: string;
    mark?: string;
  };
}

export const motionUrl = (file: string) => `${BASE}/motion/${file}`;

/**
 * A 404 from a motion route means one thing, and it is not "not found".
 *
 * The engine is `node dist/server/index.js`, a build frozen at the moment it
 * was made: an engine started before Motion existed answers every one of
 * these routes with Fastify's own 404, which surfaces as the word "Not Found"
 * and explains nothing. An hour was lost to the same thing with a caption
 * fix. Say what it actually is.
 */
function staleEngine(status: number): Error | null {
  return status === 404
    ? new Error(
        "This engine was started before Motion existed, so it has none of its routes. " +
          "Stop it (Ctrl+C) and run `npm start` again — or `npm run dev`, which reloads itself.",
      )
    : null;
}

export const listFilms = () =>
  fetch(`${BASE}/api/motion/videos`).then((r) => {
    const stale = staleEngine(r.status);
    if (stale) throw stale;
    return r.json() as Promise<MotionItem[]>;
  });

export async function startMotion(request: unknown): Promise<{ jobId: string }> {
  const res = await fetch(`${BASE}/api/motion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const stale = staleEngine(res.status);
  if (stale) throw stale;
  const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `The engine answered ${res.status}.`);
  return { jobId: data.jobId as string };
}

export const motionFilePath = (file: string) =>
  fetch(`${BASE}/api/motion/videos/${encodeURIComponent(file)}/path`).then(async (r) => {
    if (!r.ok) throw new Error(`The engine could not find ${file}.`);
    return (await r.json()) as { path: string };
  });

export interface MotionStyle {
  name: string;
  look: string;
  design: {
    align: string;
    height: string;
    pills: string;
    energy: string;
    backdrop: string;
  };
  from?: string;
  created: number;
}

export const listStyles = () =>
  fetch(`${BASE}/api/motion/styles`).then((r) => {
    const stale = staleEngine(r.status);
    if (stale) throw stale;
    return r.json() as Promise<MotionStyle[]>;
  });

export const saveStyle = (body: unknown) => post<MotionStyle[]>("/api/motion/styles", body);

export const deleteStyle = (name: string) =>
  fetch(`${BASE}/api/motion/styles/${encodeURIComponent(name)}`, { method: "DELETE" }).then(
    (r) => r.json() as Promise<MotionStyle[]>,
  );

export const deleteFilm = (id: string) =>
  fetch(`${BASE}/api/motion/videos/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
    r.json(),
  );

/* ── Explainers, written by the motion-graphics skills ───────────────────
 *
 * Not drawn by the engine: Claude Code writes the animation and renders it.
 * Its own endpoints and its own folder, like everything else that is not a
 * short.
 */

export interface ExplainerStyle {
  key: string;
  label: string;
  blurb: string;
  /** What this style is usually. */
  seconds: number;
  /** And the range it is designed to work inside. */
  min: number;
  max: number;
}

export interface ExplainerItem {
  id: string;
  /** Set when this is a voiced copy: the id of the video underneath it. */
  source?: string;
  /** What it was asked for, so the brief can be taken back into the form. */
  request?: {
    idea?: string;
    style?: string;
    format?: string;
    seconds?: number;
    takeaway?: string;
    brand?: string;
    url?: string;
    notes?: string;
    textLanguage?: string;
    pace?: "slow" | "normal" | "fast";
    quality?: "draft" | "final";
  };
  title: string;
  style: string;
  file: string;
  page?: string;
  seconds: number;
  bytes: number;
  created: number;
}

export const explainerUrl = (file: string) => `${BASE}/explainers/${file}`;

export const getExplainers = () =>
  fetch(`${BASE}/api/explainers`).then((r) => {
    const stale = staleEngine(r.status);
    if (stale) throw stale;
    return r.json() as Promise<{ styles: ExplainerStyle[]; items: ExplainerItem[] }>;
  });

export async function startExplainer(request: unknown): Promise<{ jobId: string }> {
  const res = await fetch(`${BASE}/api/explainer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const stale = staleEngine(res.status);
  if (stale) throw stale;
  const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `The engine answered ${res.status}.`);
  return { jobId: data.jobId as string };
}

export interface ExplainerSuggestion {
  style: string;
  seconds: number;
  takeaway: string;
  brand: string;
  notes: string;
  why: string;
}

/** The rest of the brief, worked out from the idea. Slow enough to need the queue. */
export const suggestBrief = (idea: string, format: string) =>
  waitFor<ExplainerSuggestion>("/api/explainer/brief", { idea, format });

/** A voice over an explainer that is already finished. */
export const startExplainerVoice = (
  id: string,
  body: {
    language: string;
    voice: { key: string; style?: string };
    under?: number;
    captions?: boolean;
    colours?: { highlight: string; text: string };
    /** Write the narration again instead of reusing the one already saved. */
    rewrite?: boolean;
    /** The narration as the person left it. */
    lines?: NarrationLine[];
  },
) => post<{ jobId: string }>(`/api/explainer/${encodeURIComponent(id)}/voice`, body);

export interface NarrationLine {
  at: number;
  say: string;
  /** Speak this one again even though the words have not changed. */
  retake?: boolean;
  /** The take that was used, inside the explainers folder, for playing back. */
  take?: string;
  /** How long that take runs. */
  seconds?: number;
}

/** The narration a voiced explainer was made from. */
export const getNarration = (id: string) =>
  fetch(`${BASE}/api/explainer/${encodeURIComponent(id)}/narration`).then((r) => {
    const stale = staleEngine(r.status);
    if (stale) throw stale;
    return r.json() as Promise<{ lines: NarrationLine[] }>;
  });

/** The same film, re-drawn on a faster or slower clock. */
export const startRetime = (id: string, speed: number) =>
  post<{ jobId: string }>(`/api/explainer/${encodeURIComponent(id)}/retime`, { speed });

export const explainerPath = (file: string) =>
  fetch(`${BASE}/api/explainers/${encodeURIComponent(file)}/path`).then(async (r) => {
    if (!r.ok) throw new Error(`The engine could not find ${file}.`);
    return (await r.json()) as { path: string };
  });
