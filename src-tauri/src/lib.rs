// The Tauri (Rust) shell. Its only real job is lifecycle management of the
// local Python voice engine: start it when the app launches, stop it on exit.
// All text-to-speech work happens in Python; the React UI talks to it over
// http://127.0.0.1:8008 directly.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

/// Holds the running Python engine process so we can kill it on exit.
struct Engine(Mutex<Option<Child>>);

/// Base URL the frontend should call. Kept here so there's a single source of truth.
#[tauri::command]
fn engine_base_url() -> String {
    "http://127.0.0.1:8008".to_string()
}

/// Work out where the Python interpreter and server script live.
/// In development they sit in `<project>/python`; in a bundled app they're
/// shipped under the Tauri resource directory.
fn engine_paths(app: &tauri::AppHandle) -> (PathBuf, PathBuf) {
    #[cfg(debug_assertions)]
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("python");

    #[cfg(not(debug_assertions))]
    let python_dir = app
        .path()
        .resource_dir()
        .expect("resource dir")
        .join("python");

    let _ = app;

    // Prefer the VoxCPM2 virtualenv, then the older one, then system python3.
    let interpreter = [".venv-voxcpm/bin/python", ".venv/bin/python"]
        .iter()
        .map(|rel| python_dir.join(rel))
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("python3"));

    (interpreter, python_dir)
}

/// Save a copy of a generated clip wherever the user chooses.
///
/// The webview can't do this itself: WKWebView ignores the `download`
/// attribute, so an `<a download href="...">` in the UI silently does nothing.
/// The engine has already written the clip to `python/data/out/<id>.wav`, so we
/// just ask for a destination and copy the file.
#[tauri::command]
async fn save_audio(app: tauri::AppHandle, audio_id: String) -> Result<Option<String>, String> {
    // The id comes from the engine and is interpolated into a path: only ever
    // accept the shape the engine produces (a 32-char hex uuid).
    if audio_id.len() != 32 || !audio_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Bad clip id.".into());
    }

    let (_, python_dir) = engine_paths(&app);
    let source = python_dir
        .join("data")
        .join("out")
        .join(format!("{audio_id}.wav"));
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

fn start_engine(app: &tauri::AppHandle) -> Option<Child> {
    let (interpreter, python_dir) = engine_paths(app);
    let script = python_dir.join("server.py");

    match Command::new(&interpreter)
        .arg(&script)
        .current_dir(&python_dir)
        .spawn()
    {
        Ok(child) => {
            println!("[tauri] voice engine started (pid {})", child.id());
            Some(child)
        }
        Err(err) => {
            eprintln!(
                "[tauri] failed to start voice engine using {:?}: {err}\n\
                 Did you create the venv?  cd python && python3.11 -m venv .venv && \
                 .venv/bin/pip install -r requirements.txt",
                interpreter
            );
            None
        }
    }
}

fn stop_engine(engine: State<Engine>) {
    if let Some(mut child) = engine.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        println!("[tauri] voice engine stopped");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![engine_base_url, save_audio])
        .setup(|app| {
            let child = start_engine(app.handle());
            *app.state::<Engine>().0.lock().unwrap() = child;
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
