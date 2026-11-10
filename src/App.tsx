import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  fetchClip,
  getHealth,
  getTuner,
  registerVoice,
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
  onInstallDone,
  onInstallLine,
  startEngine,
  type EngineState,
  type EnginePackages,
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
  const fileRef = useRef<HTMLInputElement>(null);

  // Commercial tuner. `catalog` comes from the engine, so the presets live in
  // one place; `tuning` is null until it loads.
  const [catalog, setCatalog] = useState<TunerCatalog | null>(null);
  const [tunerOn, setTunerOn] = useState(true);
  const [tuning, setTuning] = useState<Tuning | null>(null);

  const [text, setText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTo, setSavedTo] = useState("");
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
    try {
      setVoiceId(await registerVoice(file, text));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setCloning(false);
    }
  }

  function onPickFile(file: File | undefined) {
    if (!file) return;
    setVoiceId("");
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
   * Save a copy of the clip. In the app this goes through a native save dialog
   * on the Rust side — WKWebView ignores `<a download>`, so the plain anchor
   * this used to be did nothing at all. In a browser (`npm run dev`) the
   * anchor still works, so fall back to it there.
   */
  async function onSave() {
    if (!clip) return;
    setError("");
    setSavedTo("");
    setSaving(true);
    try {
      if (isTauri()) {
        const dest = await invoke<string | null>("save_audio", { audioId: clip.id });
        if (dest) setSavedTo(dest);
      } else {
        const href = URL.createObjectURL(await fetchClip(clip));
        const link = document.createElement("a");
        link.href = href;
        link.download = "speech.wav";
        link.click();
        // Revoking straight away cancels the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
        setSavedTo("Downloads");
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

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

      {status === "loading" && health?.detail && (
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
              </>
            ) : (
              <>
                <p className="hint">
                  Upload <strong>20–30 seconds</strong> of one person speaking clearly — no music or
                  background noise. Only clone a voice you have permission to use.
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
                      ? "Saving sample…"
                      : voiceId
                        ? `✓ ${sampleName} — voice ready`
                        : sampleName || "No file selected"}
                  </span>
                </div>

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
                {generating ? "Generating…" : "Generate speech"}
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
            <button className="btn ghost" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save WAV…"}
            </button>
            <span className="hint muted">
              {savedTo ? `Saved to ${savedTo}` : <ClipFacts clip={clip} catalog={catalog} />}
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
    style ? style.label : "undirected read",
    master?.label ?? null,
    clip.lufs === null ? "silent" : `${clip.lufs.toFixed(1)} LUFS`,
    clip.peakDb === null ? null : `peak ${clip.peakDb.toFixed(1)} dBTP`,
  ];
  return <>{facts.filter(Boolean).join(" · ")}</>;
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

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default App;
