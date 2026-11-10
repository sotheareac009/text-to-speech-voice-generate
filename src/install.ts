// The engine's lifecycle on the Rust side: whether it is installed, installing
// it, starting it. Separate from engine.ts, which is the HTTP client for an
// engine that is already running.
//
// The engine is not in the app bundle — it is ~4 GB of Python wheels, and the
// voice model it fetches afterwards is another ~5 GB. So a fresh install has a
// first run where the app is present but the engine is not, and this is how the
// UI finds that out and fixes it.
//
// Outside Tauri (`npm run dev` in a browser) none of this exists: there the
// engine is assumed to be running already, started from a terminal.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface EngineState {
  /** The virtualenv exists and has an interpreter. */
  installed: boolean;
  /** Something is already answering on the engine's port. */
  running: boolean;
  installing: boolean;
  /** Installed against older requirements than this build of the app ships. */
  stale: boolean;
  /** Host interpreter that would build the venv — null if none was found. */
  python: string | null;
  pythonVersion: string | null;
  /** Where the engine is (or would be) installed. */
  venv: string;
  /** Where generated audio and designed voices are kept. */
  data: string;
}

export interface InstallDone {
  ok: boolean;
  error: string;
  /** Which job finished: "" for the whole engine, "environment", or one requirement. */
  target: string;
}

/** One library the engine needs. */
export interface Package {
  /** The line as pip takes it, e.g. "voxcpm>=2.0.3". */
  requirement: string;
  /** The distribution name alone, e.g. "voxcpm". */
  name: string;
  /** Its comment block from requirements.txt, written for people. */
  note: string;
  installed: boolean;
}

export interface EnginePackages {
  /** The virtualenv exists, so libraries have somewhere to go. */
  environmentReady: boolean;
  python: string | null;
  pythonVersion: string | null;
  packages: Package[];
}

/** The library checklist, with what is already in place. */
export async function getEnginePackages(): Promise<EnginePackages> {
  return invoke<EnginePackages>("engine_packages");
}

/** Create just the virtualenv. */
export async function installEnvironment(): Promise<void> {
  await invoke("install_environment");
}

/** Install one library. `requirement` must be a line from the engine's own list. */
export async function installPackage(requirement: string): Promise<void> {
  await invoke("install_package", { requirement });
}

/** Null in a plain browser, where there is no Rust side to ask. */
export async function getEngineState(): Promise<EngineState | null> {
  if (!isTauri()) return null;
  return invoke<EngineState>("engine_state");
}

/**
 * Start building the engine. Returns as soon as the work is handed off — the
 * install takes minutes, so progress arrives through `onInstallLine` and the
 * outcome through `onInstallDone`.
 */
export async function installEngine(): Promise<void> {
  await invoke("install_engine");
}

/** Start the engine now. Resolves true if it is up. */
export async function startEngine(): Promise<boolean> {
  return invoke<boolean>("start_engine");
}

/** Each line pip (or venv) printed, carriage-return progress included. */
export function onInstallLine(handler: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>("engine-install", (event) => handler(event.payload));
}

export function onInstallDone(handler: (result: InstallDone) => void): Promise<UnlistenFn> {
  return listen<InstallDone>("engine-install-done", (event) => handler(event.payload));
}
