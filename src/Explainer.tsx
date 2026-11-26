/**
 * Explainers.
 *
 * Every other screen in this app asks the engine to draw something. This one
 * asks Claude to *write* the animation: the motion-graphics skills from
 * github.com/Barty-Bart/motion-graphics describe how to build one HTML page
 * whose every frame is a function of time — a camera that does the editing,
 * the product's interface rebuilt and filmed up close, a soundtrack
 * synthesised to the same timeline — and then render it with motion blur.
 *
 * Which means the animation is written fresh for each video rather than
 * composed from a vocabulary, and it takes correspondingly longer: minutes
 * for a draft, up to an hour for a final. The form says so, because a person
 * who does not know that will think it has hung.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Block } from "./Block";
import {
  cancelJob,
  eventsUrl,
  explainerPath,
  explainerUrl,
  getExplainers,
  getNarration,
  getShortsConfig,
  startExplainer,
  startExplainerVoice,
  startRetime,
  suggestBrief,
  type ExplainerItem,
  type ExplainerStyle,
  type NarrationLine,
  type ShortsConfig,
} from "./shortsApi";

const LANGUAGES = ["Khmer", "English", "Thai", "Vietnamese"];

/** 90 → "1.5 minutes", the way the shorts picker says it. */
const lengthLabel = (s: number) => {
  if (s < 60) return `${s} seconds`;
  const mins = Number((s / 60).toFixed(1));
  return `${mins} minute${mins === 1 ? "" : "s"}`;
};

const FORMATS = [
  { key: "9:16", label: "9:16 — a short" },
  { key: "16:9", label: "16:9 — a website or YouTube" },
];

function useKept<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`explainer.${key}`);
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
        localStorage.setItem(`explainer.${key}`, JSON.stringify(next));
      } catch {
        /* a private window: the setting just will not last */
      }
    },
  ];
}

