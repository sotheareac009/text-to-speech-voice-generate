// The Tauri (Rust) shell. Its job is the lifecycle of the local Python voice
// engine: find it, install it on first run, start it, stop it on exit. All
// text-to-speech work happens in Python; the React UI talks to it over
// http://127.0.0.1:8008 directly.
//
// Why the engine is installed rather than bundled: it is VoxCPM2 on torch —
// about 420 MB of wheels that unpack to roughly 2 GB, with a 402 MB
// libtorch_cpu.dylib inside. Shipping that in the .app would make an absurd
// download, and the model weights (another ~5 GB) are fetched by Hugging Face
// at first use anyway. So the bundle carries
// only the Python sources, and `install_engine` builds the virtualenv on the
// user's machine, into a directory the user can actually write to.

use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8008;

/// Holds the running Python engine process so we can kill it on exit.
struct Engine(Mutex<Option<Child>>);

/// True while an install is in flight, so a second click can't start another.
struct Installing(Mutex<bool>);

/// Base URL the frontend should call. Kept here so there's a single source of truth.
#[tauri::command]
fn engine_base_url() -> String {
    format!("http://{HOST}:{PORT}")
}

// ──────────────────────────────── layout ─────────────────────────────────

/// Where everything lives. The split matters: `src` is read-only inside the
/// installed .app, so nothing may be written there — the virtualenv and the
/// generated audio both go under Application Support instead.
struct Layout {
    /// server.py and its siblings.
    src: PathBuf,
    /// The engine's virtualenv.
    venv: PathBuf,
    /// Designed voices, uploaded samples and generated clips.
    data: PathBuf,
    /// Records which requirements the venv was built from.
    marker: PathBuf,
}

impl Layout {
    fn python(&self) -> PathBuf {
        self.venv.join("bin").join("python")
    }
    fn requirements(&self) -> PathBuf {
        self.src.join("requirements.txt")
    }
    /// Installed means a venv interpreter we can actually run.
    fn installed(&self) -> bool {
        self.python().exists()
    }
    /// Built against different requirements than the app now ships.
    fn stale(&self) -> bool {
        let Ok(marker) = std::fs::read_to_string(&self.marker) else {
            return false; // no marker (a dev venv, say) — nothing to compare
        };
        let recorded = serde_json::from_str::<serde_json::Value>(&marker)
            .ok()
            .and_then(|v| v["requirements"].as_str().map(str::to_owned));
        match (recorded, std::fs::read_to_string(self.requirements()).ok()) {
            (Some(was), Some(now)) => was.trim() != now.trim(),
            _ => false,
        }
    }
}

fn layout(app: &AppHandle) -> Layout {
    #[cfg(debug_assertions)]
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("python");

    #[cfg(not(debug_assertions))]
    let src = app
        .path()
        .resource_dir()
        .expect("resource dir")
        .join("python");

    let home = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("voice-studio"));
    let engine = home.join("engine");

    // In development the repo's own venv *is* the engine, so `npm run tauri dev`
    // keeps using whatever is already installed there instead of asking the
    // developer to install a second copy.
    #[cfg(debug_assertions)]
    let venv = [".venv-voxcpm", ".venv"]
        .iter()
        .map(|name| src.join(name))
        .find(|dir| dir.join("bin").join("python").exists())
        .unwrap_or_else(|| engine.join("venv"));

    #[cfg(not(debug_assertions))]
    let venv = engine.join("venv");

    #[cfg(debug_assertions)]
    let data = src.join("data");

    #[cfg(not(debug_assertions))]
    let data = home.join("data");

    Layout {
        src,
        venv,
        data,
        marker: engine.join("installed.json"),
    }
}

// ───────────────────────── finding a host Python ──────────────────────────

