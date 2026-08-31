use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use serde_json::Value;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

use crate::local_agent::{LocalAgentEvent, LocalAgentStartRequest};

const MAX_JSON_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROTOCOL_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_PROTOCOL_EVENTS: usize = 250_000;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(4);

pub struct ProtocolContext {
    pub executable: PathBuf,
    pub request: LocalAgentStartRequest,
    pub run_dir: PathBuf,
    pub session_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub bridge_url: String,
    pub bridge_token: String,
    pub cancellation: CancellationToken,
    pub channel: tauri::ipc::Channel<LocalAgentEvent>,
    pub cli_version: String,
}

pub struct ProtocolOutcome {
    pub session_id: Option<String>,
    pub aborted: bool,
}

pub(crate) struct SpawnedProcess {
    pub(crate) child: Arc<tokio::sync::Mutex<Box<dyn ChildWrapper>>>,
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: ChildStdout,
    pub(crate) stderr: ChildStderr,
    pub(crate) tree_guard: ProcessTreeGuard,
}

pub(crate) struct ProcessTreeGuard {
    #[cfg(unix)]
    pgid: i32,
    armed: bool,
}

impl ProcessTreeGuard {
    fn new(child: &dyn ChildWrapper) -> Result<Self, String> {
        #[cfg(unix)]
        let pgid = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .ok_or_else(|| "failed to identify local CLI process group".to_string())?;
        #[cfg(not(unix))]
        let _ = child;

        Ok(Self {
            #[cfg(unix)]
            pgid,
            armed: true,
        })
    }

    pub(crate) fn cleanup(&mut self) {
        if !self.armed {
            return;
        }
        #[cfg(unix)]
        unsafe {
            // Reap descendants that can outlive a normally exited leader.
            let _ = libc::kill(-self.pgid, libc::SIGKILL);
        }
        self.armed = false;
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        self.cleanup();
        // On Windows, closing the process-wrap Job Object is the ownership
        // boundary and terminates every process assigned to it.
    }
}

#[derive(Default)]
pub(crate) struct ProtocolOutputBudget {
    bytes: usize,
    events: usize,
}

impl ProtocolOutputBudget {
    pub(crate) fn record(&mut self, line: &str) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(line.len().saturating_add(1))
            .ok_or_else(|| "local CLI output byte counter overflowed".to_string())?;
        self.events = self
            .events
            .checked_add(1)
            .ok_or_else(|| "local CLI output event counter overflowed".to_string())?;
        if self.bytes > MAX_PROTOCOL_OUTPUT_BYTES {
            return Err("local CLI output exceeded the cumulative byte limit".to_string());
        }
        if self.events > MAX_PROTOCOL_EVENTS {
            return Err("local CLI output exceeded the event limit".to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn exhausted_for_test() -> Self {
        Self {
            bytes: MAX_PROTOCOL_OUTPUT_BYTES,
            events: 0,
        }
    }
}

pub(crate) fn spawn_stderr_drain(
    mut stderr: ChildStderr,
) -> (Arc<AtomicBool>, tauri::async_runtime::JoinHandle<()>) {
    let saw_stderr = Arc::new(AtomicBool::new(false));
    let stderr_flag = saw_stderr.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    stderr_flag.store(true, Ordering::Relaxed);
                }
            }
        }
    });
    (saw_stderr, task)
}

pub(crate) fn provider_error(context: &str, saw_stderr: bool) -> String {
    if saw_stderr {
        format!("{context}; CLI stderr was redacted")
    } else {
        context.to_string()
    }
}

pub fn apply_minimal_environment(command: &mut Command) {
    const ALLOWED_EXACT: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "no_proxy",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "SystemRoot",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
    ];
    command.env_clear();
    for (name, value) in std::env::vars_os() {
        let name_text = name.to_string_lossy();
        if ALLOWED_EXACT.iter().any(|allowed| *allowed == name_text) || name_text.starts_with("LC_")
        {
            command.env(name, value);
        }
    }
    let loopback_hosts = "127.0.0.1,localhost,::1";
    let inherited_no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let no_proxy = if inherited_no_proxy.trim().is_empty() {
        loopback_hosts.to_string()
    } else {
        format!("{inherited_no_proxy},{loopback_hosts}")
    };
    command.env("NO_PROXY", &no_proxy).env("no_proxy", no_proxy);
}

