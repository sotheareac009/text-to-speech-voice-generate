/**
 * Dubbing: a video you already have, speaking another language, still in sync.
 *
 * The work happens in the shorts engine next door — it listens to the video,
 * translates what it hears to fit the time each line has, speaks it with this
 * app's own voices, and lays it back over the picture with the original music
 * kept underneath. This file is the one screen that drives it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Block } from "./Block";
import {
  deleteShort,
  filePath,
  eventsUrl,
  getShorts,
  getShortsConfig,
  startDub,
  videoUrl,
  type ShortsConfig,
  type ShortsVoice,
  type ShortVideo,
} from "./shortsApi";

const LANGUAGES = ["Khmer", "English", "Thai", "Vietnamese", "French", "Spanish", "Chinese"];

/**
 * What the uploaded video is spoken in.
 *
 * "Detect it" is the default and is right for almost every upload: the
 * multilingual model works out the language itself. Naming it explicitly only
 * helps when a video opens on music or noise, where a detector can guess
 * wrong — and choosing English specifically switches to the English-only
 * model, which hears English better than the multilingual one.
 */
const SOURCES = [
  { code: "auto", label: "Detect it" },
  { code: "en", label: "English" },
  { code: "km", label: "Khmer" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "zh", label: "Chinese" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
];
const READS = ["narrative", "friendly", "premium", "announcer", "promo"];

export default function Dub() {
  const [config, setConfig] = useState<ShortsConfig | null>(null);
  const [offline, setOffline] = useState("");
  const [error, setError] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("auto");
  const [language, setLanguage] = useState("Khmer");
  const [voice, setVoice] = useState("male");
  /*
   * Undirected by default — the opposite of the Shorts page, on purpose.
   *
   * A dub is one narrator reading a script from end to end, so holding the
   * same voice matters more than performing each line. A style instruction
   * turns continuation cloning off, and that is what let the first dub drift
   * from 92 Hz to 158 Hz between lines: the narrator appeared to change
   * person. Undirected keeps the voice on 29.7 Hz of drift instead of 73.8.
   */
  const [read, setRead] = useState("");
  const [keepMusic, setKeepMusic] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [video, setVideo] = useState<ShortVideo | null>(null);
  const [library, setLibrary] = useState<ShortVideo[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
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

  if (offline) {
    return (
      <Block
        title="The shorts engine isn't running"
        note="Dubbing is done by the same engine as Shorts. It needs Node, the Claude Code CLI and an ffmpeg with libass, so Voice Studio does not start it — you do, once, in a terminal."
      >
        <pre className="setup-log" style={{ marginTop: 0 }}>
          cd ~/Desktop/Reach/shorts-studio{"\n"}npm run dev
        </pre>
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
  const blocked = !!config && (!config.voice.ok || !config.ffmpeg.ok || !config.claude.ok);

  async function onDub() {
    if (!file) return;
    setError("");
    setLines([]);
    setProgress(0);
    setVideo(null);
    setRunning(true);
    try {
      const form = new FormData();
      // The file goes last: the engine reads the fields before the stream, and
      // multipart delivers them in the order they were added.
      form.set("source", source);
      form.set("language", language);
      form.set("voice", voice);
      form.set("style", read);
      form.set("keepMusic", String(keepMusic));
      form.set("video", file, file.name);

      const { jobId } = await startDub(form);
      const stream = new EventSource(eventsUrl(jobId));
      stream.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev, data.line]);
        setProgress(data.progress);
      });
      stream.addEventListener("done", (e) => {
        setVideo(JSON.parse((e as MessageEvent).data) as ShortVideo);
        setProgress(1);
        setRunning(false);
        stream.close();
        refreshLibrary();
      });
      stream.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        if (raw) {
          setError((JSON.parse(raw) as { error: string }).error);
          setRunning(false);
          stream.close();
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}

      <Block
        title="The video"
        note="Any video with speech in it. The picture is never re-encoded — only its soundtrack is replaced."
      >
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div className="sample-row">
          <button className="btn ghost" onClick={() => fileRef.current?.click()} disabled={running}>
            Choose a video…
          </button>
          <span className={file ? "sample-name ok" : "sample-name"}>
            {file ? `✓ ${file.name} — ${(file.size / 1e6).toFixed(1)} MB` : "No video chosen"}
          </span>
        </div>
      </Block>

      <Block
        title="The new voiceover"
        note="Each line is translated to fit the seconds it occupies, so every phrase starts on the beat the original started on. Leave the read undirected unless you want a performance: directing it makes the voice change character between lines."
      >
        <div className="shorts-row" style={{ marginTop: 0 }}>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Spoken in</span>
            <span className="select-wrap">
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {SOURCES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Into</span>
            <span className="select-wrap">
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </span>
          </label>
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
                <option value="">Undirected — one steady narrator</option>
                {READS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </span>
          </label>
        </div>
        <div className="setup-row">
          <label className="switch">
            <input
              type="checkbox"
              checked={keepMusic}
              onChange={(e) => setKeepMusic(e.target.checked)}
            />
            <span>Keep the original music and effects</span>
          </label>
          <span className="hint muted" style={{ margin: 0 }}>
            Only the old voice is removed, not the whole soundtrack.
          </span>
        </div>
      </Block>

      <Block title="Dub it">
        <div className="setup-row" style={{ marginTop: 0 }}>
          <button className="btn primary" onClick={onDub} disabled={!file || running || blocked}>
            {running ? "Dubbing…" : "Generate the dub"}
          </button>
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

        {video && (
          <div className="short-result">
            <video src={videoUrl(video.file)} controls playsInline />
            <div className="short-side">
              <strong>{video.title}</strong>
              <span className="hint muted" style={{ margin: 0 }}>
                {video.seconds.toFixed(1)}s · {(video.bytes / 1e6).toFixed(1)} MB
              </span>
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
        <Block title="Everything made here" note="Dubs and generated shorts, newest first.">
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
                <button
                  className="take-drop"
                  title="Delete"
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