/// Interpreters to try, best first.
///
/// An app launched from Finder inherits a bare PATH, so a Homebrew
/// `python3.11` is invisible to a plain `Command::new("python3")`. Probe the
/// real install locations by absolute path instead.
fn candidate_pythons() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // 3.11 first because that is what this engine is tested on; torch publishes
    // macOS wheels for 3.10 through 3.13.
    for version in ["3.11", "3.12", "3.13", "3.10"] {
        out.push(PathBuf::from(format!("/opt/homebrew/bin/python{version}")));
        out.push(PathBuf::from(format!("/usr/local/bin/python{version}")));
        out.push(PathBuf::from(format!(
            "/Library/Frameworks/Python.framework/Versions/{version}/bin/python{version}"
        )));
        out.push(PathBuf::from(format!("python{version}"))); // whatever PATH has
    }
    out.push(PathBuf::from("/opt/homebrew/bin/python3"));
    out.push(PathBuf::from("/usr/local/bin/python3"));
    out.push(PathBuf::from("python3"));
    // /usr/bin/python3 is a Command Line Tools stub: running it when the tools
    // are absent pops a system dialog, so only consider it when they're there.
    if Path::new("/Library/Developer/CommandLineTools/usr/bin/python3").exists() {
        out.push(PathBuf::from("/usr/bin/python3"));
    }
    out
}

/// The first candidate that runs and is new enough, with its version.
fn find_python() -> Option<(PathBuf, String)> {
    for path in candidate_pythons() {
        // A bare name has to go through PATH; an absolute path we can pre-check.
        if path.is_absolute() && !path.exists() {
            continue;
        }
        let Ok(out) = Command::new(&path)
            .args(["-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"])
            .env_remove("PYTHONHOME")
            .env_remove("PYTHONPATH")
            .env_remove("VIRTUAL_ENV")
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let version = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let mut parts = version.split('.');
        let major = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
        if major == 3 && (10..=13).contains(&minor) {
            return Some((path, version));
        }
    }
    None
}

// ──────────────────────────── engine state ───────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineState {
    /// The virtualenv exists and has an interpreter.
    installed: bool,
    /// Something is already answering on the engine's port.
    running: bool,
    installing: bool,
    /// Built against older requirements than this app ships.
    stale: bool,
    /// Host interpreter that would build the venv, if one was found.
    python: Option<String>,
    python_version: Option<String>,
    venv: String,
    data: String,
}

/// Is anything serving on the engine's port? Used to avoid starting a second
/// copy — two processes cannot bind the same port, and the loser dies noisily.
fn engine_already_up() -> bool {
    let Ok(addr) = format!("{HOST}:{PORT}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

#[tauri::command]
fn engine_state(app: AppHandle, installing: State<Installing>) -> EngineState {
    let layout = layout(&app);
    let found = if layout.installed() { None } else { find_python() };
    EngineState {
        installed: layout.installed(),
        running: engine_already_up(),
        installing: *installing.0.lock().unwrap(),
        stale: layout.stale(),
        python: found
            .as_ref()
            .map(|(path, _)| path.to_string_lossy().into_owned()),
        python_version: found.as_ref().map(|(_, version)| version.clone()),
        venv: layout.venv.to_string_lossy().into_owned(),
        data: layout.data.to_string_lossy().into_owned(),
    }
}

// ────────────────────────────── installing ───────────────────────────────

#[derive(Serialize, Clone)]
struct InstallDone {
    ok: bool,
    error: String,
    /// Which job finished: "" for the whole engine, "environment", or a single
    /// requirement line. Lets the UI update just the row that was running.
    target: String,
}

/// One library the engine needs, as the setup list shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    /// The line exactly as pip takes it, e.g. "voxcpm>=2.0.3".
    requirement: String,
    /// The distribution name alone, e.g. "voxcpm".
    name: String,
    /// The comment block above it in requirements.txt. Those comments are
    /// already written for people, so the UI explains each library from them
    /// rather than keeping a second copy that can drift.
    note: String,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnginePackages {
    /// The virtualenv exists, so libraries can be installed into it.
    environment_ready: bool,
    /// The host interpreter that would build it, when it does not exist yet.
    python: Option<String>,
    python_version: Option<String>,
    packages: Vec<Package>,
}

/// pip's name for a requirement line: everything before any version specifier.
fn requirement_name(line: &str) -> String {
    line.split(|c: char| "<>=!~;[ \t".contains(c))
        .next()
        .unwrap_or(line)
        .trim()
        .to_owned()
}

/// requirements.txt as rows, each carrying the comment block above it.
///
/// A comment block describes the group beneath it, so it stays attached across
/// consecutive requirements and is dropped at a blank line.
fn parse_requirements(text: &str) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    let mut note: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            note.clear();
        } else if let Some(comment) = line.strip_prefix('#') {
            note.push(comment.trim().to_owned());
        } else {
            rows.push((line.to_owned(), note.join(" ")));
        }
    }
    rows
}

