/**
 * Motion films.
 *
 * The other kind of video, and deliberately its own screen: no pictures, no
 * image model, no GPU. An idea becomes a script, the script is read by one of
 * your voices, and every frame is drawn by a browser — typography, diagrams
 * and glow on a dark screen, the way a technical explainer looks when someone
 * has bothered.
 *
 * It shares nothing with the Shorts workbench but the engine it talks to:
 * separate endpoints, a separate folder of finished films, separate settings.
 * Changing one cannot disturb the other.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Block } from "./Block";
import {
  cancelJob,
  deleteFilm,
  eventsUrl,
  getShortsConfig,
  deleteStyle,
  listFilms,
  listStyles,
  motionFilePath,
  saveStyle,
  motionUrl,
  startMotion,
  uploadFile,
  type MotionItem,
  type MotionStyle,
  type ShortsConfig,
} from "./shortsApi";

const LENGTHS = [30, 45, 60, 90, 120, 180, 300];
const TONES = ["Punchy", "Calm explainer", "Dramatic", "Friendly teacher", "Blunt"];
const LANGUAGES = ["Khmer", "English", "Thai", "Vietnamese", "French"];
const LOOKS = [
  { key: "auto", label: "Automatic — the script chooses" },
  { key: "glow", label: "Glow — lit, soft, rounded" },
  { key: "poster", label: "Poster — heavy type, flat, on the beat" },
  { key: "mono", label: "Mono — thin, squared, scanlined" },
];

const READS = [
  { key: "", label: "Undirected — most consistent" },
  { key: "narrative", label: "Narrative" },
  { key: "funny", label: "Fun fact" },
];

const lengthLabel = (s: number) => (s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? "s" : ""}`);

/** Settings survive a restart, like everywhere else in this app. */
function useKept<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`motion.${key}`);
      return saved === null ? fallback : (JSON.parse(saved) as T);
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(`motion.${key}`, JSON.stringify(next));
      } catch {
        /* a private window: the setting just will not last */
      }
    },
  ];
}

function Stop({ onClick }: { onClick: () => void }) {
  return (
    <button className="stop" onClick={onClick} title="Stop" aria-label="Stop">
      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
      </svg>
    </button>
  );
}

