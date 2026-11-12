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
import { Block } from "./Block";
import {
  deleteShort,
  estimateSeconds,
  eventsUrl,
  getShorts,
  getShortsConfig,
  research,
  startRender,
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
const LENGTHS = [30, 45, 60];
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
const READS = ["narrative", "promo", "friendly", "premium", "announcer", "heartfelt", "testimonial"];
const MOODS = ["upbeat", "calm", "dramatic", "mysterious", "inspiring"] as const;

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
  const [seconds, setSeconds] = useState(45);
  const [tone, setTone] = useState(TONES[0]);
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [script, setScript] = useState<Script | null>(null);
  const [writing, setWriting] = useState(false);

  const [voice, setVoice] = useState("female");
  const [read, setRead] = useState("narrative");
  const [pace, setPace] = useState("natural");
  const [speed, setSpeed] = useState(1);
  const [imageStyle, setImageStyle] = useState(IMAGE_STYLES[0].key);
  const [capOn, setCapOn] = useState(true);
  const [capStyle, setCapStyle] = useState<"pop" | "minimal" | "boxed">("pop");
  const [capPosition, setCapPosition] = useState<"middle" | "bottom">("middle");
  const [capUpper, setCapUpper] = useState(false);
  const [musicOn, setMusicOn] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.15);

  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [video, setVideo] = useState<ShortVideo | null>(null);
  const [library, setLibrary] = useState<ShortVideo[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

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
        captions: { on: capOn, style: capStyle, position: capPosition, uppercase: capUpper },
        music: { on: musicOn, volume: musicVolume },
      });
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev, data.line]);
        setProgress(data.progress);
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
                    ~{s} seconds
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
        note="The voice list is this app's own — built-in voices and anything you have cloned."
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
                <option value="">Undirected</option>
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
      <Block title="Render">
        <div className="setup-row" style={{ marginTop: 0 }}>
          <button
            className="btn primary"
            onClick={onRender}
            disabled={!script || rendering || blocked}
          >
            {rendering ? "Rendering…" : "Render the video"}
          </button>
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
              <a className="btn ghost tiny" href={videoUrl(video.file)} download>
                Download MP4
              </a>
              <a className="btn ghost tiny" href={videoUrl(video.srt)} download>
                Download .srt
              </a>
            </div>
          </div>
        )}
      </Block>

      {library.length > 0 && (
        <Block title="Library" note="Everything rendered on this machine, newest first.">
          <div className="takes">
            {library.map((item) => (
              <div key={item.id} className={video?.id === item.id ? "take active" : "take"}>
                <button className="take-main" onClick={() => setVideo(item)}>
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
