use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const MAX_SCRIPT_BYTES: usize = 256 * 1024;
const MAX_ARG_COUNT: usize = 32;
const MAX_ARG_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_ACTIVE_SCRIPTS: usize = 32;
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(30);

type SkillCallKey = (String, String);

#[derive(Default)]
pub struct SkillScriptState {
    calls: Mutex<HashMap<SkillCallKey, Arc<AtomicBool>>>,
}

impl SkillScriptState {
    fn register(&self, key: SkillCallKey) -> Result<Arc<AtomicBool>, String> {
        let mut calls = self
            .calls
            .lock()
            .map_err(|_| "skill script state is unavailable".to_string())?;
        if calls.len() >= MAX_ACTIVE_SCRIPTS {
            return Err(format!(
                "too many active skill scripts (max {MAX_ACTIVE_SCRIPTS})"
            ));
        }
        if calls.contains_key(&key) {
            return Err("duplicate skill script run/call id".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        calls.insert(key, Arc::clone(&cancelled));
        Ok(cancelled)
    }

    fn unregister(&self, key: &SkillCallKey) {
        if let Ok(mut calls) = self.calls.lock() {
            calls.remove(key);
        }
    }

    fn cancel(&self, key: &SkillCallKey) -> bool {
        let Ok(calls) = self.calls.lock() else {
            return false;
        };
        let Some(cancelled) = calls.get(key) else {
            return false;
        };
        cancelled.store(true, Ordering::Release);
        true
    }

    fn cancel_all(&self) -> Result<usize, String> {
        let calls = self
            .calls
            .lock()
            .map_err(|_| "skill script state is unavailable".to_string())?;
        let count = calls.len();
        for cancelled in calls.values() {
            cancelled.store(true, Ordering::Release);
        }
        Ok(count)
    }

    fn active_count(&self) -> Result<usize, String> {
        self.calls
            .lock()
            .map(|calls| calls.len())
            .map_err(|_| "skill script state is unavailable".to_string())
    }

    pub fn shutdown_now(&self) {
        if let Ok(mut calls) = self.calls.lock() {
            for (_, cancelled) in calls.drain() {
                cancelled.store(true, Ordering::Release);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SkillScriptRequest {
    skill_id: String,
    skill_name: String,
    skill_source: String,
    run_id: String,
    call_id: String,
    script_path: String,
    script_content: String,
    content_sha256: String,
    args: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillScriptResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

fn extension(path: &str) -> Option<&str> {
    path.rsplit_once('.').map(|(_, ext)| ext)
}

fn interpreter_for(path: &str) -> Option<(&'static str, &'static str)> {
    match extension(path)? {
        "py" => Some(("python3", "-c")),
        "js" | "mjs" => Some(("node", "-e")),
        "sh" => Some(("sh", "-c")),
        _ => None,
    }
}

fn resolve_program(program: &str) -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(program);
        if candidate.is_file() {
            return Ok(candidate);
        }
        #[cfg(windows)]
        {
            let candidate = directory.join(format!("{program}.exe"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "interpreter {program} was not found in the host PATH; install it or launch Open Builder from a terminal whose PATH includes it"
    ))
}

fn validate_request(req: &SkillScriptRequest) -> Result<(&'static str, &'static str), String> {
    if req.skill_id.trim().is_empty()
        || req.skill_name.trim().is_empty()
        || req.run_id.trim().is_empty()
        || req.call_id.trim().is_empty()
    {
        return Err("skill identity and run/call ids are required".to_string());
    }
    for (label, value) in [
        ("skill id", req.skill_id.as_str()),
        ("skill name", req.skill_name.as_str()),
        ("run id", req.run_id.as_str()),
        ("call id", req.call_id.as_str()),
        ("script path", req.script_path.as_str()),
    ] {
        if value.chars().any(is_unsafe_display_char) {
            return Err(format!(
                "{label} must not contain control or invisible formatting characters"
            ));
        }
    }
    if req.skill_source != "builtin" && req.skill_source != "imported" {
        return Err("skill source must be builtin or imported".to_string());
    }
    if req.script_path.trim().is_empty() {
        return Err("script path is required".to_string());
    }
    if req.script_path.starts_with('/') || req.script_path.contains("..") {
        return Err("script path must be a relative skill path".to_string());
    }
    if req.script_content.len() > MAX_SCRIPT_BYTES {
        return Err(format!("script exceeds {} bytes", MAX_SCRIPT_BYTES));
    }
    let calculated_hash = format!("{:x}", Sha256::digest(req.script_content.as_bytes()));
    if req.content_sha256 != calculated_hash {
        return Err("script content hash does not match the approved request".to_string());
    }
    if req.args.len() > MAX_ARG_COUNT {
        return Err(format!("too many script args (max {})", MAX_ARG_COUNT));
    }
    if req.args.iter().any(|arg| arg.len() > MAX_ARG_BYTES) {
        return Err(format!(
            "script args must be <= {} bytes each",
            MAX_ARG_BYTES
        ));
    }
    interpreter_for(&req.script_path)
        .ok_or_else(|| "unsupported script extension; allowed: .py, .js, .mjs, .sh".to_string())
}

fn is_unsafe_display_char(value: char) -> bool {
    value.is_control()
        || matches!(
            value,
            '\u{00ad}'
                | '\u{061c}'
                | '\u{200b}'..='\u{200f}'
                | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}'
                | '\u{feff}'
        )
}

fn approval_message(req: &SkillScriptRequest) -> String {
    let args = escape_unsafe_display_chars(
        &serde_json::to_string(&req.args).unwrap_or_else(|_| "[]".to_string()),
    );
    format!(
        "A model requested a local Skill script.\n\n\
         Skill: {} ({})\n\
         Source: {}\n\
         Script: {}\n\
         SHA-256: {}\n\
         Run: {}\n\
         Call: {}\n\
         Arguments: {}\n\n\
         Risk: this script runs with an empty inherited environment and an isolated working directory, \
         but network access is not yet sandboxed. Approve this invocation only if you trust the source and parameters.",
        req.skill_name,
        req.skill_id,
        req.skill_source,
        req.script_path,
        req.content_sha256,
        req.run_id,
        req.call_id,
        args,
    )
}

fn escape_unsafe_display_chars(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if is_unsafe_display_char(character) {
            let _ = write!(escaped, "\\u{:04x}", character as u32);
        } else {
            escaped.push(character);
        }
    }
    escaped
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_tree(child: &mut std::process::Child) {
    // The child starts a new process group; a negative pid targets the group.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

struct CapturedStream {
    text: String,
    truncated: bool,
}

fn read_capped_stream<R: Read>(mut reader: R) -> CapturedStream {
    let mut captured: Vec<u8> = Vec::with_capacity(MAX_OUTPUT_BYTES.min(8192));
    let mut truncated = false;
    let mut buf = [0u8; 8192];

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(captured.len());
                if remaining > 0 {
                    captured.extend_from_slice(&buf[..n.min(remaining)]);
                }
                if n > remaining {
                    truncated = true;
                }
            }
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }

    CapturedStream {
        text: String::from_utf8_lossy(&captured).to_string(),
        truncated,
    }
}

fn append_truncation_note(mut text: String, stream_name: &str, truncated: bool) -> String {
    if truncated {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!(
            "[{stream_name} truncated after {MAX_OUTPUT_BYTES} bytes]"
        ));
    }
    text
}

fn join_reader(
    handle: thread::JoinHandle<CapturedStream>,
    stream_name: &str,
) -> Result<String, String> {
    let captured = handle
        .join()
        .map_err(|_| format!("failed to collect {stream_name} output"))?;
    Ok(append_truncation_note(
        captured.text,
        stream_name,
        captured.truncated,
    ))
}

fn execute_script_process(
    req: &SkillScriptRequest,
    program: &str,
    program_path: &Path,
    eval_flag: &str,
    work_dir: &Path,
    cancelled: &AtomicBool,
) -> Result<SkillScriptResult, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("skill script execution was cancelled".to_string());
    }

    let mut command = Command::new(program_path);
    command
        .env_clear()
        .current_dir(work_dir)
        .arg(eval_flag)
        .arg(&req.script_content)
        .args(&req.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start {program}: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture {program} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture {program} stderr"))?;
    let stdout_reader = thread::spawn(move || read_capped_stream(stdout));
    let stderr_reader = thread::spawn(move || read_capped_stream(stderr));

    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Acquire) {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            let _ = join_reader(stdout_reader, "stdout")?;
            let _ = join_reader(stderr_reader, "stderr")?;
            return Err("skill script execution was cancelled".to_string());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll {program}: {err}"))?
        {
            let stdout = join_reader(stdout_reader, "stdout")?;
            let stderr = join_reader(stderr_reader, "stderr")?;
            return Ok(SkillScriptResult {
                stdout,
                stderr,
                exit_code: status.code().unwrap_or(-1),
            });
        }
        if started.elapsed() > SCRIPT_TIMEOUT {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            let stdout = join_reader(stdout_reader, "stdout")?;
            let stderr = join_reader(stderr_reader, "stderr")?;
            return Ok(SkillScriptResult {
                stdout,
                stderr: [
                    stderr,
                    format!("script timed out after {}s", SCRIPT_TIMEOUT.as_secs()),
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
                exit_code: 124,
            });
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tauri::command]
pub async fn run_skill_script(
    app: tauri::AppHandle,
    state: State<'_, SkillScriptState>,
    req: SkillScriptRequest,
) -> Result<SkillScriptResult, String> {
    let (program, eval_flag) = validate_request(&req)?;
    let program_path = resolve_program(program)?;
    let key = (req.run_id.clone(), req.call_id.clone());
    let cancelled = state.register(key.clone())?;
    let task = tauri::async_runtime::spawn_blocking(move || {
        if cancelled.load(Ordering::Acquire) {
            return Err("skill script execution was cancelled".to_string());
        }
        let approved = app
            .dialog()
            .message(approval_message(&req))
            .title("Approve local Skill script")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Run once".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show();
        if !approved {
            return Err("skill script execution was denied by the user".to_string());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("skill script execution was cancelled".to_string());
        }

        let work_dir =
            std::env::temp_dir().join(format!("open-builder-skill-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&work_dir)
            .map_err(|err| format!("failed to create isolated work directory: {err}"))?;

        let execution = execute_script_process(
            &req,
            program,
            &program_path,
            eval_flag,
            &work_dir,
            &cancelled,
        );
        let _ = fs::remove_dir_all(&work_dir);
        execution
    })
    .await
    .map_err(|err| format!("script task failed: {err}"));
    state.unregister(&key);
    task?
}

#[tauri::command]
pub fn cancel_skill_script(
    state: State<'_, SkillScriptState>,
    run_id: String,
    call_id: String,
) -> Result<bool, String> {
    for (label, value) in [("run id", run_id.as_str()), ("call id", call_id.as_str())] {
        if value.trim().is_empty() || value.chars().any(is_unsafe_display_char) {
            return Err(format!("{label} is invalid"));
        }
    }
    Ok(state.cancel(&(run_id, call_id)))
}

#[tauri::command]
pub async fn cancel_all_skill_scripts(state: State<'_, SkillScriptState>) -> Result<usize, String> {
    let cancelled = state.cancel_all()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while state.active_count()? > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // Approval dialogs can outlive the wait. Their cancellation flags remain
    // set, while draining the registry prevents stale native bookkeeping.
    if state.active_count()? > 0 {
        state.shutdown_now();
    }
    Ok(cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SkillScriptRequest {
        let content = "console.log('ok')".to_string();
        SkillScriptRequest {
            skill_id: "demo".to_string(),
            skill_name: "Demo".to_string(),
            skill_source: "imported".to_string(),
            run_id: "run-1".to_string(),
            call_id: "call-1".to_string(),
            script_path: "scripts/demo.js".to_string(),
            content_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
            script_content: content,
            args: vec!["--check".to_string()],
        }
    }

    #[test]
    fn validates_identity_and_content_hash() {
        assert!(validate_request(&request()).is_ok());
        let mut forged = request();
        forged.script_content.push_str("; malicious()");
        assert!(validate_request(&forged)
            .unwrap_err()
            .contains("hash does not match"));
    }

    #[test]
    fn rejects_control_characters_before_building_the_approval_dialog() {
        for name in [
            "Trusted Skill\nUntrusted Skill",
            "Trusted Skill\u{202e}Untrusted Skill",
        ] {
            let mut spoofed = request();
            spoofed.skill_name = name.to_string();
            assert!(validate_request(&spoofed)
                .unwrap_err()
                .contains("control or invisible formatting characters"));
        }
    }

    #[test]
    fn cancellation_is_scoped_to_the_run_and_call_id() {
        let state = SkillScriptState::default();
        let key = ("run-1".to_string(), "call-1".to_string());
        let cancelled = state.register(key.clone()).unwrap();

        assert!(!state.cancel(&("run-1".to_string(), "other".to_string())));
        assert!(!cancelled.load(Ordering::Acquire));
        assert!(state.cancel(&key));
        assert!(cancelled.load(Ordering::Acquire));
        state.unregister(&key);
    }

    #[test]
    fn cancel_all_marks_every_active_script_and_cleans_state() {
        let state = SkillScriptState::default();
        let first_key = ("run-1".to_string(), "call-1".to_string());
        let second_key = ("run-2".to_string(), "call-2".to_string());
        let first = state.register(first_key.clone()).unwrap();
        let second = state.register(second_key.clone()).unwrap();

        assert_eq!(state.cancel_all().unwrap(), 2);
        assert!(first.load(Ordering::Acquire));
        assert!(second.load(Ordering::Acquire));
        state.shutdown_now();
        assert_eq!(state.active_count().unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_the_spawned_process_group() {
        let work_dir =
            std::env::temp_dir().join(format!("open-builder-skill-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&work_dir).unwrap();
        let marker_path = work_dir.join("escaped-child-marker");
        let pid_path = work_dir.join("child.pid");
        let content = r#"/bin/sh -c '/bin/sleep 1; : > "$1"' child "$1" &
echo $! > "$2"
wait"#
            .to_string();
        let mut req = request();
        req.script_path = "scripts/demo.sh".to_string();
        req.script_content = content;
        req.content_sha256 = format!("{:x}", Sha256::digest(req.script_content.as_bytes()));
        req.args = vec![
            "skill-script".to_string(),
            marker_path.to_string_lossy().to_string(),
            pid_path.to_string_lossy().to_string(),
        ];
        let program_path = resolve_program("sh").unwrap();
        let state = Arc::new(SkillScriptState::default());
        let key = ("process-run".to_string(), "process-call".to_string());
        let cancelled = state.register(key.clone()).unwrap();
        let thread_cancelled = Arc::clone(&cancelled);
        let thread_work_dir = work_dir.clone();
        let handle = thread::spawn(move || {
            execute_script_process(
                &req,
                "sh",
                &program_path,
                "-c",
                &thread_work_dir,
                &thread_cancelled,
            )
        });

        for _ in 0..100 {
            if pid_path.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(pid_path.exists(), "child process did not start");
        assert_eq!(state.cancel_all().unwrap(), 1);

        let error = handle.join().unwrap().unwrap_err();
        assert!(error.contains("cancelled"));
        state.unregister(&key);
        thread::sleep(Duration::from_millis(1_100));
        assert!(
            !marker_path.exists(),
            "spawned child survived process-group cancellation"
        );
        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn approval_message_contains_source_hash_and_full_args() {
        let mut req = request();
        req.args.push("direction\u{202e}override".to_string());
        let message = approval_message(&req);
        assert!(message.contains("Source: imported"));
        assert!(message.contains(&req.content_sha256));
        assert!(message.contains("Call: call-1"));
        assert!(message.contains("\"--check\""));
        assert!(message.contains("direction\\u202eoverride"));
        assert!(message.contains("not yet sandboxed"));
    }
}