export default function Explainer() {
  const [styles, setStyles] = useState<ExplainerStyle[]>([]);
  const [config, setConfig] = useState<ShortsConfig | null>(null);
  const [voice, setVoice] = useKept("voice", "female");
  const [language, setLanguage] = useKept("language", "Khmer");
  const [voicing, setVoicing] = useState(false);
  const [script, setScript] = useState<NarrationLine[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saying, setSaying] = useState<number | null>(null);
  const [speed, setSpeed] = useKept("speed", 1.25);
  const [voiceOn, setVoiceOn] = useKept("voiceOn", true);
  const [captions, setCaptions] = useKept("captions", true);
  const [highlight, setHighlight] = useKept("highlight", "#FCE401");
  const [items, setItems] = useState<ExplainerItem[]>([]);
  const [error, setError] = useState("");

  const [idea, setIdea] = useKept("idea", "");
  const [style, setStyle] = useKept("style", "explainer-default");
  const [format, setFormat] = useKept("format", "9:16");
  const [takeaway, setTakeaway] = useKept("takeaway", "");
  const [brand, setBrand] = useKept("brand", "");
  const [url, setUrl] = useKept("url", "");
  const [notes, setNotes] = useKept("notes", "");
  const [textLanguage, setTextLanguage] = useKept("textLanguage", "Khmer");
  const [quality, setQuality] = useKept<"draft" | "final">("quality", "draft");
  const [seconds, setSeconds] = useKept("seconds", 0);
  const [pace, setPace] = useKept<"slow" | "normal" | "fast">("pace", "normal");

  const [running, setRunning] = useState(false);
  const [job, setJob] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [made, setMade] = useState<ExplainerItem | null>(null);
  const [thinking, setThinking] = useState(false);
  const [why, setWhy] = useState("");
  const [began, setBegan] = useState(0);
  const [now, setNow] = useState(0);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(() => {
    getExplainers()
      .then((data) => {
        setStyles(data.styles);
        setItems(data.items);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    getShortsConfig().then(setConfig).catch(() => undefined);
  }, [refresh]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);
  // A long build needs a clock, or it looks stuck.
  useEffect(() => {
    if (!running && !voicing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, voicing]);

  const chosen = styles.find((s) => s.key === style);
  /*
   * The lengths this style can be.
   *
   * Not a free number: a promo is twelve to twenty seconds and a demo is
   * forty-five to ninety, because that is what each one is designed around.
   * Zero means "whatever the style's default is", so the picker starts
   * agreeing with the style rather than overriding it.
   */
  const lengths = chosen
    ? (chosen.max > 100
        ? [45, 60, 90, 120, 180, 240]
        : Array.from(
            { length: Math.floor((chosen.max - chosen.min) / 2) + 1 },
            (_, i) => chosen.min + i * 2,
          )
      ).filter((n) => n >= chosen.min && n <= chosen.max)
    : [];
  const length = chosen ? (seconds >= chosen.min && seconds <= chosen.max ? seconds : chosen.seconds) : seconds;
  const elapsed = began ? Math.floor((now - began) / 1000) : 0;
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  /**
   * Work the rest of the brief out from the idea.
   *
   * It fills the boxes rather than hiding them: everything it decides stays
   * editable, and the one-line reason it gives for the style is shown, so a
   * choice can be disagreed with rather than merely accepted.
   */
  async function fillIn() {
    if (!idea.trim() || thinking) return;
    setError("");
    setThinking(true);
    try {
      const made = await suggestBrief(idea.trim(), format);
      if (styles.some((s) => s.key === made.style)) setStyle(made.style);
      if (made.seconds) setSeconds(made.seconds);
      setTakeaway(made.takeaway);
      setBrand(made.brand);
      setNotes(made.notes);
      setWhy(made.why || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
    }
  }

  async function make() {
    if (!idea.trim()) return;
    setError("");
    setLines([]);
    setProgress(0);
    setMade(null);
    setRunning(true);
    setBegan(Date.now());
    setNow(Date.now());
    try {
      const { jobId } = await startExplainer({
        idea: idea.trim(),
        style,
        format,
        takeaway: takeaway.trim() || undefined,
        brand: brand.trim() || undefined,
        url: url.trim() || undefined,
        notes: notes.trim() || undefined,
        seconds: length,
        pace,
        // Captions are burned along the bottom, so the
        // skill has to leave that strip empty while it composes.
        captionBand: voiceOn && captions,
        textLanguage,
        quality,
        voiceover: voiceOn
          ? {
              language,
              voice: { key: voice },
              captions,
              colours: { highlight, text: "#FFFFFF" },
            }
          : undefined,
      });
      setJob(jobId);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev.slice(-400), data.line]);
        setProgress(data.progress);
      });
      source.addEventListener("done", (e) => {
        setMade(JSON.parse((e as MessageEvent).data) as ExplainerItem);
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

  /**
   * Put a voice over a finished explainer.
   *
   * The frames are not touched: the narration is written against the beat
   * sheet the video was built from, spoken in one of your voices, and mixed
   * over the sound it already has — which steps down while a line plays.
   */
  async function addVoice(item: ExplainerItem, rewrite = false) {
    return addVoiceWith(item, { rewrite });
  }

  async function addVoiceWith(
    item: ExplainerItem,
    how: { rewrite?: boolean; lines?: NarrationLine[] },
  ) {
    if (voicing) return;
    setError("");
    setLines([]);
    setProgress(0);
    setVoicing(true);
    setBegan(Date.now());
    setNow(Date.now());
    try {
      const { jobId } = await startExplainerVoice(item.id, {
        language,
        voice: { key: voice },
        captions,
        colours: { highlight, text: "#FFFFFF" },
        rewrite: how.rewrite,
        lines: how.lines,
      });
      setJob(jobId);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev.slice(-400), data.line]);
        setProgress(data.progress);
      });
      source.addEventListener("done", (e) => {
        setMade(JSON.parse((e as MessageEvent).data) as ExplainerItem);
        setVoicing(false);
        setJob("");
        source.close();
        refresh();
      });
      source.addEventListener("error", () => {
        setError("The voiceover stopped. The log above says where.");
        setVoicing(false);
        setJob("");
        source.close();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVoicing(false);
    }
  }

  /*
   * The words that were said, as they were said.
   *
   * Loaded whenever a voiced film is on screen so they can be corrected: a
   * narration written against a beat sheet gets the timing right and the
   * wording not always, and the wording is the half a person can fix in ten
   * seconds. Only the lines that change are spoken again.
   */
  useEffect(() => {
    if (!made) {
      setScript(null);
      return;
    }
    let live = true;
    // Whether this film is a voiced copy is not the question — whether it has
    // words is. Asking for them works for films made before anything recorded
    // what they were laid over.
    getNarration(made.id)
      .then((got) => {
        if (live) {
          setScript(got.lines.length ? got.lines : null);
          setDirty(false);
        }
      })
      .catch(() => {
        if (live) setScript(null);
      });
    return () => {
      live = false;
    };
  }, [made]);

  /** Speak the script as it now stands, and remake only the sound. */
  async function updateVoice() {
    if (!made || !script) return;
    await addVoiceWith(made, { lines: script });
    setDirty(false);
  }

  /**
   * Speak every line again.
   *
   * Not the same as pressing the button on each: this marks all of them, so
   * each one is read afresh rather than reused. For when the voice itself is
   * wrong — a different speaker, or a reading that was off throughout.
   */
  async function speakAll() {
    if (!made || !script || voicing) return;
    await addVoiceWith(made, { lines: script.map((l) => ({ ...l, retake: true })) });
    setDirty(false);
  }

  /**
   * Speak one line again, now.
   *
   * The whole script goes with it so edits elsewhere are not lost, but only
   * this line is marked for a fresh take — everything whose words are
   * unchanged is reused, so this costs one line of the voice model and a
   * remix, about half a minute.
   */
  async function speakLine(i: number) {
    if (!made || !script || voicing) return;
    setSaying(i);
    try {
      await addVoiceWith(made, {
        lines: script.map((l, j) => (j === i ? { ...l, retake: true } : l)),
      });
      setDirty(false);
    } finally {
      setSaying(null);
    }
  }

  /**
   * Put a finished film's brief back in the form.
   *
   * Style, length and pace are decided before a frame exists, so they cannot
   * be changed on a video that is already made. This is the next best thing:
   * everything it was asked for comes back, and whatever is on the dials now
   * — a faster pace, a different length — is what the new one is made with.
   * It is a fresh render, with everything that costs.
   */
  function reuseBrief(item: ExplainerItem) {
    const was = item.request;
    if (!was) return;
    if (was.idea) setIdea(was.idea);
    if (was.style && styles.some((s) => s.key === was.style)) setStyle(was.style);
    if (was.format) setFormat(was.format);
    if (was.takeaway) setTakeaway(was.takeaway);
    if (was.brand) setBrand(was.brand);
    if (was.url) setUrl(was.url);
    if (was.notes) setNotes(was.notes);
    if (was.textLanguage) setTextLanguage(was.textLanguage);
    setMade(null);
    setLines([]);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /**
   * The same film on a different clock.
   *
   * The page it was drawn from is still here and every frame of it is a
   * function of time, so this re-draws each frame at its new moment rather
   * than dropping frames out of the finished file — which would judder
   * exactly on the camera moves this style is built around. Minutes, and no
   * model at all.
   */
  async function reSpeed(item: ExplainerItem) {
    if (voicing || running) return;
    setError("");
    setLines([]);
    setProgress(0);
    setVoicing(true);
    setBegan(Date.now());
    setNow(Date.now());
    try {
      const { jobId } = await startRetime(item.id, speed);
      setJob(jobId);
      const source = new EventSource(eventsUrl(jobId));
      source.addEventListener("log", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { line: string; progress: number };
        setLines((prev) => [...prev.slice(-400), data.line]);
        setProgress(data.progress);
      });
      source.addEventListener("done", (e) => {
        setMade(JSON.parse((e as MessageEvent).data) as ExplainerItem);
        setVoicing(false);
        setJob("");
        source.close();
        refresh();
      });
      source.addEventListener("error", () => {
        setError("Re-timing stopped. The log above says where.");
        setVoicing(false);
        setJob("");
        source.close();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVoicing(false);
    }
  }

  async function show(file: string) {
    try {
      const { path } = await explainerPath(file);
      if (isTauri()) await revealItemInDir(path);
      else window.open(explainerUrl(file), "_blank");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}

      <Block
        title="What is the video about?"
        note="Claude writes the animation itself for this one — one page whose every frame is a function of time, a camera that does the editing, and a soundtrack built to the same clock. It is slower than anything else here and it moves far better."
      >
        <label className="field" style={{ marginTop: 0 }}>
          <span>The idea</span>
          <textarea
            className="script"
            style={{ minHeight: 70 }}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="A booking app for Khmer salons: customers pick a stylist, see free slots, and pay a deposit"
          />
        </label>

        <div className="chips" style={{ marginTop: 10 }}>
          {styles.map((s) => (
            <button
              key={s.key}
              className={s.key === style ? "chip active" : "chip"}
              onClick={() => setStyle(s.key)}
              title={s.blurb}
            >
              {s.label}
            </button>
          ))}
        </div>
        {made && (
          <p className="hint muted">
            These decide the <em>next</em> video. Style, length and pace are read while the skill
            writes it, so they cannot change one that is already made — use “Make another from this
            brief” on a finished film to carry its words over and render it again.
          </p>
        )}
        {chosen && (
          <p className="hint muted">
            {chosen.blurb} This one will be {lengthLabel(length)}.
            {length > 90 &&
              " That is past what this style is written around, so it will add chapters rather than slow down — and it takes proportionally longer to draw."}
            {textLanguage === "Khmer" &&
              " The words on screen carry the story in this style, so they are written in Khmer and set in Kantumruy Pro."}
          </p>
        )}

        <div className="shorts-row">
          <label className="field" style={{ marginTop: 0 }}>
            <span>Shape</span>
            <span className="select-wrap">
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                {FORMATS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Length</span>
            <span className="select-wrap">
              <select value={length} onChange={(e) => setSeconds(Number(e.target.value))}>
                {lengths.map((n) => (
                  <option key={n} value={n}>
                    {lengthLabel(n)}
                    {chosen && n === chosen.seconds ? " — usual" : ""}
                    {chosen && n > 90 && chosen.max > 100 ? " — long" : ""}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Pace</span>
            <span className="select-wrap">
              <select
                value={pace}
                onChange={(e) => setPace(e.target.value as "slow" | "normal" | "fast")}
              >
                <option value="slow">Slow — room to read</option>
                <option value="normal">Normal — the style's own rhythm</option>
                <option value="fast">Fast — cut on the beat</option>
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Words on screen</span>
            <span className="select-wrap">
              <select value={textLanguage} onChange={(e) => setTextLanguage(e.target.value)}>
                {["Khmer", "English", "Thai", "Vietnamese"].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Quality</span>
            <span className="select-wrap">
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as "draft" | "final")}
              >
                <option value="draft">Draft — minutes, no motion blur</option>
                <option value="final">Final — motion blur, up to an hour</option>
              </select>
            </span>
          </label>
        </div>

        {/*
          * The voice is set here rather than after the fact, so one button
          * gives a finished video: the narration is written against the beat
          * sheet the moment the render is done, in the same job.
          */}
        <h3 className="sub-head">Voice</h3>
        <div className="shorts-row" style={{ marginTop: 8 }}>
          <label className="switch">
            <input
              type="checkbox"
              checked={voiceOn}
              onChange={(e) => setVoiceOn(e.target.checked)}
            />
            <span>Speak it too</span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Voice</span>
            <span className="select-wrap">
              <select
                value={voice}
                disabled={!voiceOn}
                onChange={(e) => setVoice(e.target.value)}
              >
                {(config?.voice.voices ?? []).map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Spoken in</span>
            <span className="select-wrap">
              <select
                value={language}
                disabled={!voiceOn}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </span>
          </label>
        </div>
        {voiceOn && (
          <div className="shorts-row" style={{ marginTop: 8 }}>
            <label className="switch">
              <input
                type="checkbox"
                checked={captions}
                onChange={(e) => setCaptions(e.target.checked)}
              />
              <span>Burn the words on, one at a time</span>
            </label>
            {captions && (
              <label className="swatch">
                <input
                  type="color"
                  value={highlight}
                  onChange={(e) => setHighlight(e.target.value)}
                />
                <span>Spoken word</span>
              </label>
            )}
          </div>
        )}
        <p className="hint muted">
          {voiceOn
            ? `The narration is written against the beat sheet the video is built from, so each line lands on its moment. The video's own music steps 14 dB under while it speaks.${captions ? " Burning words on redraws the picture, so that version is re-encoded." : " Without captions the frames are copied untouched."}`
            : "No voice — the words on screen carry it, which is how this style is designed."}
          {voiceOn && captions
            ? " The bottom of the frame is reserved for them while it composes, so nothing it draws ends up underneath."
            : ""}
        </p>
      </Block>

      <Block
        title="Anything it should know"
        note="All optional. Fill them in, or let it work them out from your idea and change what you disagree with."
      >
        <div className="sample-row" style={{ marginTop: 0 }}>
          <button className="btn ghost" onClick={fillIn} disabled={!idea.trim() || thinking || running}>
            {thinking ? "Working it out…" : "Work it out from my idea"}
          </button>
          {why && !thinking && <span className="sample-name ok">{why}</span>}
        </div>

        <label className="field">
          <span>The one thing a viewer must remember</span>
          <input
            value={takeaway}
            onChange={(e) => setTakeaway(e.target.value)}
            placeholder="Book a stylist in three taps"
          />
        </label>
        <div className="shorts-row">
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>Brand — colours, fonts, anything to match</span>
            <input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="deep green #0E5C3F, Kantumruy Pro"
            />
          </label>
          <label className="field grow" style={{ marginTop: 0 }}>
            <span>A website to read first</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
        </div>
        <label className="field">
          <span>Anything to include or avoid</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="show the deposit step; no stock photos; end on the logo"
          />
        </label>
      </Block>

      {made && script && (
        <Block
          title="What it says"
          note="Fix a word and only that line is spoken again — the ones you leave alone are kept, and the video is never re-rendered."
        >
          <div className="takes">
            {script.map((line, i) => (
              <div key={i} className={saying === i ? "take active" : "take"}>
                <div className="take-main" style={{ cursor: "default", gap: 8 }}>
                  <span className="take-meta">{line.at.toFixed(1)}s</span>
                  <textarea
                    className="script"
                    style={{ minHeight: 54, width: "100%" }}
                    value={line.say}
                    onChange={(e) => {
                      const next = script.slice();
                      next[i] = { ...next[i], say: e.target.value };
                      setScript(next);
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="scene-voice">
                  <button
                    className="btn ghost tiny"
                    disabled={voicing || running || !line.say.trim()}
                    onClick={() => speakLine(i)}
                    title="Speak this line again and remix — the picture is untouched"
                  >
                    {saying === i ? "Speaking…" : "Speak again"}
                  </button>
                  {line.take && (
                    <>
                      {/*
                        * The take as it was said. A re-take writes the same
                        * file, so the player is keyed on the film's time to
                        * stop the browser handing back the old sound.
                        */}
                      <audio
                        controls
                        preload="none"
                        src={`${explainerUrl(line.take)}?v=${made.created}`}
                      />
                      {line.seconds !== undefined && (
                        <span className="hint muted" style={{ margin: 0 }}>
                          {line.seconds.toFixed(1)}s
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="sample-row">
            <button
              className="btn primary"
              onClick={updateVoice}
              disabled={voicing || running || !dirty}
            >
              {voicing ? `Speaking… ${clock}` : "Update the voice"}
            </button>
            <button
              className="btn ghost"
              onClick={speakAll}
              disabled={voicing || running}
              title="Every line read afresh"
            >
              Speak every line again
            </button>
            <span className="hint muted" style={{ margin: 0 }}>
              {dirty
                ? "Update speaks only the lines you changed"
                : "Speak again on a row does that one line; the button beside it does all of them"}
            </span>
          </div>
        </Block>
      )}

      <Block
        title="Make it"
        note="It writes a page, checks its own stills, fixes what is wrong, then renders. Nothing to do but watch."
      >
        <div className="sample-row">
          <button className="btn primary" onClick={make} disabled={running || !idea.trim()}>
            {running ? `Working… ${clock}` : "Make the video"}
          </button>
          {running && job && (
            <button
              className="stop"
              title="Stop"
              aria-label="Stop"
              onClick={() => {
                cancelJob(job).catch(() => undefined);
                setRunning(false);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
              </svg>
            </button>
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

        {made && !running && (
          <div className="short-result">
            <video src={explainerUrl(made.file)} controls playsInline />
            <div className="short-side">
              <strong>{made.title}</strong>
              <span className="hint muted" style={{ margin: 0 }}>
                {made.seconds.toFixed(1)}s · {(made.bytes / 1e6).toFixed(1)} MB · {made.style}
              </span>
              <button className="btn ghost tiny" onClick={() => show(made.file)}>
                {isTauri() ? "Show the MP4 in Finder" : "Open the MP4"}
              </button>
              {/*
                * The picture took ten minutes and is not in question — only
                * the voice is. So both of these keep the video exactly as it
                * is and redo the speaking: the first with the same words, the
                * second with new ones.
                */}
              <div className="sample-row" style={{ marginTop: 4 }}>
                <button
                  className="btn ghost tiny"
                  onClick={() => (script ? speakAll() : addVoice(made))}
                  disabled={voicing || running}
                  title={
                    script
                      ? "Every line read afresh — the video is not re-rendered"
                      : "Write a narration and speak it over this video"
                  }
                >
                  {voicing
                    ? `Speaking… ${clock}`
                    : script
                      ? "Speak every line again"
                      : `Add a ${language} voiceover`}
                </button>
                <button
                  className="btn ghost tiny"
                  onClick={() => addVoice(made, true)}
                  disabled={voicing || running}
                  title="Write a new narration, then speak it — the video is not re-rendered"
                >
                  Rewrite the words
                </button>
              </div>
              {/*
                * Pace cannot be changed on a finished render, but speed can:
                * the page is still here and it draws any moment on demand.
                */}
              <div className="shorts-row" style={{ marginTop: 6 }}>
                <label className="field" style={{ marginTop: 0 }}>
                  <span>Re-time it</span>
                  <span className="select-wrap">
                    <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                      <option value={0.8}>0.8× — slower</option>
                      <option value={0.9}>0.9×</option>
                      <option value={1.15}>1.15×</option>
                      <option value={1.25}>1.25× — faster</option>
                      <option value={1.5}>1.5×</option>
                    </select>
                  </span>
                </label>
                <button
                  className="btn ghost tiny"
                  onClick={() => reSpeed(made)}
                  disabled={voicing || running}
                  title="Re-draw every frame on a new clock — no model, minutes not hours"
                >
                  {voicing ? `Working… ${clock}` : "Re-draw at this speed"}
                </button>
              </div>

              {made.request?.idea && (
                <button
                  className="btn ghost tiny"
                  onClick={() => reuseBrief(made)}
                  disabled={voicing || running}
                  title="Fill the form with this film's brief — style, length and pace come from the dials above"
                >
                  Make another from this brief
                </button>
              )}
              <p className="hint muted" style={{ marginTop: 0 }}>
                {script
                  ? "Both keep this video exactly as it is and redo only the voice — the render is not repeated."
                  : "The voice is laid over the finished video; the picture is never re-rendered."}
              </p>
              {made.page && (
                <button className="btn ghost tiny" onClick={() => window.open(explainerUrl(made.page!), "_blank")}>
                  Open the page — scrub it frame by frame
                </button>
              )}
            </div>
          </div>
        )}
      </Block>

      {items.length > 0 && (
        <Block title="Explainers" note="Everything made here, newest first.">
          <div className="takes">
            {items.map((item) => (
              <div key={item.id} className={made?.id === item.id ? "take active" : "take"}>
                <button className="take-main" onClick={() => setMade(item)}>
                  <span className="take-text">{item.title}</span>
                  <span className="take-meta">
                    {new Date(item.created).toLocaleString()} · {item.seconds.toFixed(0)}s ·{" "}
                    {(item.bytes / 1e6).toFixed(1)} MB · {item.style.replace("explainer-", "")}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </Block>
      )}
    </>
  );
}