/// pip reports names with either hyphens or underscores, and in any case.
fn normalise_dist(name: &str) -> String {
    name.trim().to_lowercase().replace('_', "-")
}

/// What the virtualenv already has.
fn installed_distributions(python: &Path) -> std::collections::HashSet<String> {
    let mut found = std::collections::HashSet::new();
    let Ok(out) = Command::new(python)
        .args(["-m", "pip", "list", "--format=json"])
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("VIRTUAL_ENV")
        .output()
    else {
        return found;
    };
    if !out.status.success() {
        return found;
    }
    if let Ok(list) = serde_json::from_slice::<Vec<serde_json::Value>>(&out.stdout) {
        for item in list {
            if let Some(name) = item["name"].as_str() {
                found.insert(normalise_dist(name));
            }
        }
    }
    found
}

/// The libraries the engine needs and which are already in place.
#[tauri::command]
fn engine_packages(app: AppHandle) -> Result<EnginePackages, String> {
    let layout = layout(&app);
    let path = layout.requirements();
    let text = std::fs::read_to_string(&path).map_err(|err| {
        format!(
            "Could not read the engine's requirements ({}): {err}",
            path.display()
        )
    })?;

    let ready = layout.installed();
    let have = if ready {
        installed_distributions(&layout.python())
    } else {
        std::collections::HashSet::new()
    };
    let host = if ready { None } else { find_python() };

    Ok(EnginePackages {
        environment_ready: ready,
        python: host
            .as_ref()
            .map(|(path, _)| path.to_string_lossy().into_owned()),
        python_version: host.as_ref().map(|(_, version)| version.clone()),
        packages: parse_requirements(&text)
            .into_iter()
            .map(|(requirement, note)| {
                let name = requirement_name(&requirement);
                Package {
                    installed: have.contains(&normalise_dist(&name)),
                    requirement,
                    name,
                    note,
                }
            })
            .collect(),
    })
}

/// Is every listed requirement in place?
fn all_installed(layout: &Layout) -> bool {
    if !layout.installed() {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(layout.requirements()) else {
        return false;
    };
    let have = installed_distributions(&layout.python());
    parse_requirements(&text)
        .iter()
        .all(|(req, _)| have.contains(&normalise_dist(&requirement_name(req))))
}

fn say(app: &AppHandle, line: &str) {
    println!("[install] {line}");
    let _ = app.emit("engine-install", line);
}

/// Forward a child's output as `engine-install` events, line by line.
///
/// Split on carriage returns as well as newlines: pip draws its download
/// progress with `\r`, and for a 2.5 GB torch wheel that bar is the only sign
/// of life for several minutes. Those redraws are throttled — thousands of
/// them would be thousands of IPC messages — while real log lines always go.
fn pump<R: Read>(app: &AppHandle, mut reader: R) {
    let mut chunk = [0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    let mut last_redraw = Instant::now() - Duration::from_secs(1);
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &byte in &chunk[..n] {
                    match byte {
                        b'\n' => flush(app, &mut line, false, &mut last_redraw),
                        b'\r' => flush(app, &mut line, true, &mut last_redraw),
                        _ => line.push(byte),
                    }
                }
            }
        }
    }
    flush(app, &mut line, false, &mut last_redraw);
}

fn flush(app: &AppHandle, line: &mut Vec<u8>, redraw: bool, last_redraw: &mut Instant) {
    let text = String::from_utf8_lossy(line).trim().to_owned();
    line.clear();
    if text.is_empty() {
        return;
    }
    if redraw {
        if last_redraw.elapsed() < Duration::from_millis(150) {
            return;
        }
        *last_redraw = Instant::now();
    }
    say(app, &text);
}

