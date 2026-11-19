/**
 * Faceless shorts, inside this app.
 *
 * The work is done by the Shorts Studio engine next door: Claude writes the
 * script, this app's own voice engine speaks it, Pollinations draws the
 * scenes, and ffmpeg puts them together — all on this machine. This file is
 * only the interface to it.
 *
 * That engine is started separately (`npm run dev` in ../shorts-studio),
 * because it needs Node, the Claude CLI and an ffmpeg built with libass, none
 * of which Voice Studio installs. When it is not running this page says so and
 * says what to type, rather than showing dead controls.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Block } from "./Block";
import { Preview } from "./Preview";
import {
  deleteShort,
  filePath,
  estimateSeconds,
  eventsUrl,
  getShorts,
  getShortsConfig,
  research,
  startRender,
  startSceneImage,
  startSceneImages,
  startSceneVoice,
  cancelJob,
  type SceneTake,
  sceneUrl,
  type SceneShot,
  videoUrl,
  writeScript,
  type Niche,
  type Scene,
  type Script,
  type ShortsConfig,
  type ShortsVoice,
  type ShortVideo,
} from "./shortsApi";

const PLATFORMS = ["TikTok", "YouTube Shorts", "Instagram Reels"];
const LENGTHS = [30, 45, 60, 90, 120, 180, 240, 300];

/** How a length reads to a person: seconds up to a minute, then minutes. */
function lengthLabel(s: number): string {
  if (s < 60) return `~${s} seconds`;
  const m = s / 60;
  return m % 1 === 0 ? `~${m} minute${m > 1 ? "s" : ""}` : `~${m.toFixed(1)} minutes`;
}

/**
 * Scenes for a length — the same rule the engine uses, so the estimate shown
 * here is the work that will actually happen rather than a guess.
 */
function plannedScenes(seconds: number): number {
  if (seconds <= 75) return Math.max(5, Math.min(14, Math.round(seconds / 4.5)));
  return Math.max(14, Math.min(44, Math.round(seconds / 7)));
}

/**
 * Roughly how long this Mac needs, in minutes.
 *
 * Shown before the render rather than discovered during it: a picture is
 * about forty seconds on this machine — measured, not assumed — so a long
 * video is mostly spent drawing, and that is worth knowing before pressing
 * the button rather than twenty minutes in.
 */
function renderMinutes(scenes: number, seconds: number, khmer: boolean): number {
  const drawing = (scenes * 40) / 60;
  const speaking = seconds / (khmer ? 60 : 75);
  return Math.round((drawing + speaking + 0.4 + seconds / 180) * 10) / 10;
}

function effortMinutes(seconds: number, khmer: boolean): number {
  const drawing = (plannedScenes(seconds) * 40) / 60;
  const speaking = seconds / (khmer ? 60 : 75);
  return Math.round((drawing + speaking + 0.4 + seconds / 180) * 10) / 10;
}
const LANGUAGES = ["Khmer", "English", "Thai", "Vietnamese", "French", "Chinese"];
const TONES = [
  "Curious and punchy",
  "Calm and documentary",
  "Warm and friendly",
  "Dramatic and cinematic",
  "Funny and light",
];
const IMAGE_STYLES = [
  { key: "cinematic documentary photography, warm light", label: "Documentary" },
  { key: "cinematic film still, shallow depth of field, dramatic light", label: "Cinematic" },
  { key: "anime illustration, vivid colours, detailed background", label: "Anime" },
  { key: "3D render, soft studio light, octane", label: "3D" },
  { key: "photorealistic photograph, natural light, 50mm", label: "Photo" },
  { key: "minimal flat illustration, two colours, lots of negative space", label: "Minimal" },
];
const CAPTION_STYLES = [
  { key: "pop", label: "Pop + highlight" },
  { key: "minimal", label: "Minimal" },
  { key: "boxed", label: "Boxed" },
] as const;
/** Ready-made highlight colours; the first is the one funshort uses. */
const HIGHLIGHTS = [
  { hex: "#FCE401", label: "Funshort yellow" },
  { hex: "#FF8A00", label: "Orange" },
  { hex: "#00E5A0", label: "Mint" },
  { hex: "#4FC3FF", label: "Sky" },
  { hex: "#FF4FD8", label: "Pink" },
  { hex: "#FFFFFF", label: "White" },
];

const READS = ["narrative", "funny", "promo", "friendly", "premium", "announcer", "heartfelt", "testimonial"];
const MOODS = ["upbeat", "calm", "dramatic", "mysterious", "inspiring"] as const;

/**
 * A setting that survives the app closing.
 *
 * Choosing a voice, a read, a caption colour and a music level before every
 * video is work nobody should repeat — these are preferences, not decisions
 * about one particular short. Written per key so a value added later does not
 * disturb the ones already stored, and wrapped because storage throws rather
 * than returning nothing when it is unavailable.
 */
