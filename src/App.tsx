import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  exportFor,
  fetchClip,
  getHealth,
  getTuner,
  registerVoice,
  renameVoice,
  forgetVoice,
  type Cleanup,
  type ShareTarget,
  synthesize,
  type BuiltinVoice,
  type Clip,
  type EngineStatus,
  type Health,
  type TunerCatalog,
  type Tuning,
} from "./engine";
import {
  getEngineState,
  getEnginePackages,
  installEngine,
  installEnvironment,
  installPackage,
  getEngineOptions,
  setEngineMode,
  onInstallDone,
  onInstallLine,
  startEngine,
  type EngineState,
  type EnginePackages,
  type EngineOptions,
} from "./install";
import "./App.css";

/** A built-in voice key from the engine's catalog, or "upload" to clone. */
type VoiceMode = string;
const UPLOAD = "upload";

/** Shown before the engine answers, so the control isn't empty on first paint. */
const FALLBACK_VOICES: BuiltinVoice[] = [
  { key: "female", label: "Lead female", blurb: "", describe: "", group: "Female", variant: "Lead" },
  { key: "male", label: "Lead male", blurb: "", describe: "", group: "Male", variant: "Lead" },
];

/**
 * The chat apps a clip can be handed to.
 *
 * Finding and raising the installed app is the Rust side's job — see
 * `share_to_chat_app`, and `python/share.py` for what each one wants encoded
 * and why. `web` is only for running in a plain browser, where there is no
 * Rust side to ask.
 */
const SHARE: Record<ShareTarget, { label: string; button: string; hint: string; web: string }> = {
  telegram: {
    label: "Telegram",
    button: "Telegram voice",
    hint:
      "Encode as OGG/Opus, mono — what Telegram wants for voice — then copy it and open " +
      "Telegram. A pasted file arrives as an audio message; the waveform bubble needs " +
      "Telegram's own mic or a bot.",
    web: "https://web.telegram.org/",
  },
  messenger: {
    label: "Messenger",
    button: "Messenger",
    hint:
      "Encode as AAC, copy it and open Messenger. Facebook has no way for an app to send " +
      "the file itself, so the paste is yours to make.",
    web: "https://www.messenger.com/",
  },
};

/** Which app was brought to the front. Mirrors `Raised` in `lib.rs`. */
interface Raised {
  /** Bundle id of the app raised, or "" when it wasn't installed. */
  app: string;
  /** Web client opened instead, or "" when the app was raised. */
  web: string;
}

const SHARE_ORDER: ShareTarget[] = ["telegram", "messenger"];

/**
 * What a save writes: the clip as the engine made it, or the clip re-encoded
 * for a chat app — so the Telegram voice file can be kept as a file instead of
 * only being handed straight to Telegram.
 */
type SaveAs = "wav" | ShareTarget;