/// Run one install step, streaming its output, and fail loudly if it fails.
fn run_step(app: &AppHandle, label: &str, command: &mut Command) -> Result<(), String> {
    say(app, &format!("▸ {label}"));
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Never let an ambient virtualenv leak into the one being built.
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("VIRTUAL_ENV")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .spawn()
        .map_err(|err| format!("{label}: could not start ({err})"))?;

    let out = child.stdout.take();
    let err = child.stderr.take();
    let handle = app.clone();
    let reader = out.map(|out| std::thread::spawn(move || pump(&handle, out)));
    if let Some(err) = err {
        pump(app, err);
    }
    if let Some(reader) = reader {
        let _ = reader.join();
    }

    let status = child
        .wait()
        .map_err(|err| format!("{label}: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label} failed ({}). The log above says why.",
            status
                .code()
                .map(|c| format!("exit {c}"))
                .unwrap_or_else(|| "killed".into())
        ))
    }
}

/// Build the virtualenv. `start_after` runs the engine when it finishes —
/// wanted from the UI, not from the headless path, which would orphan it.
/// Create the virtualenv, if it isn't there, and bring its pip up to date.
fn ensure_environment(app: &AppHandle, layout: &Layout) -> Result<(), String> {
    let requirements = layout.requirements();
    if !requirements.exists() {
        return Err(format!(
            "The app is missing its engine sources ({}). The download may be incomplete.",
            requirements.display()
        ));
    }
    std::fs::create_dir_all(&layout.data)
        .map_err(|err| format!("{}: {err}", layout.data.display()))?;
    if let Some(parent) = layout.venv.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
    }

    if layout.installed() {
        say(app, "The engine environment is already in place.");
        return Ok(());
    }

    // A venv without an interpreter is a failed or interrupted install, so
    // --clear is safe here: there is nothing usable to throw away.
    let (python, version) = find_python().ok_or_else(|| {
        "No Python 3.10-3.13 found. Install Python 3.11 (brew install python@3.11, \
         or python.org/downloads) and try again."
            .to_owned()
    })?;
    say(app, &format!("Using Python {version} at {}", python.display()));
    run_step(
        app,
        "Creating the engine environment",
        Command::new(&python)
            .arg("-m")
            .arg("venv")
            .arg("--clear")
            .arg(&layout.venv),
    )?;
    run_step(
        app,
        "Updating pip",
        Command::new(layout.python()).args(["-m", "pip", "install", "--upgrade", "pip"]),
    )
}

/// Exit codes are not proof. Import what the engine actually imports.
fn verify_imports(app: &AppHandle, layout: &Layout) -> Result<(), String> {
    run_step(
        app,
        "Checking the install",
        Command::new(layout.python()).args([
            "-c",
            "import voxcpm, torch, scipy, librosa, soundfile, fastapi, uvicorn; \
             print('imports ok, torch', torch.__version__)",
        ]),
    )
}