function useKept<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(`shorts.${key}`);
      return stored === null ? fallback : (JSON.parse(stored) as T);
    } catch {
      return fallback;
    }
  });
  const keep = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(`shorts.${key}`, JSON.stringify(next));
    } catch {
      /* a private window, or storage turned off: the setting just won't last */
    }
  };
  return [value, keep];
}

/** The settings a finished video was made with, in one line. */
function madeWith(video: ShortVideo): string {
  const r = video.request;
  if (!r) return "";
  const bits: string[] = [];
  if (r.voice?.key) bits.push(r.voice.key);
  if (r.voice?.style) bits.push(r.voice.style);
  else if (r.voice) bits.push("undirected");
  if (r.voice?.pace && r.voice.pace !== "natural") bits.push(`${r.voice.pace} pace`);
  if (r.voice?.speed && Math.abs(r.voice.speed - 1) > 0.01) bits.push(`${r.voice.speed}×`);
  if (r.visuals?.style) bits.push(r.visuals.style);
  if (r.captions) bits.push(r.captions.on ? `${r.captions.style} captions` : "no captions");
  if (r.music) bits.push(r.music.on ? `music ${Math.round(r.music.volume * 100)}%` : "no music");
  return bits.join(" · ");
}

/** The stop button: an icon, next to whatever is running. */
function Stop({ onClick, what }: { onClick: () => void; what: string }) {
  return (
    <button className="stop" onClick={onClick} title={`Stop ${what}`} aria-label={`Stop ${what}`}>
      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
      </svg>
    </button>
  );
}