function App() {
  const [status, setStatus] = useState<EngineStatus>("loading");
  const [health, setHealth] = useState<Health | null>(null);

  const [mode, setMode] = useState<VoiceMode>("female");
  // Remembers the variant picked in each group, so switching away and back
  // doesn't silently reset to the first one.
  const [lastInGroup, setLastInGroup] = useState<Record<string, string>>({});
  const [sampleName, setSampleName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cleanup, setCleanup] = useState<Cleanup | null>(null);
  const [voiceName, setVoiceName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Commercial tuner. `catalog` comes from the engine, so the presets live in
  // one place; `tuning` is null until it loads.
  const [catalog, setCatalog] = useState<TunerCatalog | null>(null);
  const [tunerOn, setTunerOn] = useState(true);
  const [tuning, setTuning] = useState<Tuning | null>(null);

  const [text, setText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [saving, setSaving] = useState<SaveAs | "">("");
  const [savedTo, setSavedTo] = useState("");
  // Which chat app is being encoded for, and how the last share went.
  const [sharing, setSharing] = useState<ShareTarget | "">("");
  const [shared, setShared] = useState("");
  const [error, setError] = useState("");

  // The engine is installed by the user on first run rather than shipped in the
  // app bundle, so before waiting for it we have to know whether it exists.
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [engineChecked, setEngineChecked] = useState(false);
  const [skipUpdate, setSkipUpdate] = useState(false);
  const [forceSetup, setForceSetup] = useState(false);
  // Installed, but nothing answering. Needs an action, not a spinner.
  const [unreachable, setUnreachable] = useState(false);
  const refreshEngine = useCallback(async () => {
    try {
      setEngine(await getEngineState());
    } catch {
      /* no Rust side to ask — assume an engine is already running */
    } finally {
      setEngineChecked(true);
    }
  }, []);
  useEffect(() => {
    refreshEngine();
  }, [refreshEngine]);
  const onEngineInstalled = useCallback(() => {
    setForceSetup(false);
    setUnreachable(false);
    refreshEngine();
  }, [refreshEngine]);
  // An engine built from different requirements than this app ships is offered
  // an update, but never forced — `skipUpdate` is the way past it. An engine
  // already answering on the port is good enough however it got there, so a
  // hand-started one is never nagged about.
  const needsEngine =
    !!engine &&
    (forceSetup ||
      (!engine.running && (!engine.installed || (engine.stale && !skipUpdate))));

  // Poll the engine until the model finishes loading. Pointless before we know
  // the engine is installed, so it waits for that answer first.
  useEffect(() => {
    if (!engineChecked || needsEngine) return;
    let active = true;
    let misses = 0;
    const tick = async () => {
      try {
        const h = await getHealth();
        if (!active) return;
        misses = 0;
        setUnreachable(false);
        setStatus(h.status);
        setHealth(h);
        if (h.status === "loading") setTimeout(tick, 1500);
      } catch {
        if (!active) return;
        // The engine answers within a second or two of starting, long before
        // the model has loaded. Twenty seconds of nothing means it never
        // started at all — on someone else's machine that needs a way out,
        // not a spinner that spins forever.
        misses += 1;
        if (misses >= 12) setUnreachable(true);
        setStatus("loading");
        setTimeout(tick, 1500);
      }
    };
    tick();
    return () => {
      active = false;
    };
  }, [engineChecked, needsEngine]);

  // The tuner presets are served by the engine; fetch them once it's up.
  useEffect(() => {
    if (status !== "ready" || catalog) return;
    let active = true;
    getTuner()
      .then((c) => {
        if (!active) return;
        setCatalog(c);
        setTuning((current) => current ?? styleDefaults(c, c.defaults.style));
      })
      .catch(() => {
        /* the tuner is optional — leave it hidden if the engine can't serve it */
      });
    return () => {
      active = false;
    };
  }, [status, catalog]);

  async function useSample(file: File | null, text: string) {
    if (!file) return;
    setError("");
    setCloning(true);
    setCleanup(null);
    try {
      const { voiceId: id, cleanup: report, name } = await registerVoice(
        file,
        text,
        true,
        voiceName || file.name.replace(/\.[^.]+$/, ""),
      );
      setVoiceId(id);
      setCleanup(report);
      setVoiceName(name);
      // The engine has just gained a voice, so the picker's list is stale.
      // Refetching is what puts the new clone under "My voices" without a
      // restart, and selecting it is what the person expects after a clone.
      const fresh = await getTuner();
      setCatalog(fresh);
      setMode(id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setCloning(false);
    }
  }

  /** Rename a saved clone, then refresh so the picker shows the new name. */
  async function onRenameVoice(id: string, name: string) {
    if (!name.trim()) return;
    try {
      await renameVoice(id, name.trim());
      setCatalog(await getTuner());
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** Delete a saved clone and its recording, then fall back to a built-in. */
  async function onForgetVoice(id: string) {
    try {
      await forgetVoice(id);
      const fresh = await getTuner();
      setCatalog(fresh);
      // Never leave the picker pointing at a voice that no longer exists.
      const fallback = fresh.voices.find((v) => !v.saved);
      if (fallback) setMode(fallback.key);
      if (voiceId === id) setVoiceId("");
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function onPickFile(file: File | undefined) {
    if (!file) return;
    setVoiceId("");
    setCleanup(null);
    setSampleName(file.name);
    setPendingFile(file);
    useSample(file, transcript);
  }

  async function onRetryStart() {
    setError("");
    try {
      await startEngine();
      setUnreachable(false);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function onGenerate() {
    setError("");
    setSavedTo("");
    setGenerating(true);
    setClip(null);
    try {
      // Mastering applies either way; only the performance direction is switched.
      const direction = tuning
        ? { ...tuning, style: tunerOn ? tuning.style : "" }
        : undefined;
      setClip(await synthesize(mode === UPLOAD ? voiceId : mode, text, direction));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Save a copy of the clip — the engine's WAV, or the file one of the chat
   * apps wants. In the app this goes through a native save dialog on the Rust
   * side — WKWebView ignores `<a download>`, so the plain anchor this used to
   * be did nothing at all. In a browser (`npm run dev`) the anchor still
   * works, so fall back to it there.
   *
   * Saving the chat-app encoding is separate from sharing it on purpose: the
   * share buttons put the file on the clipboard and open the app, which is no
   * use when the file is wanted for later, for another device, or for a chat
   * on a phone.
   */
  async function onSave(as: SaveAs = "wav") {
    if (!clip) return;
    setError("");
    setSavedTo("");
    setShared("");
    setSaving(as);
    try {
      // The chat-app encodings do not exist until they are asked for; the
      // engine builds one and caches it beside the clip.
      const made = as === "wav" ? null : await exportFor(clip, as);
      if (isTauri()) {
        const dest = await invoke<string | null>("save_audio", {
          audioId: clip.id,
          // Where the engine says it wrote the file. The app usually
          // started that engine and knows the directory itself, but not
          // when another one was already on the port — then this is the
          // only way to find the clip that is playing.
          enginePath: made ? made.path : clip.path,
          // The encoder decides the container, so this comes from the engine
          // rather than from the button that was pressed.
          format: made ? made.format : "wav",
        });
        if (dest) setSavedTo(dest);
      } else {
        const blob = made ? await (await fetch(made.url)).blob() : await fetchClip(clip);
        const href = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = href;
        link.download = made ? `voice.${made.format}` : "speech.wav";
        link.click();
        // Revoking straight away cancels the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
        setSavedTo("Downloads");
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving("");
    }
  }

  /**
   * Hand a clip to a chat app.
   *
   * Neither of these lets a desktop app drop a file straight into a
   * conversation: Telegram's only route is a bot you would have to register
   * first, and Messenger has none at all — its API is for Pages replying to
   * people who wrote to them. So this does the parts that can be automated —
   * encode the clip to the format that app wants, open the app, and put the
   * file on screen in Finder — and leaves the drag to you.
   */
  async function onShare(target: ShareTarget) {
    if (!clip) return;
    setError("");
    setSavedTo("");
    setShared("");
    setSharing(target);
    try {
      const made = await exportFor(clip, target);
      const format = made.format.toUpperCase();
      if (isTauri()) {
        const copied = await invoke<boolean>("copy_clip_to_clipboard", {
          audioId: clip.id,
          path: made.path,
        });
        // The clipboard is the whole point, but if it refuses the file the user
        // can still drag it out of Finder.
        if (!copied) await revealItemInDir(made.path);
        // Said before the chat app is raised, because that covers this window
        // and the instruction has to be on screen by then.
        setShared(
          copied
            ? `${format} copied — press ⌘V in ${SHARE[target].label} to attach it`
            : `${format} ready in Finder — drag it into ${SHARE[target].label}`,
        );
        // Refine it once we know whether the app was there, for when they come
        // back to this window.
        const raised = await invoke<Raised>("raise_chat_app", { target });
        if (raised.web && copied) {
          // A web client is the less certain target for a paste, so give the
          // drag as well: dropping a file on a conversation always works.
          await revealItemInDir(made.path);
          setShared(
            `${format} copied and shown in Finder — paste or drag it into the ` +
              `${SHARE[target].label} tab`,
          );
        }
      } else {
        // `npm run dev` in a browser: there is no Finder, so download it.
        const href = URL.createObjectURL(await (await fetch(made.url)).blob());
        const link = document.createElement("a");
        link.href = href;
        link.download = `speech.${made.format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
        setShared(`${format} downloaded — attach it in ${SHARE[target].label}`);
        window.open(SHARE[target].web, "_blank", "noopener");
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSharing("");
    }
  }

  // Saving and sharing both read the same clip off disk; let one finish first.
  const busy = saving !== "" || sharing !== "";

  const builtins = catalog?.voices.length ? catalog.voices : FALLBACK_VOICES;
  // One button per group, with a dropdown for its variants — otherwise the
  // picker grows a button every time a voice is added.
  const groups = Array.from(new Set(builtins.map((v) => v.group)));
  const chosen = builtins.find((v) => v.key === mode) ?? null;
  const variants = chosen ? builtins.filter((v) => v.group === chosen.group) : [];

  /** Switch group, returning to whichever variant was last used there. */
  function pickGroup(group: string) {
    const inGroup = builtins.filter((v) => v.group === group);
    const remembered = lastInGroup[group];
    const next = inGroup.find((v) => v.key === remembered) ?? inGroup[0];
    if (next) setMode(next.key);
  }

  function pickVariant(key: string) {
    setMode(key);
    const voice = builtins.find((v) => v.key === key);
    if (voice) setLastInGroup((prev) => ({ ...prev, [voice.group]: key }));
  }

  const ready = status === "ready";
  const voiceReady = mode !== UPLOAD || !!voiceId;
  const canGenerate = ready && voiceReady && text.trim().length > 0 && !generating;
  const genElapsed = useElapsed(generating);

  if (needsEngine && engine) {
    return (
      <main className="app">
        <header className="head">
          <div>
            <h1>Voice Studio</h1>
            <p className="sub">
              One step before you can use it. The voice engine is installed on this machine
              rather than shipped inside the app, because it is far larger than the app.
            </p>
          </div>
          <div className="badge">
            <span className="dot" />
            {engine.installed ? "Engine needs updating" : "Engine not installed"}
          </div>
        </header>
        <SetupCard
          state={engine}
          onInstalled={onEngineInstalled}
          onSkip={() => {
            setSkipUpdate(true);
            setForceSetup(false);
          }}
        />
      </main>
    );
  }

  return (
    <main className="app">
      <header className="head">
        <div>
          <h1>Voice Studio</h1>
          <p className="sub">
            Product voiceovers in Khmer or any of 30 languages — a built-in voice or one cloned
            from a short clip, directed and mastered like an ad. Everything runs on your machine.
          </p>
        </div>
        <div className="head-side">
          <EngineBadge status={status} health={health} />
          {engine?.installed && (
            <button className="btn ghost tiny" onClick={() => setForceSetup(true)}>
              Engine libraries…
            </button>
          )}
        </div>
      </header>

      {/* Shown while loading *and* once ready: a CPU fallback is permanent
          news, not a progress message. */}
      {status !== "error" && health?.detail && (
        <p className="hint note">{health.detail}</p>
      )}
      {status === "error" && health?.detail && (
        <div className="alert">The engine could not start: {health.detail}</div>
      )}

      {unreachable && engine?.installed && (
        <section className="card">
          <div className="step">
            <span className="step-no">!</span>
            <div className="step-body">
              <h2>The engine isn't answering</h2>
              <p className="hint">
                It is installed, but nothing is responding on port 8008. Usually that means it
                could not start — most often because the Python it was built against was
                upgraded or removed since, which breaks the virtualenv's link to it.
              </p>
              <div className="setup-row">
                <button className="btn primary" onClick={onRetryStart}>
                  Start it again
                </button>
                <button className="btn ghost" onClick={() => setForceSetup(true)}>
                  Reinstall the engine
                </button>
              </div>
              <p className="hint muted">
                The engine writes what happened to{" "}
                <span className="mono">{engine.data}/engine.log</span>.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="step">
          <span className="step-no">1</span>
          <div className="step-body">
            <h2>Voice</h2>

            <div className="segmented" role="tablist">
              {groups.map((group) => (
                <button
                  key={group}
                  className={chosen?.group === group ? "seg active" : "seg"}
                  onClick={() => pickGroup(group)}
                >
                  {group}
                </button>
              ))}
              <button className={mode === UPLOAD ? "seg active" : "seg"} onClick={() => setMode(UPLOAD)}>
                Clone from sample
              </button>
            </div>

            {mode !== UPLOAD ? (
              <>
                {variants.length > 1 && (
                  <label className="field narrow">
                    <span>Which {chosen?.group.toLowerCase()} voice</span>
                    <select value={mode} onChange={(e) => pickVariant(e.target.value)}>
                      {variants.map((v) => (
                        <option key={v.key} value={v.key}>
                          {v.variant}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="hint muted">
                  {chosen?.blurb || "Built-in voice — nothing to set up."}
                </p>
                {chosen?.saved && (
                  <div className="saved-row">
                    <input
                      type="text"
                      aria-label="Voice name"
                      defaultValue={chosen.label}
                      key={chosen.key}
                      onBlur={(e) => onRenameVoice(chosen.key, e.target.value)}
                    />
                    <button
                      className="btn ghost tiny"
                      onClick={() => onForgetVoice(chosen.key)}
                    >
                      Delete voice
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="hint">
                  Upload <strong>20–30 seconds</strong> of one person speaking clearly. Music or
                  background noise is stripped out automatically. Only clone a voice you have
                  permission to use.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="audio/*"
                  hidden
                  onChange={(e) => onPickFile(e.target.files?.[0])}
                />
                <div className="sample-row">
                  <button className="btn ghost" onClick={() => fileRef.current?.click()} disabled={cloning}>
                    Choose audio…
                  </button>
                  <span className="sample-name">
                    {cloning
                      ? "Removing background… this takes a moment"
                      : voiceId
                        ? `✓ ${sampleName} — voice ready`
                        : sampleName || "No file selected"}
                  </span>
                </div>
                {!cloning && cleanup && <CleanupNote cleanup={cleanup} />}

                <label className="field">
                  <span>What the clip says (optional — improves the clone)</span>
                  <input
                    type="text"
                    value={transcript}
                    placeholder="Type exactly what is said in the clip…"
                    onChange={(e) => setTranscript(e.target.value)}
                    onBlur={() => pendingFile && useSample(pendingFile, transcript)}
                  />
                </label>
              </>
            )}
          </div>
        </div>
      </section>

      {catalog && tuning && (
        <section className="card">
          <div className="step">
            <span className="step-no">2</span>
            <div className="step-body">
              <div className="row-head">
                <h2>Commercial voice tuner</h2>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={tunerOn}
                    onChange={(e) => setTunerOn(e.target.checked)}
                  />
                  <span>Direct the read</span>
                </label>
              </div>
              <p className="hint muted">
                The direction performs your copy like an ad. The master cleans and opens out the
                voice and brings it to a fixed loudness, so it sits right next to music — that
                part runs whether or not the read is directed.
              </p>

              <Tuner
                catalog={catalog}
                tuning={tuning}
                directed={tunerOn}
                onChange={setTuning}
              />
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="step">
          <span className="step-no">{catalog && tuning ? 3 : 2}</span>
          <div className="step-body">
            <h2>Script</h2>

            <textarea
              className="text"
              rows={6}
              placeholder="សរសេរអត្ថបទនៅទីនេះ… / Type your ad copy here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="hint muted">
              Numbers and dates in Khmer are spoken correctly, and long text is split into sentences
              so the voice stays steady.
            </p>

            <div className="controls">
              <span className="count">{text.trim().length} characters</span>
              <button className="btn primary" onClick={onGenerate} disabled={!canGenerate}>
                {generating ? `Generating… ${genElapsed}s` : "Generate speech"}
              </button>
            </div>

            {mode === UPLOAD && !voiceId && (
              <p className="hint muted">Add a voice sample above first.</p>
            )}
          </div>
        </div>
      </section>

      {error && <div className="alert">{error}</div>}

      {clip && (
        <section className="card result">
          <h2>Result</h2>
          {/* `key` forces a fresh element per clip so the player reloads
              instead of holding on to the previous source. */}
          <audio key={clip.url} controls src={clip.url} />
          <div className="result-row">
            <button className="btn ghost" onClick={() => onSave()} disabled={busy}>
              {saving === "wav" ? "Saving…" : "Save WAV…"}
            </button>
            <button
              className="btn ghost"
              onClick={() => onSave("telegram")}
              disabled={busy}
              title={
                "Save the Telegram voice file itself: OGG/Opus, mono, 32 kbps — the same " +
                "encoding Telegram's own recorder sends. Attached as a file it arrives as " +
                "an audio message; the waveform bubble needs Telegram's mic or a bot."
              }
            >
              {saving === "telegram" ? "Encoding…" : "Save voice message…"}
            </button>
            {SHARE_ORDER.map((key) => (
              <button
                key={key}
                className="btn ghost"
                onClick={() => onShare(key)}
                disabled={busy}
                title={SHARE[key].hint}
              >
                {sharing === key ? "Encoding…" : SHARE[key].button}
              </button>
            ))}
            <span className="hint muted">
              {shared ||
                (savedTo ? `Saved to ${savedTo}` : <ClipFacts clip={clip} catalog={catalog} />)}
            </span>
          </div>
          {clip.instruction && (
            <p className="hint muted mono">Read as {clip.instruction}</p>
          )}
        </section>
      )}
    </main>
  );
}

/** The sliders. Picking a style snaps the rest to that style's own settings. */
function Tuner({
  catalog,
  tuning,
  directed,
  onChange,
}: {
  catalog: TunerCatalog;
  tuning: Tuning;
  /** Whether the performance direction applies. Mastering always does. */
  directed: boolean;
  onChange: (t: Tuning) => void;
}) {
  const style = catalog.styles.find((s) => s.key === tuning.style);
  const mastering = catalog.mastering.find((m) => m.key === tuning.mastering);

  return (
    <>
      {directed && (
        <>
          <div className="chips">
            {catalog.styles.map((s) => (
              <button
                key={s.key}
                className={s.key === tuning.style ? "chip active" : "chip"}
                title={s.blurb}
                onClick={() => onChange(styleDefaults(catalog, s.key))}
              >
                {s.label}
              </button>
            ))}
          </div>
          {style && <p className="hint muted">{style.blurb}</p>}

          <div className="knobs">
            <label className="knob">
              <span>
                Energy — <strong>{labelOf(catalog.energy, tuning.energy)}</strong>
              </span>
              <input
                type="range"
                min={catalog.energy[0].value}
                max={catalog.energy[catalog.energy.length - 1].value}
                step={1}
                value={tuning.energy}
                onChange={(e) => onChange({ ...tuning, energy: Number(e.target.value) })}
              />
            </label>

            <label className="knob">
              <span>Pace</span>
              <div className="segmented small" role="tablist">
                {catalog.pace.map((p) => (
                  <button
                    key={p.value}
                    className={p.value === tuning.pace ? "seg active" : "seg"}
                    onClick={() => onChange({ ...tuning, pace: p.value })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </label>
          </div>

          <p className="hint muted mono">{previewInstruction(catalog, tuning)}</p>
        </>
      )}

      <div className="knobs">
        {/* Pace sits outside the directed block because it is the one control
            that still means something with no style attached: slowing a read
            down is not the same as making it sound like an advert. */}
        {!directed && (
          <label className="knob">
            <span>Pace</span>
            <div className="segmented small" role="tablist">
              {catalog.pace.map((p) => (
                <button
                  key={p.value}
                  className={p.value === tuning.pace ? "seg active" : "seg"}
                  onClick={() => onChange({ ...tuning, pace: p.value })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </label>
        )}
        <label className="knob">
          <span>Master</span>
          <select
            value={tuning.mastering}
            onChange={(e) => onChange({ ...tuning, mastering: e.target.value })}
          >
            {catalog.mastering.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
                {m.key === "off" ? "" : ` — ${m.target_lufs} LUFS`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {mastering && <p className="hint muted">{mastering.blurb}</p>}
      {!directed && (
        <p className="hint muted">
          The read is undirected — the model's own interpretation of your copy — but still
          cleaned and mastered. Choose <strong>Off</strong> above for the raw output.
          {tuning.pace === "natural"
            ? " Pace sets the pause between sentences."
            : tuning.pace === "fast"
              ? " Fast shortens the pauses and speeds the read by roughly 8%. On a cloned" +
                " voice it trades a little steadiness — set it back to Natural if the voice wanders."
              : " Slow widens the pause between sentences. It does not slow the speaking" +
                " rate itself: the model does not reliably obey that in Khmer."}
        </p>
      )}
    </>
  );
}

/** What the engine actually delivered — the numbers that matter for an ad. */
function ClipFacts({ clip, catalog }: { clip: Clip; catalog: TunerCatalog | null }) {
  const style = catalog?.styles.find((s) => s.key === clip.style);
  const master = catalog?.mastering.find((m) => m.key === clip.mastering);
  const facts = [
    `${clip.durationSec.toFixed(1)}s`,
    `${clip.sampleRate / 1000} kHz`,
    renderCost(clip),
    style ? style.label : "undirected read",
    master?.label ?? null,
    clip.lufs === null ? "silent" : `${clip.lufs.toFixed(1)} LUFS`,
    clip.peakDb === null ? null : `peak ${clip.peakDb.toFixed(1)} dBTP`,
  ];
  return <>{facts.filter(Boolean).join(" · ")}</>;
}

/**
 * What this clip cost to make: wall-clock seconds, and which processor spent
 * them. The device matters as much as the number — the same script is minutes
 * on the CPU and under a minute on the GPU, so a bare "92s" reads as a broken
 * app rather than as the price of running a 2B model on this machine.
 *
 * An engine from before this field existed returns nothing for it. That is a
 * normal case, not an error: the window survives an engine restart, so a clip
 * generated by the old shape can still be on screen. Missing simply drops the
 * fact instead of printing "NaNs".
 */
function renderCost(clip: Clip): string | null {
  const seconds = clip.renderSec;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const time =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`
      : `${seconds.toFixed(1)}s`;
  const where = clip.device === "mps" ? "GPU" : clip.device === "cpu" ? "CPU" : "";
  return where ? `made in ${time} on ${where}` : `made in ${time}`;
}

/**
 * What the engine took out of an imported sample, in the terms that matter to
 * the person: is this voice going to come out clean?
 *
 * It reports signal-to-noise rather than "noise removed" because the number
 * that predicts the clone is what is *left*, not what went. A sample can lose
 * 20 dB of background and still be too noisy to clone well, and saying only
 * "20 dB removed" would read as success in exactly the case that needs a
 * warning. So the band is decided by `snr_after`, and the improvement is
 * supporting detail.
 */
function CleanupNote({ cleanup }: { cleanup: Cleanup }) {
  if (cleanup.failed) {
    return (
      <p className="hint muted">
        Could not clean this sample ({cleanup.failed}) — it is being used as it arrived, so
        any background in it will carry into the clone.
      </p>
    );
  }

  const after = cleanup.snr_after;
  const verdict =
    after >= 30
      ? "Clean enough to clone well."
      : after >= 20
        ? "Usable, but some background may still come through."
        : "Still noisy — a quieter recording would clone noticeably better.";

  return (
    <p className="hint muted">
      {cleanup.separated
        ? `Background removed — signal-to-noise ${cleanup.snr_before.toFixed(0)} → ${after.toFixed(0)} dB (+${cleanup.improvement_db.toFixed(0)} dB). `
        : `Sample was already clean (${after.toFixed(0)} dB signal-to-noise) — levelled only. `}
      {cleanup.trimmed && "Silence at the ends trimmed. "}
      {verdict}
      {cleanup.separation_error && ` ${cleanup.separation_error}`}
    </p>
  );
}

/**
 * Seconds since `running` became true, ticking about four times a second so
 * the figure never looks stuck between whole seconds. A generate can take the
 * better part of a minute, and a button that reads "Generating…" for that long
 * with nothing moving is indistinguishable from a hang.
 */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSeconds(0);
    const started = Date.now();
    const id = window.setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      250,
    );
    return () => window.clearInterval(id);
  }, [running]);
  return seconds;
}

/** A style's own energy/pace/mastering, so each preset lands coherent. */
function styleDefaults(catalog: TunerCatalog, key: string): Tuning {
  const style = catalog.styles.find((s) => s.key === key);
  if (!style) {
    const d = catalog.defaults;
    return { style: d.style, energy: d.energy, pace: d.pace, mastering: d.mastering };
  }
  return {
    style: style.key,
    energy: style.energy,
    pace: style.pace,
    mastering: style.mastering,
  };
}

/** The exact instruction the engine will build, assembled from the same parts. */
function previewInstruction(catalog: TunerCatalog, tuning: Tuning): string {
  const style = catalog.styles.find((s) => s.key === tuning.style);
  if (!style) return "";
  const parts = [
    style.describe,
    catalog.energy.find((e) => e.value === tuning.energy)?.phrase ?? "",
    catalog.pace.find((p) => p.value === tuning.pace)?.phrase ?? "",
  ];
  return `(${parts.filter((p) => p).join(", ")})`;
}

function labelOf<T>(options: { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? String(value);
}

function EngineBadge({ status, health }: { status: EngineStatus; health: Health | null }) {
  const label =
    status === "ready" ? `Engine ready · ${(health?.device ?? "").toUpperCase()}`
    : status === "error" ? "Engine error"
    : "Starting engine…";
  return (
    <div className={`badge ${status}`} title={health?.detail ?? ""}>
      <span className="dot" />
      {label}
    </div>
  );
}

/**
 * The engine's libraries, listed, each installable on its own.
 *
 * Installing them one at a time is slower than `pip install -r` in one go, but
 * it shows what is being put on the machine and which step is slow — and if one
 * library fails, the others are already done and only that row needs retrying.
 * The list and its wording come from the engine's own requirements.txt, so it
 * cannot drift from what is actually installed.
 */
function SetupCard({
  state,
  onInstalled,
  onSkip,
}: {
  state: EngineState;
  onInstalled: () => void;
  onSkip: () => void;
}) {
  const [list, setList] = useState<EnginePackages | null>(null);
  /** Which row is installing: "environment", a requirement, "" for all. */
  const [busy, setBusy] = useState<string | null>(state.installing ? "" : null);
  const [lines, setLines] = useState<string[]>([]);
  const [failed, setFailed] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const [options, setOptions] = useState<EngineOptions | null>(null);
  const [switching, setSwitching] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await getEnginePackages());
    } catch (e) {
      setFailed(messageOf(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshOptions = useCallback(async () => {
    try {
      setOptions(await getEngineOptions());
    } catch {
      /* the chooser is optional — hide it rather than block setup */
    }
  }, []);
  useEffect(() => {
    refreshOptions();
  }, [refreshOptions]);

  async function chooseMode(mode: string) {
    if (!options || options.mode === mode || switching) return;
    setFailed("");
    setSwitching(mode);
    try {
      await setEngineMode(mode);
    } catch (e) {
      setFailed(messageOf(e));
    } finally {
      await refreshOptions();
      setSwitching("");
    }
  }

  useEffect(() => {
    const subscriptions = [
      // Keep the tail only: a full pip log is thousands of lines.
      onInstallLine((line) => setLines((prev) => [...prev.slice(-300), line])),
      onInstallDone((result) => {
        setBusy(null);
        if (!result.ok) setFailed(result.error);
        refresh();
      }),
    ];
    return () => {
      subscriptions.forEach((pending) => pending.then((off) => off()).catch(() => {}));
    };
  }, [refresh]);

  // A clock, so a long quiet download still looks like it is moving.
  useEffect(() => {
    if (busy === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines]);

  async function run(target: string, job: () => Promise<void>) {
    setFailed("");
    setLines([]);
    setBusy(target);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      await job();
    } catch (e) {
      setBusy(null);
      setFailed(messageOf(e));
    }
  }

  async function onStart() {
    setStarting(true);
    try {
      await startEngine();
      onInstalled();
    } catch (e) {
      setFailed(messageOf(e));
    } finally {
      setStarting(false);
    }
  }

  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const ready = !!list && list.environmentReady && list.packages.every((p) => p.installed);
  const remaining = list ? list.packages.filter((p) => !p.installed).length : 0;
  const working = busy !== null;
  // A host Python is only needed to build the virtualenv. Once that exists,
  // pip runs from inside it, so a missing host Python must not disable the
  // library rows — only the row that would create the environment.
  const blocked = !!list && !list.environmentReady && !list.python;

  return (
    <section className="card">
      <div className="step">
        <span className="step-no">{ready ? "\u2713" : "\u25c6"}</span>
        <div className="step-body">
          <h2>{ready ? "Engine libraries" : "Install the engine's libraries"}</h2>
          <p className="hint">
            These are the libraries the engine runs on. They are installed here rather than
            shipped inside the app because together they come to about <strong>420 MB</strong>
            {" "}to download and roughly 2 GB on disk. Install them one at a time, or all at
            once. You need Python 3.10–3.13 and around 10 GB free.
          </p>

          {!list ? (
            <p className="hint muted">Reading the list…</p>
          ) : (
            <>
              {list.environmentReady ? null : list.python ? (
                <p className="hint muted mono">
                  Found Python {list.pythonVersion} — {list.python}
                </p>
              ) : (
                <div className="alert">
                  <p>
                    <strong>No usable Python found.</strong> Install Python 3.11, then quit and
                    reopen Voice Studio.
                  </p>
                  <p className="mono">brew install python@3.11</p>
                  <p className="mono">…or the installer from python.org/downloads</p>
                </div>
              )}

              <ol className="pkglist">
                <li className={list.environmentReady ? "pkg done" : "pkg"}>
                  <span className="pkg-mark">
                    {list.environmentReady ? "\u2713" : busy === "environment" ? "\u2026" : ""}
                  </span>
                  <div className="pkg-body">
                    <strong>Python environment</strong>
                    <span className="pkg-note">
                      A private virtualenv for the engine, so none of this touches the Python
                      you already have.
                    </span>
                  </div>
                  {list.environmentReady ? (
                    <span className="pkg-state">ready</span>
                  ) : (
                    <button
                      className="btn ghost tiny"
                      disabled={working || !list.python}
                      onClick={() => run("environment", installEnvironment)}
                    >
                      {busy === "environment" ? "Working…" : "Prepare"}
                    </button>
                  )}
                </li>

                {list.packages.map((pkg) => (
                  <li key={pkg.requirement} className={pkg.installed ? "pkg done" : "pkg"}>
                    <span className="pkg-mark">
                      {pkg.installed ? "\u2713" : busy === pkg.requirement ? "\u2026" : ""}
                    </span>
                    <div className="pkg-body">
                      <strong>{pkg.name}</strong>
                      <span className="mono"> {pkg.requirement.slice(pkg.name.length)}</span>
                      {pkg.note && <span className="pkg-note">{pkg.note}</span>}
                    </div>
                    {pkg.installed ? (
                      <span className="pkg-state">installed</span>
                    ) : (
                      <button
                        className="btn ghost tiny"
                        disabled={working || blocked}
                        onClick={() => run(pkg.requirement, () => installPackage(pkg.requirement))}
                      >
                        {busy === pkg.requirement ? "Installing…" : "Install"}
                      </button>
                    )}
                  </li>
                ))}
              </ol>

              {options && (
                <>
                  <h3 className="sub-head">How it runs</h3>
                  <div className="chips">
                    {ENGINE_MODES.map((option) => (
                      <button
                        key={option.key}
                        className={options.mode === option.key ? "chip active" : "chip"}
                        disabled={!!switching}
                        onClick={() => chooseMode(option.key)}
                      >
                        {switching === option.key ? "Applying…" : option.label}
                      </button>
                    ))}
                  </div>
                  <p className="hint muted">
                    {ENGINE_MODES.find((option) => option.key === options.mode)?.blurb}
                  </p>
                  {memoryAdvice(options.memoryGb) && (
                    <p className="hint muted">{memoryAdvice(options.memoryGb)}</p>
                  )}
                  <p className="hint muted">
                    Changing this restarts the engine, which takes a few seconds.
                  </p>
                </>
              )}

              {ready ? (
                <>
                  <p className="hint note">
                    <strong>All libraries installed — the engine is ready.</strong> The first
                    time it speaks it downloads the voice model itself, about 5 GB, once.
                  </p>
                  <div className="setup-row">
                    <button className="btn primary" onClick={onStart} disabled={starting}>
                      {starting ? "Starting…" : "Start the engine"}
                    </button>
                    {state.installed && (
                      <button className="btn ghost" onClick={onSkip} disabled={starting}>
                        Back
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="setup-row">
                  <button
                    className="btn primary"
                    onClick={() => run("", installEngine)}
                    disabled={working || blocked}
                  >
                    {busy === "" ? "Installing…" : `Install all (${remaining} left)`}
                  </button>
                  {state.installed && (
                    <button className="btn ghost" onClick={onSkip} disabled={working}>
                      Use it as it is
                    </button>
                  )}
                  <span className="hint muted">
                    {working
                      ? `${elapsedLabel(elapsed)} elapsed — keep this window open.`
                      : "voxcpm is the big one; the rest arrive with it and finish instantly."}
                  </span>
                </div>
              )}
            </>
          )}

          {failed && <div className="alert">{failed}</div>}

          {lines.length > 0 && (
            <pre className="setup-log" ref={logRef}>
              {lines.join("\n")}
            </pre>
          )}

          <p className="hint muted">
            Goes into <span className="mono">{state.venv}</span>. Your clips and designed voices
            live in <span className="mono">{state.data}</span>. Deleting those two folders undoes
            this step completely.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * How the engine may be run. Only matters on a machine where the model does
 * not fit inside the GPU allocator's ceiling — about 9 GB, which a 16 GB Mac
 * does not reach.
 */
const ENGINE_MODES = [
  {
    key: "auto",
    label: "Automatic",
    blurb:
      "Use the GPU when the model fits, and the CPU when it does not. The safe choice.",
  },
  {
    key: "cpu",
    label: "CPU only",
    blurb:
      "Never touch the GPU. Generating takes longer, but it always fits and never competes with anything else for GPU memory.",
  },
  {
    key: "gpu-unlimited",
    label: "GPU, ignore the limit",
    blurb:
      "Run on the GPU past its memory ceiling, letting the system swap to disk. Faster on a 16 GB Mac, but PyTorch warns it may make the machine unresponsive — if that happens, switch back.",
  },
];

/** What this machine means for the choice, rather than a guess. */
function memoryAdvice(gb: number): string {
  if (!gb) return "";
  if (gb >= 24) {
    return `This Mac has ${gb} GB — the model fits on the GPU, so Automatic will use it.`;
  }
  if (gb <= 16) {
    return `This Mac has ${gb} GB. The model needs about 9 GB and the GPU's own ceiling sits near that, so Automatic will run it on the CPU here.`;
  }
  return `This Mac has ${gb} GB, which is borderline: Automatic will use the GPU if the model fits and fall back if it does not.`;
}

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default App;