/// Record which requirements this environment was built from, so a later
/// version of the app can tell that it needs updating.
fn write_marker(layout: &Layout) -> Result<(), String> {
    let record = serde_json::json!({
        "requirements": std::fs::read_to_string(layout.requirements()).unwrap_or_default(),
        "installed_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    std::fs::write(&layout.marker, record.to_string())
        .map_err(|err| format!("{}: {err}", layout.marker.display()))
}

/// Install one library from the engine's own requirements.
fn do_install_package(app: &AppHandle, requirement: &str) -> Result<(), String> {
    let layout = layout(app);
    let text = std::fs::read_to_string(layout.requirements())
        .map_err(|err| format!("Could not read the engine's requirements: {err}"))?;
    // Only ever install something the app itself lists. `requirement` arrives
    // from the webview, and it becomes an argument to pip.
    if !parse_requirements(&text)
        .iter()
        .any(|(req, _)| req == requirement)
    {
        return Err(format!(
            "{requirement} is not one of the engine's requirements."
        ));
    }

    ensure_environment(app, &layout)?;
    run_step(
        app,
        &format!("Installing {}", requirement_name(requirement)),
        Command::new(layout.python())
            .args(["-m", "pip", "install"])
            .arg(requirement),
    )?;

    // The last library to land is what makes the engine usable, so the check
    // and the marker happen then, whichever order they were installed in.
    if all_installed(&layout) {
        verify_imports(app, &layout)?;
        write_marker(&layout)?;
        say(app, "Every library is installed — the engine is ready to start.");
    }
    Ok(())
}

fn do_install(app: &AppHandle, start_after: bool) -> Result<(), String> {
    let layout = layout(app);
    ensure_environment(app, &layout)?;
    say(
        app,
        "Downloading the engine — about 420 MB, unpacking to roughly 2 GB. \
         Torch is the biggest piece. This takes a few minutes.",
    );
    run_step(
        app,
        "Installing the engine",
        Command::new(layout.python())
            .args(["-m", "pip", "install", "-r"])
            .arg(layout.requirements()),
    )?;
    verify_imports(app, &layout)?;
    write_marker(&layout)?;

    if start_after {
        say(app, "Engine installed. Starting it…");
        if let Some(child) = spawn_engine(app) {
            *app.state::<Engine>().0.lock().unwrap() = Some(child);
        }
    } else {
        say(app, "Engine installed.");
    }
    Ok(())
}

/// Run one install job on its own thread. Returns immediately: progress
/// arrives as `engine-install` events and the outcome as `engine-install-done`,
/// because these jobs take minutes.
fn begin_install<F>(app: &AppHandle, target: String, job: F) -> Result<(), String>
where
    F: FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
{
    {
        let state = app.state::<Installing>();
        let mut busy = state.0.lock().unwrap();
        if *busy {
            return Err("Something is already installing — let it finish first.".into());
        }
        *busy = true;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = job(handle.clone());
        *handle.state::<Installing>().0.lock().unwrap() = false;
        let _ = handle.emit(
            "engine-install-done",
            InstallDone {
                ok: result.is_ok(),
                error: result.err().unwrap_or_default(),
                target,
            },
        );
    });
    Ok(())
}

/// Install everything in one go.
#[tauri::command]
fn install_engine(app: AppHandle) -> Result<(), String> {
    begin_install(&app, String::new(), |handle| do_install(&handle, true))
}

/// Just the virtualenv, so the libraries have somewhere to go.
#[tauri::command]
fn install_environment(app: AppHandle) -> Result<(), String> {
    begin_install(&app, "environment".into(), |handle| {
        let layout = layout(&handle);
        ensure_environment(&handle, &layout)
    })
}

/// Install a single library from the engine's requirements.
#[tauri::command]
fn install_package(app: AppHandle, requirement: String) -> Result<(), String> {
    let target = requirement.clone();
    begin_install(&app, target, move |handle| {
        do_install_package(&handle, &requirement)
    })
}

// ──────────────────────── starting and stopping ──────────────────────────

fn spawn_engine(app: &AppHandle) -> Option<Child> {
    let layout = layout(app);
    let python = layout.python();
    if !python.exists() {
        println!("[tauri] engine not installed yet — waiting for the user to install it");
        return None;
    }
    if engine_already_up() {
        println!("[tauri] something is already serving {HOST}:{PORT} — not starting another");
        return None;
    }
    let script = layout.src.join("server.py");
    let _ = std::fs::create_dir_all(&layout.data);

    // Give the engine a real file to write to rather than inheriting ours.
    // Inherited stdio means a pipe, and a pipe whose reader goes away makes the
    // engine's next log line raise — which is how a stale engine turned every
    // synthesis into "[Errno 32] Broken pipe". A file also gives the user
    // something to send back when the engine misbehaves.
    let log = layout.data.join("engine.log");
    let (out, err) = match std::fs::File::create(&log) {
        Ok(file) => match file.try_clone() {
            Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
            Err(_) => (Stdio::null(), Stdio::null()),
        },
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    match Command::new(&python)
        .arg(&script)
        .stdout(out)
        .stderr(err)
        .current_dir(&layout.src)
        // The sources sit inside the .app, so the engine is told where it may
        // write instead.
        .env("VOICE_DATA_DIR", &layout.data)
        .env("VOICE_PORT", PORT.to_string())
        // Python caches bytecode next to the source by default, which here
        // means writing __pycache__ into the app bundle. Harmless while the
        // bundle is unsigned, but it would invalidate the seal on a signed and
        // notarised build, where macOS verifies it on launch.
        .env("PYTHONPYCACHEPREFIX", layout.data.join("pycache"))
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("VIRTUAL_ENV")
        .spawn()
    {
        Ok(child) => {
            println!("[tauri] voice engine started (pid {})", child.id());
            Some(child)
        }
        Err(err) => {
            eprintln!("[tauri] failed to start the engine with {python:?}: {err}");
            None
        }
    }
}

/// Start the engine now — used after an install, or to retry a failed start.
#[tauri::command]
fn start_engine(app: AppHandle) -> Result<bool, String> {
    if engine_already_up() {
        return Ok(true);
    }
    let layout = layout(&app);
    if !layout.installed() {
        return Err("The engine isn't installed yet.".into());
    }
    match spawn_engine(&app) {
        Some(child) => {
            *app.state::<Engine>().0.lock().unwrap() = Some(child);
            Ok(true)
        }
        None => Err("Could not start the engine.".into()),
    }
}

fn stop_engine(engine: State<Engine>) {
    if let Some(mut child) = engine.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        println!("[tauri] voice engine stopped");
    }
}

// ─────────────────────────────── saving ──────────────────────────────────

/// Save a copy of a generated clip wherever the user chooses.
///
/// The webview can't do this itself: WKWebView ignores the `download`
/// attribute, so an `<a download href="...">` in the UI silently does nothing.
/// The engine has already written the clip, so we ask for a destination and
/// copy the file.
#[tauri::command]
async fn save_audio(app: AppHandle, audio_id: String) -> Result<Option<String>, String> {
    // The id comes from the engine and is interpolated into a path: only ever
    // accept the shape the engine produces (a 32-char hex uuid).
    if audio_id.len() != 32 || !audio_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Bad clip id.".into());
    }

    let source = layout(&app).data.join("out").join(format!("{audio_id}.wav"));
    if !source.exists() {
        return Err("That clip is no longer on disk — generate it again.".into());
    }

    // Blocking is correct here: an async command runs off the main thread, and
    // the dialog plugin puts the panel on the main thread itself.
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name("speech.wav")
        .add_filter("WAV audio", &["wav"])
        .blocking_save_file()
    else {
        return Ok(None); // user cancelled
    };

    let target = target.into_path().map_err(|err| err.to_string())?;
    std::fs::copy(&source, &target).map_err(|err| format!("Could not save the file: {err}"))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine(Mutex::new(None)))
        .manage(Installing(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            engine_base_url,
            engine_state,
            engine_packages,
            install_engine,
            install_environment,
            install_package,
            start_engine,
            save_audio
        ])
        .setup(|app| {
            // Terminal equivalents of the setup screen's buttons, running
            // exactly the same code. For pre-seeding a machine, and for seeing
            // the failure when an install fails inside the app.
            //
            //   --list-libraries              what the checklist shows, as JSON
            //   --install-engine              every library, in one go
            //   --install-library <req>       one row of the list
            let args: Vec<String> = std::env::args().collect();
            let one = args
                .iter()
                .position(|arg| arg == "--install-library")
                .and_then(|at| args.get(at + 1))
                .cloned();
            if args.iter().any(|arg| arg == "--list-libraries") {
                let handle = app.handle().clone();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
                std::thread::spawn(move || {
                    let code = match engine_packages(handle) {
                        Ok(list) => {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&list).unwrap_or_default()
                            );
                            0
                        }
                        Err(err) => {
                            eprintln!("{err}");
                            1
                        }
                    };
                    std::process::exit(code);
                });
                return Ok(());
            }
            if args.iter().any(|arg| arg == "--install-engine") || one.is_some() {
                let handle = app.handle().clone();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
                std::thread::spawn(move || {
                    let result = match &one {
                        Some(requirement) => do_install_package(&handle, requirement),
                        None => do_install(&handle, false),
                    };
                    let code = match result {
                        Ok(()) => 0,
                        Err(err) => {
                            eprintln!("[install] FAILED: {err}");
                            1
                        }
                    };
                    std::process::exit(code);
                });
                return Ok(());
            }

            // Off the main thread: this probes a TCP port, and on first run
            // there is nothing to start, so the window should not wait for it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(child) = spawn_engine(&handle) {
                    *handle.state::<Engine>().0.lock().unwrap() = Some(child);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Make sure the Python process doesn't outlive the app.
            if let RunEvent::Exit = event {
                stop_engine(app.state::<Engine>());
            }
        });
}