export default function Shorts() {
  const [config, setConfig] = useState<ShortsConfig | null>(null);
  const [offline, setOffline] = useState("");
  const [error, setError] = useState("");

  const [interest, setInterest] = useState("");
  const [platform, setPlatform] = useState(PLATFORMS[0]);
  const [web, setWeb] = useState(false);
  const [niches, setNiches] = useState<Niche[]>([]);
  const [researching, setResearching] = useState(false);

  const [idea, setIdea] = useState("");
  const [seconds, setSeconds] = useKept("seconds", 45);
  const [tone, setTone] = useKept("tone", TONES[0]);
  const [language, setLanguage] = useKept("language", LANGUAGES[0]);
  const [script, setScript] = useState<Script | null>(null);
  const [writing, setWriting] = useState(false);

  const [voice, setVoice] = useKept("voice", "female");
  /*
   * Directed by default. This has been both ways, and the measurement that
   * decided it the first time only told half the story:
   *
   *   directed     pitch drifts 73.8 Hz between scenes, 144.3 Hz range within
   *   undirected   drifts 29.7 Hz between scenes, 111.3 Hz range within
   *
   * Undirected is steadier and flatter — and flat is what a listener calls
   * robotic. Steadiness is a number; expression is the thing people actually
   * hear, so the performance wins and the drift is a known cost.
   */
  const [read, setRead] = useKept("read", "narrative");
  const [pace, setPace] = useKept("pace", "natural");
  const [speed, setSpeed] = useKept("speed", 1);
  const [imageStyle, setImageStyle] = useKept("imageStyle", IMAGE_STYLES[0].key);
  const [capOn, setCapOn] = useKept("capOn", true);
  const [capStyle, setCapStyle] = useKept<"pop" | "minimal" | "boxed">("capStyle", "pop");
  const [capPosition, setCapPosition] = useKept<"middle" | "bottom">("capPosition", "middle");
  const [capUpper, setCapUpper] = useKept("capUpper", false);
  // Measured off the reference video; see POP in the engine's captions module.
  const [capHighlight, setCapHighlight] = useKept("capHighlight", "#FCE401");
  const [capText, setCapText] = useKept("capText", "#FFFFFF");
  const [musicOn, setMusicOn] = useKept("musicOn", true);
  const [musicVolume, setMusicVolume] = useKept("musicVolume", 0.15);

  const [rendering, setRendering] = useState(false);

  /*
   * The pictures, made before the video and kept.
   *
   * Making a video is three steps now rather than one button: write the
   * script, draw its pictures, then render. The middle step exists because a
   * picture that disappoints used to be discovered in a finished video —
   * half an hour of drawing and speaking — and fixing one frame meant doing
   * all of it again.
   */
  const [project, setProject] = useState("");
  const [shots, setShots] = useState<SceneShot[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [redrawing, setRedrawing] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ src: string; caption: string } | null>(null);
  /*
   * Lines already spoken, kept per scene.
   *
   * Optional throughout: a scene with no take is simply spoken during the
   * render, as it always was. The point is to be able to *hear* a line —
   * a name said wrong, a read that is too flat — before committing to the
   * whole video.
   */
  const [takes, setTakes] = useState<SceneTake[]>([]);
  const [speaking, setSpeaking] = useState<number | null>(null);
  /*
   * Drawing has its own log and its own bar.
   *
   * Sharing the render's put "Generating 10 images…" under a Render heading
   * that had not started, and wiped it when the render did. Two pieces of
   * work, two places to watch them.
   */
  const [imgLines, setImgLines] = useState<string[]>([]);
  const [imgProgress, setImgProgress] = useState(0);
  /*
   * What is running right now, so it can be stopped.
   *
   * Each of the three slow things keeps its own job id: drawing a set of
   * pictures, speaking one line, and making the video. A stop button that
   * stops the wrong one is worse than none.
   */
  const [imgJob, setImgJob] = useState("");
  const [voiceJob, setVoiceJob] = useState("");
  const [renderJob, setRenderJob] = useState("");
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [video, setVideo] = useState<ShortVideo | null>(null);
  const [library, setLibrary] = useState<ShortVideo[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const imgLogRef = useRef<HTMLPreElement>(null);

  const refreshLibrary = useCallback(() => {
    getShorts().then(setLibrary).catch(() => undefined);
  }, []);

  const check = useCallback(async () => {
    try {
      setConfig(await getShortsConfig());
      setOffline("");
      refreshLibrary();
    } catch {
      setConfig(null);
      setOffline("not running");
    }
  }, [refreshLibrary]);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);
  useEffect(() => {
    if (imgLogRef.current) imgLogRef.current.scrollTop = imgLogRef.current.scrollHeight;
  }, [imgLines]);

  // ── The engine is not there ────────────────────────────────────────────
  if (offline) {
    return (
      <Block
        title="The shorts engine isn't running"
        note="Shorts are made by a second engine that lives beside this app. It needs Node, the Claude Code CLI and an ffmpeg with libass, so Voice Studio does not install or start it — you do, once, in a terminal."
      >
        <pre className="setup-log" style={{ marginTop: 0 }}>
          cd ~/Desktop/Reach/shorts-studio{"\n"}npm run dev
        </pre>
        <p className="hint muted">
          Leave that terminal open while you work. This page finds it by itself once it is up —
          it listens on port 8787.
        </p>
        <div className="setup-row">
          <button className="btn primary" onClick={check}>
            Look again
          </button>
        </div>
      </Block>
    );
  }

  const voices: ShortsVoice[] = config?.voice.voices ?? [];
  const groups = [...new Set(voices.map((v) => v.group))];
  const blocked = !!config && (!config.ffmpeg.ok || !config.voice.ok || !config.claude.ok);
  const runtime = script ? estimateSeconds(script) : 0;
  // Pictures belong to the script they were drawn for. A rewritten script has
  // different scenes, so showing the old pictures beside it would be a lie.
  const ready = !!script && shots.length === script.scenes.length;
  const shotFor = new Map(shots.map((shot) => [shot.index, shot]));
  const takeFor = new Map(takes.map((take) => [take.index, take]));
  const khmerScript = /[ក-៿]/.test(language) || /khmer/i.test(language);

  async function run<T>(job: () => Promise<T>, busy: (on: boolean) => void, after?: (r: T) => void) {
    setError("");
    busy(true);
    try {
      const result = await job();
      after?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy(false);
    }
  }

  function patchScene(index: number, patch: Partial<Scene>) {
    if (!script) return;
    setScript({
      ...script,
      scenes: script.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  }

  function moveScene(index: number, by: number) {
    if (!script) return;
    const target = index + by;
    if (target < 0 || target >= script.scenes.length) return;
    const scenes = [...script.scenes];
    [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
    setScript({ ...script, scenes });
  }

  /**
   * Wait for a job to appear in the library, for when the live log is lost.
   *
   * Gives up after fifteen minutes, which is far longer than any render on
   * this machine, so a failed render does not leave a timer running forever.
   */
  function watchFor(jobId: string) {
    const until = Date.now() + 15 * 60_000;
    const tick = async () => {
      try {
        const videos = await getShorts();
        const made = videos.find((v) => v.id === jobId);
        if (made) {
          setVideo(made);
          setLibrary(videos);
          setProgress(1);
          setRendering(false);
          return;
        }
      } catch {
        /* the engine may be restarting; try again */
      }
      if (Date.now() < until) setTimeout(tick, 5000);
      else {
        setRendering(false);
        setError("Lost contact with the shorts engine while it was rendering.");
      }
    };
    setTimeout(tick, 5000);
  }

  /** Start a render and follow its log over SSE. */
  /** Step two: every scene's picture, kept where they can be looked at. */
  async function onImages() {
    if (!script) return;
    setError("");
    setImgLines([]);
    setImgProgress(0);
    // Drawing again replaces the set, so the old pictures go now rather than
    // sitting under the scenes pretending to be this run's.
    setShots([]);
    setDrawing(true);
    try {
      const { jobId, project: id } = await startSceneImages(script, imageStyle, project || undefined);
      setImgJob(jobId);
      setProject(id);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setImgLines((prev) => [...prev, data.line]);
        setImgProgress(data.progress);
      });
      // Each picture as it lands, into its own scene — not all of them at
      // the end. Seven minutes of drawing should look like seven minutes of
      // pictures appearing.
      source.addEventListener("step", (e) => {
        const shot = JSON.parse((e as MessageEvent).data) as SceneShot;
        setShots((prev) => [...prev.filter((s) => s.index !== shot.index), shot]);
      });
      source.addEventListener("done", (e) => {
        const made = JSON.parse((e as MessageEvent).data) as { project: string; shots: SceneShot[] };
        setProject(made.project);
        setShots(made.shots);
        setImgProgress(1);
        setDrawing(false);
        source.close();
      });
      source.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        if (raw) {
          setError((JSON.parse(raw) as { error: string }).error);
          setDrawing(false);
          source.close();
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDrawing(false);
    }
  }

  /** One scene again — a different picture, from the same words. */
  async function onRedraw(index: number) {
    if (!script || !project) return;
    setError("");
    setRedrawing(index);
    try {
      const { jobId } = await startSceneImage({
        project,
        index,
        prompt: script.scenes[index].imagePrompt,
        style: imageStyle,
      });
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("done", (e) => {
        const shot = JSON.parse((e as MessageEvent).data) as SceneShot;
        setShots((prev) => prev.map((s) => (s.index === index ? shot : s)));
        setRedrawing(null);
        source.close();
      });
      source.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        if (raw) {
          setError((JSON.parse(raw) as { error: string }).error);
          setRedrawing(null);
          source.close();
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRedrawing(null);
    }
  }

  /** One scene spoken, so it can be heard now rather than after the render. */
  async function onSpeak(index: number) {
    // No project needed: the engine makes one when there is none, which is
    // what lets a line be heard before any picture has been drawn. This used
    // to return here, so the button did nothing at all.
    if (!script) return;
    setError("");
    setSpeaking(index);
    try {
      const { jobId, project: id } = await startSceneVoice({
        project: project || undefined,
        index,
        text: script.scenes[index].text,
        voice: { key: voice, style: read, energy: 3, pace, mastering: "broadcast", speed },
      });
      // The first line spoken is what starts the project when no pictures
      // have been drawn; the pictures then join the same one.
      setProject(id);
      setVoiceJob(jobId);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("done", (e) => {
        const take = JSON.parse((e as MessageEvent).data) as SceneTake;
        setTakes((prev) => [...prev.filter((t) => t.index !== index), take]);
        setSpeaking(null);
        source.close();
      });
      source.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        if (raw) {
          setError((JSON.parse(raw) as { error: string }).error);
          setSpeaking(null);
          source.close();
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSpeaking(null);
    }
  }

  /**
   * Open a finished video as the thing it was made from.
   *
   * Not just "play this file": the script comes back into the editor, each
   * picture back into its scene, each spoken line back under it, and the
   * settings back onto the controls. Changing one line or redrawing one
   * picture and pressing render then costs that one scene — everything else
   * is already made and is reused.
   */
  function open(item: ShortVideo) {
    setVideo(item);
    setError("");
    setLines([]);
    setProgress(0);
    const made = item.request;
    if (made?.script) setScript(made.script);
    setProject(item.project ?? "");
    setShots(item.shots ?? []);
    setTakes(item.takes ?? []);
    if (made?.voice) {
      setVoice(made.voice.key);
      setRead(made.voice.style ?? "");
      setPace(made.voice.pace ?? "natural");
      setSpeed(made.voice.speed ?? 1);
    }
    if (made?.visuals?.style !== undefined) setImageStyle(made.visuals.style);
    if (made?.captions) {
      setCapOn(made.captions.on);
      setCapStyle(made.captions.style as "pop" | "minimal" | "boxed");
      setCapPosition(made.captions.position as "middle" | "bottom");
      setCapUpper(made.captions.uppercase);
    }
    if (made?.music) {
      setMusicOn(made.music.on);
      setMusicVolume(made.music.volume);
    }
  }

  async function onRender() {
    if (!script) return;
    setError("");
    setLines([]);
    setProgress(0);
    setVideo(null);
    setRendering(true);
    try {
      const { jobId } = await startRender({
        script,
        voice: { key: voice, style: read, energy: 3, pace, mastering: "broadcast", speed },
        visuals: { style: imageStyle },
        captions: {
          on: capOn,
          style: capStyle,
          position: capPosition,
          uppercase: capUpper,
          colours: { highlight: capHighlight, text: capText },
        },
        music: { on: musicOn, volume: musicVolume },
        // The pictures that were looked at and kept. Without them the engine
        // would draw its own, which is the old one-button behaviour.
        // Whatever has been drawn, in scene order, with a gap where nothing
        // has. None at all means the engine draws them all, which is the
        // end-to-end render this button always did.
        images: shots.length
          ? script.scenes.map((_, i) => shotFor.get(i)?.name ?? "")
          : undefined,
        // The engine finds the kept takes itself, and only uses the ones that
        // still match these words and these voice settings.
        project: project || undefined,
      });
      setRenderJob(jobId);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev, data.line]);
        setProgress(data.progress);
      });
      // A render that draws its own pictures shows them in their scenes as it
      // goes, exactly as the picture step does — so pressing Make the video
      // with nothing drawn is still something to watch rather than a bar.
      source.addEventListener("step", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as Partial<SceneShot> & {
          project?: string;
        };
        if (data.project && !data.name) {
          setProject(data.project);
          return;
        }
        const shot = data as SceneShot;
        setShots((prev) => [...prev.filter((s) => s.index !== shot.index), shot]);
      });
      source.addEventListener("done", (e) => {
        setVideo(JSON.parse((e as MessageEvent).data) as ShortVideo);
        setProgress(1);
        setRendering(false);
        source.close();
        refreshLibrary();
      });
      source.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        if (raw) {
          setError((JSON.parse(raw) as { error: string }).error);
          setRendering(false);
          source.close();
          return;
        }
        // No data means the *connection* failed, not the render. The render
        // itself is already running on the other side and will finish whether
        // or not this window is listening, so rather than giving up — or
        // worse, waiting forever for a stream that is gone — watch the library
        // for the video to appear.
        if (source.readyState === EventSource.CLOSED) {
          setLines((prev) => [...prev, "Lost the live log — watching for the finished video…"]);
          watchFor(jobId);
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRendering(false);
    }
  }

  return (
    <>
      {preview && (
        <Preview src={preview.src} caption={preview.caption} onClose={() => setPreview(null)} />
      )}
      {config && (
        <div className="chips" style={{ marginBottom: 2 }}>
          {([
            ["Claude", config.claude],
            ["Voice", config.voice],
            ["ffmpeg", config.ffmpeg],
            ["Images", config.images],
          ] as const).map(([label, capability]) => (
            <span
              key={label}
              className={capability.ok ? "badge ready" : "badge error"}
              title={capability.detail}
            >
              <span className="dot" />
              {label}
            </span>
          ))}
        </div>
      )}
      {blocked && config && (
        <div className="alert">
          {[config.claude, config.voice, config.ffmpeg]
            .filter((c) => !c.ok)
            .map((c) => (
              <p key={c.detail}>{c.detail}</p>
            ))}
        </div>
      )}
      {error && <div className="alert">{error}</div>}

      {/* ── 1 ───────────────────────────────────────────────────────────── */}
      <Block
        title="Find a niche"
        note="Optional — Claude suggests niches and specific video ideas for them. Skip it if you already know what to make."
      >
        <div className="shorts-row">
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>Broad interest</span>
            <input
              type="text"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
              placeholder="Khmer food, history, money…"
            />
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Platform</span>
            <span className="select-wrap">
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {PLATFORMS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </span>
          </label>
        </div>
        <div className="setup-row">
          <label className="switch">
            <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
            <span>Search the web (slower)</span>
          </label>
          <button
            className="btn ghost"
            disabled={researching}
            onClick={() =>
              run(
                () => research(interest, platform, web),
                setResearching,
                (r) => setNiches(r.niches),
              )
            }
          >
            {researching ? "Researching…" : "Research niches"}
          </button>
        </div>

        {niches.length > 0 && (
          <div className="niches">
            {niches.map((niche) => (
              <div className="niche" key={niche.name}>
                <strong>{niche.name}</strong>
                <p className="hint muted" style={{ margin: "4px 0 0" }}>
                  {niche.why}
                </p>
                <ul>
                  {niche.ideas.map((text) => (
                    <li key={text}>
                      <button className="linkish" onClick={() => setIdea(text)}>
                        {text}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Block>

      {/* ── 2 ───────────────────────────────────────────────────────────── */}
      <Block
        title="Script"
        note="Claude writes the first draft and cuts each line into caption-sized pieces. Everything here is yours to edit."
        aside={
          script ? (
            <span className="count">
              {script.scenes.length} scenes · ~{runtime.toFixed(0)}s
            </span>
          ) : undefined
        }
      >
        <label className="field" style={{ marginTop: 0 }}>
          <span>Video idea</span>
          <textarea
            className="script"
            style={{ minHeight: 70 }}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Three things tourists get wrong about Khmer coffee"
          />
        </label>

        <div className="shorts-row">
          <label className="field" style={{ marginTop: 0 }}>
            <span>Length</span>
            <span className="select-wrap">
              <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {LENGTHS.map((s) => (
                  <option key={s} value={s}>
                    {lengthLabel(s)}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>Tone</span>
            <span className="select-wrap">
              <select value={tone} onChange={(e) => setTone(e.target.value)}>
                {TONES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Language</span>
            <span className="select-wrap">
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </span>
          </label>
          <button
            className="btn primary"
            disabled={writing || !idea.trim()}
            onClick={() => run(() => writeScript(idea, seconds, tone, language), setWriting, setScript)}
          >
            {writing ? "Writing…" : script ? "Rewrite" : "Write script"}
          </button>
        </div>

        {/*
          * Before a script exists this is an estimate from the length asked
          * for. Once one exists it is the script itself: the finished video
          * is as long as the narration turns out to be — the length above is
          * what Claude was aiming at, never a limit the video is cut to.
          */}
        <p className="hint muted">
          {script ? (
            <>
              The script that came out runs <strong>~{runtime.toFixed(0)}s</strong> over{" "}
              {script.scenes.length} scenes — that is the length of the video, and{" "}
              {script.scenes.length} pictures to draw on this Mac, roughly{" "}
              <strong>{renderMinutes(script.scenes.length, runtime, khmerScript)} minutes</strong>.
            </>
          ) : (
            <>
              {lengthLabel(seconds)} is about {plannedScenes(seconds)} scenes, so{" "}
              {plannedScenes(seconds)} pictures drawn on this Mac — roughly{" "}
              <strong>{effortMinutes(seconds, khmerScript)} minutes</strong> to render once the
              script is written. The finished video runs as long as the script does, not to the
              number above.
              {seconds > 90 &&
                " A script this long is written in parts, which takes a few minutes of its own."}
            </>
          )}
        </p>

        {script && (
          <>
            <label className="field">
              <span>Title</span>
              <input
                type="text"
                value={script.title}
                onChange={(e) => setScript({ ...script, title: e.target.value })}
              />
            </label>

            <div className="scenes">
              {script.scenes.map((scene, i) => (
                <div className="scene" key={i}>
                  {/*
                    * The picture for this scene, beside the words it was
                    * drawn from. Apart, in a grid of their own, you could see
                    * that a picture was wrong but not which line it belonged
                    * to — which is the thing you need in order to fix it.
                    */}
                  <div className="scene-shot">
                    {shotFor.has(i) ? (
                      <>
                        <button
                          className="scene-shot-open"
                          title="Click to see it full size"
                          onClick={() =>
                            setPreview({
                              src: sceneUrl(shotFor.get(i)!.name),
                              caption: `Scene ${i + 1} — ${scene.imagePrompt}`,
                            })
                          }
                        >
                          <img
                            src={sceneUrl(shotFor.get(i)!.name)}
                            alt={scene.imagePrompt}
                            loading="lazy"
                          />
                        </button>
                        <button
                          className="btn ghost tiny"
                          disabled={redrawing !== null || drawing || rendering}
                          onClick={() => onRedraw(i)}
                        >
                          {redrawing === i ? "Drawing…" : "Redraw"}
                        </button>
                      </>
                    ) : (
                      <div className="scene-shot-empty">
                        {drawing ? "drawing…" : "no picture yet"}
                      </div>
                    )}
                  </div>
                  <div className="scene-words">
                  <div className="scene-head">
                    <strong>Scene {i + 1}</strong>
                    <div className="scene-tools">
                      <button onClick={() => moveScene(i, -1)} disabled={i === 0} title="Move up">
                        ↑
                      </button>
                      <button
                        onClick={() => moveScene(i, 1)}
                        disabled={i === script.scenes.length - 1}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() =>
                          setScript({ ...script, scenes: script.scenes.filter((_, j) => j !== i) })
                        }
                        disabled={script.scenes.length <= 1}
                        title="Delete scene"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="script"
                    style={{ minHeight: 58 }}
                    value={scene.text}
                    // The chunks belonged to the old wording, so they are
                    // dropped; the renderer re-cuts the line by itself.
                    onChange={(e) => patchScene(i, { text: e.target.value, chunks: [] })}
                  />
                  <input
                    type="text"
                    className="prompt"
                    value={scene.imagePrompt}
                    onChange={(e) => patchScene(i, { imagePrompt: e.target.value })}
                  />
                  {/*
                    * Hearing one line costs about ten seconds; hearing it for
                    * the first time in a finished video costs the render. A
                    * scene with no take here is simply spoken during the
                    * render, exactly as before.
                    */}
                  <div className="scene-voice">
                    <button
                      className="btn ghost tiny"
                      disabled={speaking !== null || drawing || rendering || !scene.text.trim()}
                      onClick={() => onSpeak(i)}
                    >
                      {speaking === i
                        ? "Speaking…"
                        : takeFor.has(i)
                          ? "Speak again"
                          : "Generate voice"}
                    </button>
                    {speaking === i && voiceJob && (
                      <Stop
                        what="speaking"
                        onClick={async () => {
                          await cancelJob(voiceJob);
                          setSpeaking(null);
                        }}
                      />
                    )}
                    {takeFor.has(i) && (
                      <>
                        <audio controls preload="none" src={sceneUrl(takeFor.get(i)!.name)} />
                        <span className="hint muted" style={{ margin: 0 }}>
                          {takeFor.get(i)!.seconds.toFixed(1)}s
                        </span>
                      </>
                    )}
                  </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="setup-row">
              <button
                className="btn ghost tiny"
                onClick={() =>
                  setScript({
                    ...script,
                    scenes: [...script.scenes, { text: "", imagePrompt: "", chunks: [] }],
                  })
                }
              >
                Add scene
              </button>
            </div>

            {/*
              * The pictures are made from the scenes directly above, so the
              * button belongs here rather than in a block of its own further
              * down the page.
              */}
            <div className="setup-row">
              <button
                className="btn primary"
                onClick={onImages}
                disabled={!script || drawing || rendering || blocked}
              >
                {drawing
                  ? "Drawing…"
                  : ready
                    ? "Draw them all again"
                    : `Generate ${script.scenes.length} images`}
              </button>
              {drawing && imgJob && (
                <Stop
                  what="drawing"
                  onClick={async () => {
                    await cancelJob(imgJob);
                    setDrawing(false);
                    setImgLines((prev) => [...prev, "Stopped. The pictures already drawn are kept."]);
                  }}
                />
              )}
              {(drawing || imgProgress > 0) && (
                <div className="progress">
                  <i style={{ width: `${Math.round(imgProgress * 100)}%` }} />
                </div>
              )}
              <span className="hint muted" style={{ margin: 0 }}>
                {drawing
                  ? `${shots.length}/${script.scenes.length} drawn — each appears in its scene above`
                  : ready
                    ? `${shots.length} kept — redraw any one above, or edit its description first`
                    : `about ${Math.round((script.scenes.length * 40) / 60)} min on this Mac`}
              </span>
            </div>

            {imgLines.length > 0 && (
              <pre className="setup-log" ref={imgLogRef}>
                {imgLines.join("\n")}
              </pre>
            )}

            <div className="shorts-row">
              <label className="field grow" style={{ marginTop: 0 }}>
                <span>Post caption</span>
                <textarea
                  className="script"
                  style={{ minHeight: 58 }}
                  value={script.caption}
                  onChange={(e) => setScript({ ...script, caption: e.target.value })}
                />
              </label>
              <label className="field" style={{ marginTop: 0 }}>
                <span>Music mood</span>
                <span className="select-wrap">
                  <select
                    value={script.musicMood}
                    onChange={(e) =>
                      setScript({ ...script, musicMood: e.target.value as Script["musicMood"] })
                    }
                  >
                    {MOODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </span>
              </label>
            </div>
            <div className="setup-row">
              <span className="hint muted" style={{ margin: 0, flex: "1 1 auto" }}>
                {script.hashtags.join(" ")}
              </span>
              <button
                className="btn ghost tiny"
                onClick={() =>
                  navigator.clipboard.writeText(`${script.caption}\n\n${script.hashtags.join(" ")}`)
                }
              >
                Copy caption + tags
              </button>
            </div>
          </>
        )}
      </Block>

      {/* ── 3 ───────────────────────────────────────────────────────────── */}
      <Block
        title="Voice, visuals & captions"
        note="The voice list is this app's own — built-in voices and anything you have cloned. A directed read performs each scene, which is livelier but lets the voice drift a little between them; undirected is steadier and flatter."
      >
        <div className="shorts-row">
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>Voice</span>
            <span className="select-wrap">
              <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                {groups.map((group) => (
                  <optgroup key={group} label={group}>
                    {voices
                      .filter((v) => v.group === group)
                      .map((v) => (
                        <option key={v.key} value={v.key}>
                          {v.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Read as</span>
            <span className="select-wrap">
              <select value={read} onChange={(e) => setRead(e.target.value)}>
                <option value="">Undirected — steadier, flatter</option>
                {READS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Pace</span>
            <span className="select-wrap">
              <select value={pace} onChange={(e) => setPace(e.target.value)}>
                {["slow", "natural", "fast"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="knob" style={{ flex: "1 1 160px" }}>
            <span>
              Speed — <strong>{speed.toFixed(2)}×</strong>
            </span>
            <input
              type="range"
              min={0.75}
              max={1.5}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>
        </div>

        <h3 className="sub-head">Visuals</h3>
        <div className="chips" style={{ marginTop: 10 }}>
          {IMAGE_STYLES.map((style) => (
            <button
              key={style.key}
              className={style.key === imageStyle ? "chip active" : "chip"}
              onClick={() => setImageStyle(style.key)}
            >
              {style.label}
            </button>
          ))}
        </div>

        <h3 className="sub-head">Captions</h3>
        <div className="shorts-row" style={{ marginTop: 10 }}>
          <label className="switch">
            <input type="checkbox" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} />
            <span>Burn in</span>
          </label>
          <div className="segmented small">
            {CAPTION_STYLES.map((s) => (
              <button
                key={s.key}
                className={s.key === capStyle ? "seg active" : "seg"}
                onClick={() => setCapStyle(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="segmented small">
            {(["middle", "bottom"] as const).map((p) => (
              <button
                key={p}
                className={p === capPosition ? "seg active" : "seg"}
                onClick={() => setCapPosition(p)}
              >
                {p === "middle" ? "Middle" : "Bottom"}
              </button>
            ))}
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={capUpper}
              onChange={(e) => setCapUpper(e.target.checked)}
            />
            <span>UPPERCASE (Latin only)</span>
          </label>
        </div>

        <div className="shorts-row" style={{ marginTop: 12 }}>
          <label className="swatch">
            <input
              type="color"
              value={capHighlight}
              onChange={(e) => setCapHighlight(e.target.value)}
            />
            <span>Spoken word</span>
          </label>
          <label className="swatch">
            <input type="color" value={capText} onChange={(e) => setCapText(e.target.value)} />
            <span>Other words</span>
          </label>
          <div className="chips" style={{ marginTop: 0 }}>
            {HIGHLIGHTS.map((colour) => (
              <button
                key={colour.hex}
                className={colour.hex === capHighlight.toUpperCase() ? "chip active" : "chip"}
                title={colour.label}
                onClick={() => setCapHighlight(colour.hex)}
              >
                <span className="dab" style={{ background: colour.hex }} />
                {colour.label}
              </button>
            ))}
          </div>
        </div>

        <h3 className="sub-head">Music</h3>
        <div className="shorts-row" style={{ marginTop: 10 }}>
          <label className="switch">
            <input
              type="checkbox"
              checked={musicOn}
              onChange={(e) => setMusicOn(e.target.checked)}
            />
            <span>Ambient bed, generated here</span>
          </label>
          <label className="knob" style={{ flex: "1 1 200px" }}>
            <span>
              Volume — <strong>{Math.round(musicVolume * 100)}%</strong>
            </span>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={musicVolume}
              disabled={!musicOn}
              onChange={(e) => setMusicVolume(Number(e.target.value))}
            />
          </label>
        </div>
      </Block>

      {/* ── 4 ───────────────────────────────────────────────────────────── */}
      <Block
        title="Render"
        note={
          ready
            ? "Speaks every scene, lays it over the picture you kept, and cuts it together."
            : shots.length
              ? "Draws the scenes that have no picture yet, keeps the ones that do, then speaks and cuts it together."
              : "Does the whole thing: draws every picture, speaks every scene, and cuts it together."
        }
      >
        <div className="setup-row" style={{ marginTop: 0 }}>
          <button
            className="btn primary"
            onClick={onRender}
            disabled={!script || rendering || drawing || blocked}
          >
            {rendering ? "Rendering…" : ready ? "Generate the video" : "Make the video"}
          </button>
          {rendering && renderJob && (
            <Stop
              what="the render"
              onClick={async () => {
                await cancelJob(renderJob);
                setRendering(false);
                setLines((prev) => [
                  ...prev,
                  "Stopped. The pictures and spoken lines already made are kept.",
                ]);
              }}
            />
          )}
          {(rendering || progress > 0) && (
            <div className="progress">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>

        {lines.length > 0 && (
          <pre className="setup-log" ref={logRef}>
            {lines.join("\n")}
          </pre>
        )}

        {video && (
          <div className="short-result">
            <video src={videoUrl(video.file)} controls playsInline />
            <div className="short-side">
              <strong>{video.title}</strong>
              <span className="hint muted" style={{ margin: 0 }}>
                {video.seconds.toFixed(1)}s · {(video.bytes / 1e6).toFixed(1)} MB · 1080×1920
              </span>
              {/*
                * What it was made with, read back from the file the engine
                * saved beside the video. Six months from now "which voice was
                * that one?" has an answer, and a video worth repeating can be
                * repeated.
                */}
              {madeWith(video) && <span className="made-with">{madeWith(video)}</span>}
              <button className="btn ghost tiny" onClick={() => saveFile(video.file, setError)}>
                {isTauri() ? "Show the MP4 in Finder" : "Download MP4"}
              </button>
              <button className="btn ghost tiny" onClick={() => saveFile(video.srt, setError)}>
                {isTauri() ? "Show the .srt in Finder" : "Download .srt"}
              </button>
            </div>
          </div>
        )}
      </Block>

      {library.length > 0 && (
        <Block
          title="Library"
          note="Everything rendered on this machine, newest first. Open one and it comes back as it was made — script, pictures and spoken lines in their scenes — so changing one thing and rendering again only costs that one thing."
        >
          <div className="takes">
            {library.map((item) => (
              <div key={item.id} className={video?.id === item.id ? "take active" : "take"}>
                <button className="take-main" onClick={() => open(item)}>
                  <span className="take-text">{item.title}</span>
                  <span className="take-meta">
                    {new Date(item.created).toLocaleString()} · {item.seconds.toFixed(0)}s ·{" "}
                    {(item.bytes / 1e6).toFixed(1)} MB
                  </span>
                </button>
                {item.request?.script && (
                  <button
                    className="take-drop"
                    title="Load this script into the editor"
                    onClick={() => setScript(item.request!.script)}
                  >
                    ⤒
                  </button>
                )}
                <button
                  className="take-drop"
                  title="Delete this video"
                  onClick={async () => {
                    await deleteShort(item.id).catch(() => undefined);
                    if (video?.id === item.id) setVideo(null);
                    refreshLibrary();
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </Block>
      )}
    </>
  );
}

/**
 * Hand a finished file to the person.
 *
 * Never as a link. WKWebView ignores the `download` attribute, so an anchor
 * pointing at a video navigates this window to it — the app appears to crash,
 * replaced by a bare video player. In the app the file is revealed in Finder
 * instead; in a browser, where anchors work, the anchor is used.
 */
async function saveFile(file: string, setError: (m: string) => void) {
  try {
    if (isTauri()) {
      await revealItemInDir(await filePath(file));
    } else {
      const link = document.createElement("a");
      link.href = videoUrl(file);
      link.download = file;
      link.click();
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
