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
import { Block } from "./Block";
import Shorts from "./Shorts";
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
    button: "Telegram",
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

/**
 * One generated take, with enough around the clip to tell it apart from the
 * others: what was said, and which voice said it.
 *
 * The voice is stored by name rather than by key because history is a record
 * of what happened — renaming or deleting a cloned voice afterwards must not
 * silently rewrite which voice an earlier take was read in.
 */
interface Take {
  clip: Clip;
  /** The script as it was when this was generated. */
  text: string;
  /** The voice's label at the time. */
  voice: string;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * How many takes the list holds.
 *
 * Tied to `KEEP_RESULTS` in `server.py`, which deletes all but the newest 20
 * clips after each generation. Keeping more rows here than the engine keeps
 * files would fill the list with takes whose audio is gone.
 */
const HISTORY_LIMIT = 20;
const TAKES_KEY = "voice-studio-takes";

/** Takes from the last session, ignoring anything that is not one. */
function loadTakes(): Take[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TAKES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (t): t is Take =>
          !!t &&
          typeof t.clip?.id === "string" &&
          typeof t.clip?.url === "string" &&
          typeof t.clip?.durationSec === "number",
      )
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The four places in the app.
 *
 * Everything that is *decided once and left alone* — how the engine runs,
 * where files go, which theme — lives in Settings, so the screen you work on
 * holds only the things that change between one take and the next.
 */
type Page = "studio" | "voices" | "direction" | "shorts" | "settings";

const PAGES: { key: Page; label: string; title: string; blurb: string }[] = [
  {
    key: "studio",
    label: "Studio",
    title: "Studio",
    blurb: "Write the script, generate it, and take the result away as a file.",
  },
  {
    key: "voices",
    label: "Voices",
    title: "Voices",
    blurb: "The voice that reads your script — a built-in one, or cloned from a sample.",
  },
  {
    key: "direction",
    label: "Direction",
    title: "Direction & master",
    blurb: "How the line is performed, and how it is finished for delivery.",
  },
  {
    key: "shorts",
    label: "Shorts",
    title: "Faceless shorts",
    blurb:
      "An idea becomes a vertical video — Claude writes it, your voices read it, and it is rendered here.",
  },
  {
    key: "settings",
    label: "Settings",
    title: "Settings",
    blurb: "Appearance, how the engine runs, and where everything is kept.",
  },
];

type Theme = "system" | "light" | "dark";
const THEME_KEY = "voice-studio-theme";

function App() {
  const [page, setPage] = useState<Page>("studio");
  const [theme, setTheme, resolvedTheme] = useTheme();

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
  // Every take this session (and the last), newest first, with the one being
  // shown. A generate used to replace the result outright, which threw away a
  // take that may well have been the better one.
  const [takes, setTakes] = useState<Take[]>(loadTakes);
  const [selectedId, setSelectedId] = useState("");
  const checkedTakes = useRef(false);
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

  useEffect(() => {
    try {
      localStorage.setItem(TAKES_KEY, JSON.stringify(takes));
    } catch {
      /* blocked storage: history just won't survive a restart */
    }
  }, [takes]);

  // Clips restored from the last session may no longer be on disk — the engine
  // keeps only the newest 20, and someone else's engine may be answering on
  // the port. Ask it once, and quietly drop the rows it has lost, so a row in
  // this list always plays.
  //
  // Two rules this has to follow, both learned the hard way:
  //
  // * **Only a 404 counts as gone.** The first version asked with HEAD and
  //   dropped anything that was not `ok`. FastAPI registers `@app.get` for GET
  //   alone, so every HEAD came back 405 and the whole history deleted itself
  //   on the first check. A range request for one byte is answered by the same
  //   handler the player uses, and anything but a 404 means the clip is there.
  // * **It runs once the engine is ready, takes or not.** Guarding on
  //   `takes.length` instead left the check armed, so it fired at the *first
  //   generation of the session* and threw that take away. Takes made here are
  //   known to exist; only restored ones are ever in question.
  useEffect(() => {
    if (status !== "ready" || checkedTakes.current) return;
    checkedTakes.current = true;
    if (takes.length === 0) return;
    let active = true;
    (async () => {
      const alive = await Promise.all(
        takes.map(async (t) => {
          try {
            const res = await fetch(t.clip.url, { headers: { Range: "bytes=0-0" } });
            return res.status !== 404;
          } catch {
            // The engine not answering is not evidence that a clip is gone.
            return true;
          }
        }),
      );
      if (active && alive.some((ok) => !ok)) {
        setTakes((prev) => prev.filter((_, i) => alive[i] ?? true));
      }
    })();
    return () => {
      active = false;
    };
  }, [status, takes]);

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
    setShared("");
    setGenerating(true);
    // The previous take deliberately stays on screen while this one renders:
    // it is still playable, and a minute of empty space is not progress.
    try {
      // Mastering applies either way; only the performance direction is switched.
      const direction = tuning
        ? { ...tuning, style: tunerOn ? tuning.style : "" }
        : undefined;
      const made = await synthesize(mode === UPLOAD ? voiceId : mode, text, direction);
      setTakes((prev) =>
        [{ clip: made, text: text.trim(), voice: voiceLabel, at: Date.now() }, ...prev].slice(
          0,
          HISTORY_LIMIT,
        ),
      );
      setSelectedId(made.id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setGenerating(false);
    }
  }

  /** Show an earlier take. Its file is a different one, so the save and share
   *  notes from the last one no longer describe what is on screen. */
  function showTake(id: string) {
    setSelectedId(id);
    setSavedTo("");
    setShared("");
    setError("");
  }

  /** Drop a take from the list. The audio stays until the engine prunes it. */
  function forgetTake(id: string) {
    setTakes((prev) => prev.filter((t) => t.clip.id !== id));
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

  // What the Result block shows: the chosen take, or the newest one.
  const shown = takes.find((t) => t.clip.id === selectedId) ?? takes[0] ?? null;
  const clip = shown?.clip ?? null;

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

  // What the next Generate will use, in the words the picker uses for it.
  const voiceLabel =
    mode === UPLOAD
      ? voiceId
        ? voiceName || "Cloned voice"
        : "Not chosen yet"
      : chosen?.label ?? mode;
  const styleLabel = !tuning
    ? "—"
    : tunerOn
      ? catalog?.styles.find((s) => s.key === tuning.style)?.label ?? "—"
      : "Undirected";
  const masterLabel = tuning
    ? catalog?.mastering.find((m) => m.key === tuning.mastering)?.label ?? "—"
    : "—";

  // ── First run: nothing else is usable until the engine exists ───────────
  if (needsEngine && engine) {
    return (
      <div className="setup">
        <div className="setup-head">
          <span className="brand-mark">
            <Mark />
          </span>
          <div>
            <h1>Voice Studio</h1>
            <p>
              {engine.installed
                ? "The engine's libraries have changed since this one was installed."
                : "One step before you can use it: the voice engine lives on this machine."}
            </p>
          </div>
        </div>
        <SetupCard
          state={engine}
          onInstalled={onEngineInstalled}
          onSkip={() => {
            setSkipUpdate(true);
            setForceSetup(false);
          }}
        />
      </div>
    );
  }

  const current = PAGES.find((p) => p.key === page) ?? PAGES[0];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Mark />
          </span>
          <span className="brand-text">
            <strong>Voice Studio</strong>
            <span>30 languages, on this Mac</span>
          </span>
        </div>

        <nav className="nav-list">
          {PAGES.map((p) => (
            <button
              key={p.key}
              className={p.key === page ? "nav active" : "nav"}
              onClick={() => setPage(p.key)}
              title={p.blurb}
            >
              <Icon name={p.key} />
              <span>{p.label}</span>
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <EngineBadge status={status} health={health} />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-text">
            <h1>{current.title}</h1>
            <p>{current.blurb}</p>
          </div>
          <div className="topbar-side">
            <button
              className="icon-btn"
              title={resolvedTheme === "dark" ? "Switch to day" : "Switch to night"}
              aria-label="Switch theme"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              <Icon name={resolvedTheme === "dark" ? "sun" : "moon"} />
            </button>
          </div>
        </header>

        <div className="page">
          {error && <div className="alert">{error}</div>}

          {/* ── Studio ─────────────────────────────────────────────────── */}
          {page === "studio" && (
            <>
              {status === "error" && health?.detail && (
                <div className="alert">The engine could not start: {health.detail}</div>
              )}
              {status !== "error" && health?.detail && (
                <p className="note">{health.detail}</p>
              )}

              {unreachable && engine?.installed && (
                <Block
                  title="The engine isn't answering"
                  note={
                    "It is installed, but nothing is responding on port 8008. Usually that " +
                    "means it could not start — most often because the Python it was built " +
                    "against was upgraded or removed since, which breaks the virtualenv's " +
                    "link to it."
                  }
                >
                  <div className="setup-row" style={{ marginTop: 0 }}>
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
                </Block>
              )}

              <Block
                title="Script"
                note="Numbers and dates in Khmer are spoken correctly, and long text is split into sentences so the voice stays steady."
              >
                <div className="summary">
                  <button
                    className={voiceReady ? "sum" : "sum unset"}
                    onClick={() => setPage("voices")}
                  >
                    <span>Voice</span>
                    <strong>{voiceLabel}</strong>
                  </button>
                  <button className="sum" onClick={() => setPage("direction")}>
                    <span>Read</span>
                    <strong>{styleLabel}</strong>
                  </button>
                  <button className="sum" onClick={() => setPage("direction")}>
                    <span>Master</span>
                    <strong>{masterLabel}</strong>
                  </button>
                </div>

                <textarea
                  className="script"
                  style={{ marginTop: 14 }}
                  placeholder="សរសេរអត្ថបទនៅទីនេះ… / Type your ad copy here…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />

                {mode === UPLOAD && !voiceId && (
                  <p className="hint muted">
                    No cloned voice yet —{" "}
                    <button className="linkish" onClick={() => setPage("voices")}>
                      add a sample
                    </button>{" "}
                    or pick a built-in voice.
                  </p>
                )}
              </Block>

              <div className="block-foot standalone">
                <span className="count">{text.trim().length} characters</span>
                <button className="btn primary" onClick={onGenerate} disabled={!canGenerate}>
                  {generating ? `Generating… ${genElapsed}s` : "Generate speech"}
                </button>
              </div>

              {clip && shown && (
                <Block
                  title="Result"
                  // Only when an earlier take is showing: for the newest one
                  // the script is still in the box above, word for word.
                  note={shown !== takes[0] ? shown.text || undefined : undefined}
                  aside={
                    takes.length > 1 && shown !== takes[0] ? (
                      <button
                        className="btn ghost tiny"
                        onClick={() => showTake(takes[0].clip.id)}
                      >
                        Back to newest
                      </button>
                    ) : undefined
                  }
                >
                  {/* `key` forces a fresh element per clip so the player reloads
                      instead of holding on to the previous source. */}
                  <audio className="player" key={clip.url} controls src={clip.url} />
                  <ClipStats clip={clip} catalog={catalog} />

                  <div className="actions">
                    <button className="btn ghost" onClick={() => onSave()} disabled={busy}>
                      {saving === "wav" ? "Saving…" : "Save WAV…"}
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => onSave("telegram")}
                      disabled={busy}
                      title={
                        "Save the Telegram voice file itself: OGG/Opus, mono, 32 kbps — the " +
                        "same encoding Telegram's own recorder sends. Attached as a file it " +
                        "arrives as an audio message; the waveform bubble needs Telegram's " +
                        "mic or a bot."
                      }
                    >
                      {saving === "telegram" ? "Encoding…" : "Save voice message…"}
                    </button>
                    <span className="sep" />
                    {SHARE_ORDER.map((key) => (
                      <button
                        key={key}
                        className="btn ghost"
                        onClick={() => onShare(key)}
                        disabled={busy}
                        title={SHARE[key].hint}
                      >
                        {sharing === key ? "Encoding…" : `Send to ${SHARE[key].button}`}
                      </button>
                    ))}
                  </div>

                  {(shared || savedTo) && (
                    <p className="action-note">{shared || `Saved to ${savedTo}`}</p>
                  )}
                  {clip.instruction && (
                    <p className="hint muted mono">Read as {clip.instruction}</p>
                  )}
                </Block>
              )}

              {takes.length > 1 && (
                <Block
                  title="History"
                  note={`The last ${HISTORY_LIMIT} takes, kept between sessions. Click one to bring it back into the player — it can be saved and sent like any other.`}
                  aside={
                    <button
                      className="btn ghost tiny"
                      // Keeps whatever is in the player: that one is not
                      // history, it is what you are working on, and clearing
                      // a list should never take the result off the screen.
                      onClick={() => setTakes(shown ? [shown] : [])}
                      title="Remove the other takes. The one in the player stays."
                    >
                      Clear the rest
                    </button>
                  }
                >
                  <div className="takes">
                    {takes.map((t) => (
                      <div
                        key={t.clip.id}
                        className={t.clip.id === clip.id ? "take active" : "take"}
                      >
                        <button className="take-main" onClick={() => showTake(t.clip.id)}>
                          <span className="take-text">{t.text || "(no script)"}</span>
                          <span className="take-meta">
                            {whenLabel(t.at)} · {t.voice} · {t.clip.durationSec.toFixed(1)}s
                          </span>
                        </button>
                        <button
                          className="take-drop"
                          title="Remove from the list"
                          aria-label="Remove from the list"
                          onClick={() => forgetTake(t.clip.id)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </Block>
              )}
            </>
          )}

          {/* ── Voices ─────────────────────────────────────────────────── */}
          {page === "voices" && (
            <>
              <Block
                title="Choose a voice"
                note="Built-in voices are designed by the engine and need nothing from you. Cloned ones you have saved appear here too."
              >
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
                  <button
                    className={mode === UPLOAD ? "seg active" : "seg"}
                    onClick={() => setMode(UPLOAD)}
                  >
                    Clone a new one
                  </button>
                </div>

                {mode !== UPLOAD && (
                  <>
                    {/* A list rather than a dropdown: with seven male
                        characters, the difference between them is the whole
                        decision, and a <select> hides six of them behind a
                        click and shows no description at all. */}
                    <div className="voice-list" role="radiogroup">
                      {variants.map((v) => (
                        <button
                          key={v.key}
                          role="radio"
                          aria-checked={v.key === mode}
                          className={v.key === mode ? "voice active" : "voice"}
                          onClick={() => pickVariant(v.key)}
                        >
                          <span className="voice-dot" />
                          <span className="voice-text">
                            <strong>{v.variant}</strong>
                            <span>{v.blurb || "Built-in voice — nothing to set up."}</span>
                          </span>
                        </button>
                      ))}
                    </div>

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
                          className="btn danger tiny"
                          onClick={() => onForgetVoice(chosen.key)}
                        >
                          Delete voice
                        </button>
                      </div>
                    )}
                  </>
                )}
              </Block>

              {mode === UPLOAD && (
                <Block
                  title="Clone from a sample"
                  note="Upload 20–30 seconds of one person speaking clearly. Music and background noise are stripped out automatically, and the cleaned voice is saved so it is here next time. Only clone a voice you have permission to use."
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept="audio/*"
                    hidden
                    onChange={(e) => onPickFile(e.target.files?.[0])}
                  />
                  <div className="sample-row">
                    <button
                      className="btn ghost"
                      onClick={() => fileRef.current?.click()}
                      disabled={cloning}
                    >
                      Choose audio…
                    </button>
                    <span className={voiceId && !cloning ? "sample-name ok" : "sample-name"}>
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
                </Block>
              )}
            </>
          )}

          {/* ── Direction & master ─────────────────────────────────────── */}
          {page === "direction" && (
            <>
              {catalog && tuning ? (
                <Tuner
                  catalog={catalog}
                  tuning={tuning}
                  directed={tunerOn}
                  onDirected={setTunerOn}
                  onChange={setTuning}
                />
              ) : (
                <Block title="Direction">
                  <p className="hint muted">
                    The presets come from the engine. They will appear here once it has
                    finished starting.
                  </p>
                </Block>
              )}
            </>
          )}

          {/* ── Shorts ─────────────────────────────────────────────────── */}
          {page === "shorts" && <Shorts />}

          {/* ── Settings ───────────────────────────────────────────────── */}
          {page === "settings" && (
            <>
              <Block
                title="Appearance"
                note="Night is the default. System follows the Mac's own appearance, including the automatic switch at sunset."
              >
                <div className="segmented accent" role="tablist">
                  {(["system", "light", "dark"] as Theme[]).map((t) => (
                    <button
                      key={t}
                      className={theme === t ? "seg active" : "seg"}
                      onClick={() => setTheme(t)}
                    >
                      {t === "system" ? "System" : t === "light" ? "Day" : "Night"}
                    </button>
                  ))}
                </div>
              </Block>

              <Block
                title="Engine"
                note="The voice model runs here, on this machine. Nothing you type or generate leaves it."
                aside={<EngineBadge status={status} health={health} />}
              >
                <RunMode />
                <div className="setup-row">
                  {engine?.installed && (
                    <button className="btn ghost" onClick={() => setForceSetup(true)}>
                      Engine libraries…
                    </button>
                  )}
                  <button className="btn ghost" onClick={onRetryStart}>
                    Restart the engine
                  </button>
                </div>
                {health?.model && (
                  <p className="hint muted mono">Model: {health.model}</p>
                )}
              </Block>

              {engine && (
                <Block
                  title="Where things live"
                  note="Deleting these two folders undoes the install completely — the app itself keeps nothing else."
                >
                  <div className="paths">
                    <div>
                      <span>Engine</span>
                      <p className="mono">{engine.venv}</p>
                    </div>
                    <div>
                      <span>Clips, voices and logs</span>
                      <p className="mono">{engine.data}</p>
                    </div>
                  </div>
                </Block>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Pieces                                                                    */
/* ========================================================================== */

/**
 * Day or night, and which one "system" currently means.
 *
 * The attribute is written straight onto <html> rather than held in React,
 * because index.html sets it before the first paint to avoid a white flash —
 * so the DOM, not a state variable, is the one source of truth for it.
 */
function useTheme(): [Theme, (t: Theme) => void, "light" | "dark"] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch {
      return "system";
    }
  });
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = next;
      setResolved(next);
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* blocked storage: the choice just won't survive a restart */
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return [theme, setTheme, resolved];
}

/** The mark in the corner: four bars, the shape of a level meter. */
function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
      <path d="M5 10v4M9.6 6.5v11M14.4 8.6v6.8M19 10.6v2.8" />
    </svg>
  );
}

function Icon({ name }: { name: Page | "sun" | "moon" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "studio":
      return (
        <svg {...common}>
          <path d="M4 10v4M8 7.5v9M12 4.5v15M16 8v8M20 11v2" />
        </svg>
      );
    case "voices":
      return (
        <svg {...common}>
          <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      );
    case "direction":
      return (
        <svg {...common}>
          <path d="M4 7h9M18.5 7H20M4 17h3.5M12.5 17H20" />
          <circle cx="15.5" cy="7" r="2.3" />
          <circle cx="10" cy="17" r="2.3" />
        </svg>
      );
    case "shorts":
      return (
        <svg {...common}>
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
          <path d="M10.6 9.3 14.8 12l-4.2 2.7z" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2.9v2.3M12 18.8v2.3M21.1 12h-2.3M5.2 12H2.9M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6" />
        </svg>
      );
    case "sun":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" />
        </svg>
      );
    case "moon":
      return (
        <svg {...common}>
          <path d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z" />
        </svg>
      );
  }
}

/** The sliders. Picking a style snaps the rest to that style's own settings. */
function Tuner({
  catalog,
  tuning,
  directed,
  onDirected,
  onChange,
}: {
  catalog: TunerCatalog;
  tuning: Tuning;
  /** Whether the performance direction applies. Mastering always does. */
  directed: boolean;
  onDirected: (on: boolean) => void;
  onChange: (t: Tuning) => void;
}) {
  const style = catalog.styles.find((s) => s.key === tuning.style);
  const mastering = catalog.mastering.find((m) => m.key === tuning.mastering);

  const pace = (
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
  );

  return (
    <>
      <Block
        title="Direction"
        note="The direction performs your copy like an advert. Turn it off and the model reads the line its own way — still cleaned and mastered."
        aside={
          <label className="switch">
            <input
              type="checkbox"
              checked={directed}
              onChange={(e) => onDirected(e.target.checked)}
            />
            <span>Direct the read</span>
          </label>
        }
      >
        {directed ? (
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
              {pace}
            </div>

            <p className="hint muted mono">{previewInstruction(catalog, tuning)}</p>
          </>
        ) : (
          <>
            <div className="knobs" style={{ marginTop: 0 }}>
              {/* Pace stays available undirected because it is the one control
                  that still means something with no style attached: slowing a
                  read down is not the same as making it sound like an advert. */}
              {pace}
            </div>
            <p className="hint muted">
              {tuning.pace === "natural"
                ? "Pace sets the pause between sentences."
                : tuning.pace === "fast"
                  ? "Fast shortens the pauses and speeds the read by roughly 8%. On a cloned voice it trades a little steadiness — set it back to Natural if the voice wanders."
                  : "Slow widens the pause between sentences. It does not slow the speaking rate itself: the model does not reliably obey that in Khmer."}
            </p>
          </>
        )}
      </Block>

      <Block
        title="Master"
        note="Cleans and opens out the voice and brings it to a fixed loudness, so it sits right next to music. This runs whether or not the read is directed."
      >
        <label className="field narrow" style={{ marginTop: 0 }}>
          <span>Finish</span>
          <span className="select-wrap">
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
          </span>
        </label>
        {mastering && <p className="hint muted">{mastering.blurb}</p>}
      </Block>
    </>
  );
}

/** What the engine actually delivered — the numbers that matter for an ad. */
function ClipStats({ clip, catalog }: { clip: Clip; catalog: TunerCatalog | null }) {
  const style = catalog?.styles.find((s) => s.key === clip.style);
  const master = catalog?.mastering.find((m) => m.key === clip.mastering);
  const facts: [string, string][] = [
    ["Length", `${clip.durationSec.toFixed(1)}s`],
    ["Rendered", renderCost(clip) ?? "—"],
    ["Loudness", clip.lufs === null ? "silent" : `${clip.lufs.toFixed(1)} LUFS`],
    ["True peak", clip.peakDb === null ? "—" : `${clip.peakDb.toFixed(1)} dBTP`],
    ["Read", style?.label ?? "Undirected"],
    ["Master", master?.label ?? "—"],
  ];
  return (
    <div className="stats">
      {facts.map(([key, value]) => (
        <div className="stat" key={key}>
          <span>{key}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
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
  return where ? `${time} · ${where}` : time;
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

/** When a take was made: the time, plus the date once it is not today. */
function whenLabel(at: number): string {
  const made = new Date(at);
  const time = made.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay =
    made.getFullYear() === today.getFullYear() &&
    made.getMonth() === today.getMonth() &&
    made.getDate() === today.getDate();
  return sameDay ? time : `${made.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
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
 * Where the model is allowed to run. Lives in Settings *and* in first-run
 * setup, because it is the one choice that can decide whether the engine works
 * at all on a 16 GB machine — and the setup screen is where someone is when
 * they first find that out.
 */
function RunMode() {
  const [options, setOptions] = useState<EngineOptions | null>(null);
  const [switching, setSwitching] = useState("");
  const [failed, setFailed] = useState("");

  const refresh = useCallback(async () => {
    try {
      setOptions(await getEngineOptions());
    } catch {
      /* the chooser is optional — hide it rather than block anything */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function choose(mode: string) {
    if (!options || options.mode === mode || switching) return;
    setFailed("");
    setSwitching(mode);
    try {
      await setEngineMode(mode);
    } catch (e) {
      setFailed(messageOf(e));
    } finally {
      await refresh();
      setSwitching("");
    }
  }

  if (!options) return null;
  return (
    <>
      <h3 className="sub-head" style={{ marginTop: 0 }}>
        How it runs
      </h3>
      <div className="chips" style={{ marginTop: 10 }}>
        {ENGINE_MODES.map((option) => (
          <button
            key={option.key}
            className={options.mode === option.key ? "chip active" : "chip"}
            disabled={!!switching}
            onClick={() => choose(option.key)}
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
      <p className="hint muted">Changing this restarts the engine, which takes a few seconds.</p>
      {failed && <div className="alert">{failed}</div>}
    </>
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
    <Block
      title={ready ? "Engine libraries" : "Install the engine's libraries"}
      note={
        "These are the libraries the engine runs on. They are installed here rather than " +
        "shipped inside the app because together they come to about 420 MB to download and " +
        "roughly 2 GB on disk. Install them one at a time, or all at once. You need " +
        "Python 3.10–3.13 and around 10 GB free."
      }
    >
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
                {list.environmentReady ? "✓" : busy === "environment" ? "…" : ""}
              </span>
              <div className="pkg-body">
                <strong>Python environment</strong>
                <span className="pkg-note">
                  A private virtualenv for the engine, so none of this touches the Python you
                  already have.
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
                  {pkg.installed ? "✓" : busy === pkg.requirement ? "…" : ""}
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

          <RunMode />

          {ready ? (
            <>
              <p className="note" style={{ marginTop: 16 }}>
                <strong>All libraries installed — the engine is ready.</strong> The first time
                it speaks it downloads the voice model itself, about 5 GB, once.
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
    </Block>
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