pub(crate) fn spawn_wrapped(mut command: Command) -> Result<SpawnedProcess, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut wrapped = CommandWrap::from(command);
    wrapped.wrap(KillOnDrop);
    #[cfg(unix)]
    wrapped.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    wrapped.wrap(JobObject);
    let mut child = wrapped
        .spawn()
        .map_err(|_| "failed to start local CLI".to_string())?;
    let tree_guard = ProcessTreeGuard::new(child.as_ref())?;
    let stdin = child
        .stdin()
        .take()
        .ok_or_else(|| "failed to open local CLI stdin".to_string())?;
    let stdout = child
        .stdout()
        .take()
        .ok_or_else(|| "failed to open local CLI stdout".to_string())?;
    let stderr = child
        .stderr()
        .take()
        .ok_or_else(|| "failed to open local CLI stderr".to_string())?;
    Ok(SpawnedProcess {
        child: Arc::new(tokio::sync::Mutex::new(child)),
        stdin,
        stdout,
        stderr,
        tree_guard,
    })
}

async fn read_capped_output<Stdout, Stderr>(
    stdout: &mut Stdout,
    stderr: &mut Stderr,
    max_output_bytes: usize,
) -> Result<(Vec<u8>, Vec<u8>), String>
where
    Stdout: AsyncRead + Unpin,
    Stderr: AsyncRead + Unpin,
{
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut stdout_buffer = [0_u8; 4096];
    let mut stderr_buffer = [0_u8; 4096];

    while stdout_open || stderr_open {
        let current_total = stdout_bytes.len().saturating_add(stderr_bytes.len());
        tokio::select! {
            result = stdout.read(&mut stdout_buffer), if stdout_open => {
                let bytes = result.map_err(|_| "failed to read local CLI capability probe".to_string())?;
                if bytes == 0 {
                    stdout_open = false;
                    continue;
                }
                if current_total.saturating_add(bytes) > max_output_bytes {
                    return Err("local CLI capability probe exceeded the output limit".to_string());
                }
                stdout_bytes.extend_from_slice(&stdout_buffer[..bytes]);
            }
            result = stderr.read(&mut stderr_buffer), if stderr_open => {
                let bytes = result.map_err(|_| "failed to read local CLI capability probe".to_string())?;
                if bytes == 0 {
                    stderr_open = false;
                    continue;
                }
                if current_total.saturating_add(bytes) > max_output_bytes {
                    return Err("local CLI capability probe exceeded the output limit".to_string());
                }
                stderr_bytes.extend_from_slice(&stderr_buffer[..bytes]);
            }
        }
    }

    Ok((stdout_bytes, stderr_bytes))
}

pub async fn command_output_capped(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    command.args(args);
    let process = spawn_wrapped(command)?;
    let child = process.child.clone();
    let mut stdout = process.stdout;
    let mut stderr = process.stderr;
    let mut tree_guard = process.tree_guard;
    drop(process.stdin);

    let capture = async {
        let (stdout, stderr) =
            read_capped_output(&mut stdout, &mut stderr, max_output_bytes).await?;
        let status = child
            .lock()
            .await
            .wait()
            .await
            .map_err(|_| "failed to wait for local CLI capability probe".to_string())?;
        Ok::<_, String>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };

    match tokio::time::timeout(timeout, capture).await {
        Ok(Ok(output)) => {
            tree_guard.cleanup();
            Ok(output)
        }
        Ok(Err(error)) => {
            if terminate(&child).await {
                tree_guard.cleanup();
            }
            Err(error)
        }
        Err(_) => {
            if terminate(&child).await {
                tree_guard.cleanup();
            }
            Err("local CLI capability probe timed out".to_string())
        }
    }
}

pub(crate) async fn terminate(child: &Arc<tokio::sync::Mutex<Box<dyn ChildWrapper>>>) -> bool {
    let mut child = child.lock().await;
    let _ = child.start_kill();
    matches!(
        tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await,
        Ok(Ok(_))
    )
}

pub(crate) async fn finish_process(
    child: Arc<tokio::sync::Mutex<Box<dyn ChildWrapper>>>,
    stderr_task: tauri::async_runtime::JoinHandle<()>,
    mut tree_guard: ProcessTreeGuard,
) -> Result<Option<std::process::ExitStatus>, String> {
    let waited = {
        let mut child = child.lock().await;
        tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await
    };
    let result = match waited {
        Ok(Ok(status)) => {
            tree_guard.cleanup();
            Ok(Some(status))
        }
        Ok(Err(_)) => {
            if terminate(&child).await {
                tree_guard.cleanup();
            }
            Err("failed to wait for local CLI process".to_string())
        }
        Err(_) => {
            if terminate(&child).await {
                tree_guard.cleanup();
            }
            Ok(None)
        }
    };
    stderr_task.abort();
    result
}

pub(crate) async fn read_capped_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "failed to read local CLI output".to_string())?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| "local CLI emitted invalid UTF-8".to_string())
            };
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if bytes.len().saturating_add(consumed) > MAX_JSON_LINE_BYTES {
            return Err("local CLI JSON event exceeded the line limit".to_string());
        }
        bytes.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "local CLI emitted invalid UTF-8".to_string());
        }
    }
}