export default function Motion() {
  const [config, setConfig] = useState<ShortsConfig | null>(null);
  const [error, setError] = useState("");

  const [idea, setIdea] = useKept("idea", "");
  const [seconds, setSeconds] = useKept("seconds", 60);
  const [tone, setTone] = useKept("tone", TONES[0]);
  const [language, setLanguage] = useKept("language", LANGUAGES[0]);
  const [voice, setVoice] = useKept("voice", "female");
  const [read, setRead] = useKept("read", "");
  const [musicOn, setMusicOn] = useKept("musicOn", true);
  const [musicVolume, setMusicVolume] = useKept("musicLevel", 0.2);
  const [musicFile, setMusicFile] = useKept<{ name: string; path: string } | null>("musicFile", null);
  const [look, setLook] = useKept("look", "auto");
  const [style, setStyle] = useKept("style", "");
  const [styles, setStyles] = useState<MotionStyle[]>([]);
  const [mark, setMark] = useKept("mark", "");
  const musicRef = useRef<HTMLInputElement>(null);

  const [film, setFilm] = useState<MotionItem | null>(null);
  const [project, setProject] = useState("");
  const [keepScript, setKeepScript] = useState(true);
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [films, setFilms] = useState<MotionItem[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(() => {
    listFilms()
      .then(setFilms)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    getShortsConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
    refresh();
    listStyles().then(setStyles).catch(() => undefined);
  }, [refresh]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const voices = config?.voice.voices ?? [];
  const script = film?.script ?? null;

  async function make() {
    if (!idea.trim() && !script) return;
    setError("");
    setLines([]);
    setProgress(0);
    setRunning(true);
    try {
      const { jobId } = await startMotion({
        // A script already written is reused, so a second take pays neither
        // for the writing nor for the lines it has already spoken.
        script: keepScript && script ? script : undefined,
        idea: idea.trim(),
        language,
        tone,
        seconds,
        voice: {
          key: voice,
          style: read,
          energy: 3,
          pace: "natural",
          mastering: "broadcast",
          speed: 1,
        },
        music: { on: musicOn, volume: musicVolume, file: musicFile?.path },
        look,
        style: style || undefined,
        project: keepScript && project ? project : undefined,
        mark: mark.trim() || undefined,
      });
      setJob(jobId);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev, data.line]);
        setProgress(data.progress);
      });
      source.addEventListener("done", (e) => {
        const made = JSON.parse((e as MessageEvent).data) as MotionItem;
        setFilm(made);
        setProject(made.project ?? "");
        setKeepScript(true);
        setRunning(false);
        setJob("");
        source.close();
        refresh();
      });
      source.addEventListener("error", (e) => {
        const detail = (e as MessageEvent).data;
        let said = "The engine stopped answering.";
        try {
          said = detail ? String((JSON.parse(detail) as { error?: string }).error ?? detail) : said;
        } catch {
          said = String(detail || said);
        }
        setError(said);
        setRunning(false);
        setJob("");
        source.close();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  function open(item: MotionItem) {
    setFilm(item);
    setProject(item.project ?? "");
    setKeepScript(true);
    setLines([]);
    setProgress(0);
    const made = item.request;
    if (made?.idea) setIdea(made.idea);
    if (made?.language) setLanguage(made.language);
    if (made?.tone) setTone(made.tone);
    if (made?.voice) {
      setVoice(made.voice.key);
      setRead(made.voice.style ?? "");
    }
    if (made?.music) {
      setMusicOn(made.music.on);
      setMusicVolume(made.music.volume);
    }
    if (made?.look) setLook(made.look);
  }

  async function show(file: string) {
    try {
      const { path } = await motionFilePath(file);
      if (isTauri()) {
        await revealItemInDir(path);
      } else {
        window.open(motionUrl(file), "_blank");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}
      {config && !config.voice.ok && <div className="alert">{config.voice.detail}</div>}

      <Block
        title="What is it about?"
        note="Claude writes the scenes: what is said, the few words that stay on screen while it is said, the pills under them, and which diagram each scene shows. There is no image model in this — every frame is drawn, so it costs no GPU and never comes back with six fingers."
      >
        <label className="field" style={{ marginTop: 0 }}>
          <span>Idea</span>
          <textarea
            className="script"
            style={{ minHeight: 70 }}
            value={idea}
            onChange={(e) => {
              setIdea(e.target.value);
              // A new idea is a new film: the script and the lines already
              // spoken belong to the old one.
              if (script) setKeepScript(false);
            }}
            placeholder="JSON Web Tokens vs session cookies, for Khmer developers"
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
            <span>Style</span>
            <span className="select-wrap">
              <select value={style} onChange={(e) => setStyle(e.target.value)}>
                <option value="">None — composed for this film</option>
                {styles.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Look</span>
            <span className="select-wrap">
              <select value={look} onChange={(e) => setLook(e.target.value)}>
                {LOOKS.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
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
        </div>
      </Block>

      <Block title="Voice & music">
        <div className="shorts-row">
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>Voice</span>
            <span className="select-wrap">
              <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                {voices.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Read</span>
            <span className="select-wrap">
              <select value={read} onChange={(e) => setRead(e.target.value)}>
                {READS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>

        <div className="shorts-row" style={{ marginTop: 10 }}>
          <label className="switch">
            <input
              type="checkbox"
              checked={musicOn}
              onChange={(e) => setMusicOn(e.target.checked)}
            />
            <span>{musicFile ? "Music under the voice" : "Ambient bed, generated here"}</span>
          </label>
          <label className="knob" style={{ flex: "1 1 240px" }}>
            <span>
              Volume — <strong>{Math.round(musicVolume * 100)}%</strong>{" "}
              <span className="muted">
                {musicVolume > 0
                  ? `${Math.round(-20 * Math.log10(musicVolume))} dB under the voice while it speaks`
                  : "silent"}
              </span>
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

        <input
          ref={musicRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={async (e) => {
            const chosen = e.target.files?.[0];
            if (!chosen) return;
            try {
              setMusicFile({ name: chosen.name, path: await uploadFile(chosen) });
              setMusicOn(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
        <div className="sample-row">
          <button className="btn ghost" onClick={() => musicRef.current?.click()} disabled={running}>
            Choose a music file…
          </button>
          <span className={musicFile ? "sample-name ok" : "sample-name"}>
            {musicFile ? `✓ ${musicFile.name}` : "None — the generated bed is used"}
          </span>
          {musicFile && (
            <button className="btn ghost tiny" onClick={() => setMusicFile(null)}>
              Remove
            </button>
          )}
        </div>

        <label className="field">
          <span>Signature in the corner — optional</span>
          <input value={mark} onChange={(e) => setMark(e.target.value)} placeholder="Reach Studio" />
        </label>
      </Block>

      <Block
        title="Make the film"
        note={
          script && keepScript
            ? "The script below is kept, and so is every line already spoken — only what changed is done again."
            : "Writes the script, reads it in your voice, draws every frame, lays the music under it."
        }
      >
        <div className="sample-row">
          <button
            className="btn primary"
            onClick={make}
            disabled={running || (!idea.trim() && !script)}
          >
            {running ? "Working…" : script && keepScript ? "Make it again" : "Make the film"}
          </button>
          {running && job && (
            <Stop
              onClick={() => {
                cancelJob(job).catch(() => undefined);
                setRunning(false);
              }}
            />
          )}
          {script && !running && (
            <label className="switch" style={{ marginLeft: 4 }}>
              <input
                type="checkbox"
                checked={keepScript}
                onChange={(e) => setKeepScript(e.target.checked)}
              />
              <span>Keep this script</span>
            </label>
          )}
          {(running || progress > 0) && (
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

        {film && !running && (
          <div className="short-result">
            <video src={motionUrl(film.file)} controls playsInline />
            <div className="short-side">
              <strong>{film.title}</strong>
              <span className="hint muted" style={{ margin: 0 }}>
                {film.seconds.toFixed(1)}s · {(film.bytes / 1e6).toFixed(1)} MB · 1080×1920 ·{" "}
                {film.script?.scenes?.length ?? 0} scenes
              </span>
              {film.look && film.design && (
                <button
                  className="btn ghost tiny"
                  onClick={async () => {
                    const name = prompt("Name this style", film.title.slice(0, 30));
                    if (!name?.trim()) return;
                    try {
                      setStyles(
                        await saveStyle({
                          name: name.trim(),
                          look: film.look,
                          design: film.design,
                          from: film.title,
                        }),
                      );
                      setStyle(name.trim());
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  Save this style
                </button>
              )}
              <button className="btn ghost tiny" onClick={() => show(film.file)}>
                {isTauri() ? "Show the MP4 in Finder" : "Open the MP4"}
              </button>
            </div>
          </div>
        )}
      </Block>

      {styles.length > 0 && (
        <Block
          title="Styles"
          note="A film that came out right, kept as the house style. Pick one above and the next film is made in it rather than composed from its own title."
        >
          <div className="takes">
            {styles.map((s) => (
              <div key={s.name} className={style === s.name ? "take active" : "take"}>
                <button className="take-main" onClick={() => setStyle(style === s.name ? "" : s.name)}>
                  <span className="take-text">{s.name}</span>
                  <span className="take-meta">
                    {s.look} · {s.design.align} · {s.design.height} · {s.design.pills} ·{" "}
                    {s.design.energy} · {s.design.backdrop}
                    {s.from ? ` · from "${s.from}"` : ""}
                  </span>
                </button>
                <button
                  className="take-drop"
                  title="Forget this style"
                  onClick={async () => {
                    setStyles(await deleteStyle(s.name).catch(() => styles));
                    if (style === s.name) setStyle("");
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </Block>
      )}

      {script && (
        <Block
          title="Scenes"
          note="What is said, and the few words that stay on screen while it is said."
        >
          <div className="takes">
            {script.scenes.map((s, i) => (
              <div key={i} className="take">
                <div className="take-main" style={{ cursor: "default" }}>
                  <span className="take-text">
                    {i + 1}. {s.headline}
                  </span>
                  <span className="take-meta">{s.say}</span>
                  {s.chips?.length ? (
                    <span className="take-meta">{s.chips.join("  ·  ")}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Block>
      )}

      {films.length > 0 && (
        <Block
          title="Films"
          note="Everything drawn on this machine, newest first. Open one and it comes back as it was made — its script and its spoken lines with it — so changing one thing and making it again only costs that one thing."
        >
          <div className="takes">
            {films.map((item) => (
              <div key={item.id} className={film?.id === item.id ? "take active" : "take"}>
                <button className="take-main" onClick={() => open(item)}>
                  <span className="take-text">{item.title}</span>
                  <span className="take-meta">
                    {new Date(item.created).toLocaleString()} · {item.seconds.toFixed(0)}s ·{" "}
                    {(item.bytes / 1e6).toFixed(1)} MB · {item.script?.scenes?.length ?? 0} scenes
                  </span>
                </button>
                <button
                  className="take-drop"
                  title="Delete this film"
                  onClick={async () => {
                    await deleteFilm(item.id).catch(() => undefined);
                    if (film?.id === item.id) setFilm(null);
                    refresh();
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