pub(crate) async fn write_json<W: AsyncWrite + Unpin>(
    stdin: &mut W,
    value: &Value,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|_| "failed to serialize local CLI request".to_string())?;
    if bytes.len() > MAX_JSON_LINE_BYTES {
        return Err("local CLI request exceeded the line limit".to_string());
    }
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| "failed to write local CLI request".to_string())?;
    stdin
        .flush()
        .await
        .map_err(|_| "failed to flush local CLI request".to_string())
}

pub(crate) fn turn_prompt(request: &LocalAgentStartRequest) -> String {
    match request
        .bootstrap_context
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(bootstrap) => format!(
            "[Open Builder application history]\n{bootstrap}\n\n[Current request]\n{}",
            request.prompt
        ),
        None => request.prompt.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn caps_combined_probe_output_while_streaming() {
        let (mut stdout_writer, mut stdout_reader) = tokio::io::duplex(MAX_JSON_LINE_BYTES);
        let (mut stderr_writer, mut stderr_reader) = tokio::io::duplex(MAX_JSON_LINE_BYTES);
        let stdout_task = tokio::spawn(async move {
            let _ = stdout_writer.write_all(&vec![b'o'; 192 * 1024]).await;
            let _ = stdout_writer.shutdown().await;
        });
        let stderr_task = tokio::spawn(async move {
            let _ = stderr_writer.write_all(&vec![b'e'; 192 * 1024]).await;
            let _ = stderr_writer.shutdown().await;
        });

        let result = read_capped_output(&mut stdout_reader, &mut stderr_reader, 256 * 1024).await;
        assert!(result
            .expect_err("combined output must be capped")
            .contains("output limit"));
        stdout_task.await.unwrap();
        stderr_task.await.unwrap();
    }

    #[tokio::test]
    async fn preserves_probe_stdout_and_stderr_below_budget() {
        let (mut stdout_writer, mut stdout_reader) = tokio::io::duplex(64);
        let (mut stderr_writer, mut stderr_reader) = tokio::io::duplex(64);
        stdout_writer.write_all(b"version\n").await.unwrap();
        stdout_writer.shutdown().await.unwrap();
        stderr_writer.write_all(b"warning\n").await.unwrap();
        stderr_writer.shutdown().await.unwrap();

        let (stdout, stderr) = read_capped_output(&mut stdout_reader, &mut stderr_reader, 64)
            .await
            .unwrap();
        assert_eq!(stdout, b"version\n");
        assert_eq!(stderr, b"warning\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_process_tree_guard_kills_spawned_descendants() {
        let marker = std::env::temp_dir().join(format!(
            "open-builder-process-tree-test-{}",
            uuid::Uuid::new_v4()
        ));
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("(sleep 0.5; touch \"$MARKER_PATH\") & echo ready; wait")
            .env("MARKER_PATH", &marker);
        let process = spawn_wrapped(command).expect("fixture process must spawn");
        let SpawnedProcess {
            child,
            stdin,
            stdout,
            stderr,
            tree_guard,
        } = process;
        let mut reader = BufReader::new(stdout);
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut ready))
            .await
            .expect("fixture must announce its descendant")
            .expect("fixture stdout must be readable");
        assert_eq!(ready.trim(), "ready");

        drop(tree_guard);
        drop(child);
        drop(stdin);
        drop(reader);
        drop(stderr);
        tokio::time::sleep(Duration::from_millis(900)).await;
        let descendant_survived = marker.exists();
        let _ = std::fs::remove_file(&marker);
        assert!(
            !descendant_survived,
            "descendant survived process-tree drop"
        );
    }

    #[test]
    fn protocol_output_budget_is_cumulative() {
        let mut budget = ProtocolOutputBudget {
            bytes: MAX_PROTOCOL_OUTPUT_BYTES - 2,
            ..Default::default()
        };
        assert!(budget.record("x").is_ok());
        assert!(budget.record("x").is_err());

        let mut budget = ProtocolOutputBudget {
            events: MAX_PROTOCOL_EVENTS,
            ..Default::default()
        };
        assert!(budget.record("{}").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_leader_exit_still_reaps_descendants() {
        let marker = std::env::temp_dir().join(format!(
            "open-builder-process-tree-normal-exit-{}",
            uuid::Uuid::new_v4()
        ));
        let script = format!(
            "(sleep 0.5; touch '{}') >/dev/null 2>&1 &",
            marker.display()
        );
        let output = command_output_capped(
            Path::new("/bin/sh"),
            &["-c", &script],
            Duration::from_secs(2),
            1024,
        )
        .await
        .expect("fixture leader must exit successfully");
        assert!(output.status.success());
        tokio::time::sleep(Duration::from_millis(900)).await;
        let descendant_survived = marker.exists();
        let _ = std::fs::remove_file(&marker);
        assert!(
            !descendant_survived,
            "descendant survived a normal leader exit"
        );
    }
}
