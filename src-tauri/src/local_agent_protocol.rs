use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

use crate::local_agent::{LocalAgentStartRequest, TrackedChannel};
use crate::local_agent_runtime::{AdapterError, LocalCliFailureCode};

const MAX_JSON_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROTOCOL_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_PROTOCOL_EVENTS: usize = 250_000;
const MAX_STDERR_TAIL_BYTES: usize = 8 * 1024;
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
    pub channel: TrackedChannel,
    pub cli_version: String,
}

#[derive(Debug)]
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

/// A run-scoped process launch contract captured during provider preparation.
/// Secret-bearing environment values deliberately have no Debug, Clone, or
/// serialization implementation.
pub(crate) struct FrozenProcessSpec {
    executable: OsString,
    args: Vec<OsString>,
    cwd: PathBuf,
    environment: Vec<(OsString, OsString)>,
    redactions: Vec<String>,
}

/// Identity for a private file created during provider preparation. Launch
/// verifies it before the CLI can observe the path.
pub(crate) struct PreparedPrivateFile {
    path: PathBuf,
    root: PathBuf,
    digest: [u8; 32],
}

impl PreparedPrivateFile {
    pub(crate) fn capture(path: &Path, root: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(root)
            .map_err(|_| "failed to resolve private local CLI root".to_string())?;
        let link_metadata = std::fs::symlink_metadata(path)
            .map_err(|_| "failed to inspect private local CLI artifact".to_string())?;
        if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
            return Err("private local CLI artifact is not a regular file".to_string());
        }
        let path = std::fs::canonicalize(path)
            .map_err(|_| "failed to resolve private local CLI artifact".to_string())?;
        if !path.starts_with(&root) {
            return Err("private local CLI artifact escaped its run root".to_string());
        }
        let bytes = std::fs::read(&path)
            .map_err(|_| "failed to read private local CLI artifact".to_string())?;
        Ok(Self {
            path,
            root,
            digest: Sha256::digest(bytes).into(),
        })
    }

    pub(crate) fn verify_unchanged(&self) -> Result<(), String> {
        let current = Self::capture(&self.path, &self.root)
            .map_err(|_| "private local CLI artifact changed during preparation".to_string())?;
        if current.path != self.path || current.digest != self.digest {
            return Err("private local CLI artifact changed during preparation".to_string());
        }
        Ok(())
    }
}

impl FrozenProcessSpec {
    pub(crate) fn capture(command: &Command) -> Result<Self, String> {
        let command = command.as_std();
        let cwd = command
            .get_current_dir()
            .map(Path::to_path_buf)
            .ok_or_else(|| "local CLI process cwd was not frozen".to_string())?;
        let environment: Vec<_> = command
            .get_envs()
            .filter_map(|(name, value)| {
                value.map(|value| (name.to_os_string(), value.to_os_string()))
            })
            .collect();
        let redactions = environment
            .iter()
            .filter(|(name, _)| sensitive_environment_name(name))
            .filter_map(|(_, value)| secret_redaction(value.to_string_lossy().as_ref()))
            .collect();
        Ok(Self {
            executable: command.get_program().to_os_string(),
            args: command.get_args().map(OsString::from).collect(),
            cwd,
            environment,
            redactions,
        })
    }

    /// Adds a secret stored in a private config file rather than the child
    /// environment. It is retained only for in-memory stderr redaction.
    pub(crate) fn redact_value(mut self, value: &str) -> Self {
        if let Some(value) = secret_redaction(value) {
            if !self.redactions.contains(&value) {
                self.redactions.push(value);
            }
        }
        self
    }

    fn into_command(self) -> (Command, Vec<String>) {
        let mut command = Command::new(self.executable);
        command
            .args(self.args)
            .current_dir(self.cwd)
            .env_clear()
            .envs(self.environment);
        (command, self.redactions)
    }
}

fn sensitive_environment_name(name: &OsString) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    [
        "API_KEY",
        "APIKEY",
        "TOKEN",
        "PASSWORD",
        "SECRET",
        "CREDENTIAL",
        "AUTHORIZATION",
        "BEARER",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

fn secret_redaction(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() >= 8).then(|| value.to_string())
}

/// Owns one CLI process tree, terminal stderr classification, and shutdown.
/// Provider adapters keep only their stdin encoding and stdout parsing.
pub(crate) struct RunSupervisor {
    child: Arc<tokio::sync::Mutex<Box<dyn ChildWrapper>>>,
    stderr_capture: Arc<StderrCapture>,
    stderr_task: tauri::async_runtime::JoinHandle<()>,
    tree_guard: ProcessTreeGuard,
    authority_lifetime: CancellationToken,
}

pub(crate) struct SupervisedProcess {
    pub(crate) supervisor: RunSupervisor,
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: ChildStdout,
}

impl RunSupervisor {
    pub(crate) fn spawn(
        spec: FrozenProcessSpec,
        authority_lifetime: CancellationToken,
    ) -> Result<SupervisedProcess, String> {
        let (command, redactions) = spec.into_command();
        let process = spawn_wrapped(command)?;
        let (stderr_capture, stderr_task) =
            spawn_stderr_drain_with_redactions(process.stderr, redactions);
        Ok(SupervisedProcess {
            supervisor: Self {
                child: process.child,
                stderr_capture,
                stderr_task,
                tree_guard: process.tree_guard,
                authority_lifetime,
            },
            stdin: process.stdin,
            stdout: process.stdout,
        })
    }

    pub(crate) async fn monitor<F, T, E>(&self, future: F) -> Result<T, AdapterError>
    where
        F: std::future::Future<Output = Result<T, E>>,
        E: Into<AdapterError>,
    {
        let terminal = self.stderr_capture.terminal_signal.clone();
        tokio::select! {
            result = future => result.map_err(Into::into),
            _ = terminal.cancelled() => Err(provider_error(
                "local CLI tool call was rejected",
                &self.stderr_capture,
            )),
        }
    }

    pub(crate) async fn finish(
        self,
        run_result: Result<ProtocolOutcome, AdapterError>,
        failure_context: &str,
    ) -> Result<ProtocolOutcome, AdapterError> {
        // The Provider transcript is terminal now. Close the same run token
        // used by the Host Tool Authority before the first asynchronous
        // shutdown wait, so a lingering headless CLI cannot start a late tool
        // call after reporting success or failure.
        self.authority_lifetime.cancel();
        let should_terminate = run_result
            .as_ref()
            .map(|outcome| outcome.aborted)
            .unwrap_or(true);
        if should_terminate {
            let _ = terminate(&self.child).await;
        }
        let process_result = finish_process(self.child, self.stderr_task, self.tree_guard).await;
        if self.stderr_capture.safe_hint() == Some("approval") {
            return Err(provider_error(failure_context, &self.stderr_capture));
        }
        match run_result {
            Err(error) => {
                // A stderr category is more specific than the protocol error;
                // otherwise keep whatever code the adapter already attached.
                let mut wrapped = provider_error(&error.message, &self.stderr_capture);
                wrapped.code = wrapped.code.or(error.code);
                Err(wrapped)
            }
            Ok(outcome) if outcome.aborted => Ok(outcome),
            Ok(outcome) => match process_result {
                Ok(Some(status)) if status.success() => Ok(outcome),
                Ok(_) => Err(provider_error(failure_context, &self.stderr_capture)),
                Err(error)
                    if error == "local CLI process timed out during shutdown"
                        && matches!(self.stderr_capture.safe_hint(), None | Some("other")) =>
                {
                    // A verified terminal protocol event is authoritative. A
                    // headless CLI may keep its MCP transport alive after that
                    // event; finish_process has already killed and reaped the
                    // process tree, so this is successful bounded cleanup.
                    Ok(outcome)
                }
                Err(error) => Err(provider_error(&error, &self.stderr_capture)),
            },
        }
    }
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

pub(crate) struct StderrCapture {
    saw_output: AtomicBool,
    safe_category: AtomicU8,
    terminal_signal: CancellationToken,
    tail: Mutex<Vec<u8>>,
    redactions: Vec<String>,
}

impl Default for StderrCapture {
    fn default() -> Self {
        Self::with_redactions(Vec::new())
    }
}

impl StderrCapture {
    fn with_redactions(redactions: Vec<String>) -> Self {
        Self {
            saw_output: AtomicBool::new(false),
            safe_category: AtomicU8::new(0),
            terminal_signal: CancellationToken::new(),
            tail: Mutex::new(Vec::new()),
            redactions,
        }
    }

    fn record(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.saw_output.store(true, Ordering::Relaxed);
        let text = String::from_utf8_lossy(bytes);
        let category = classify_stderr_category(&text);
        let sanitized = sanitize_stderr_text(&text, &self.redactions).into_bytes();
        let combined_category = self.tail.lock().ok().map(|mut tail| {
            if sanitized.len() >= MAX_STDERR_TAIL_BYTES {
                tail.clear();
                tail.extend_from_slice(&sanitized[sanitized.len() - MAX_STDERR_TAIL_BYTES..]);
            } else {
                let overflow = tail
                    .len()
                    .saturating_add(sanitized.len())
                    .saturating_sub(MAX_STDERR_TAIL_BYTES);
                if overflow > 0 {
                    let tail_len = tail.len();
                    tail.drain(..overflow.min(tail_len));
                }
                tail.extend_from_slice(&sanitized);
            }
            classify_stderr_category(&String::from_utf8_lossy(&tail))
        });
        self.record_category(category);
        if let Some(category) = combined_category {
            self.record_category(category);
        }
    }

    fn record_category(&self, category: u8) {
        if category == 5 {
            self.safe_category.store(category, Ordering::Relaxed);
            self.terminal_signal.cancel();
            return;
        }
        let current = self.safe_category.load(Ordering::Relaxed);
        if current == 0 || current == 6 {
            self.safe_category.store(category, Ordering::Relaxed);
        }
    }

    fn safe_hint(&self) -> Option<&'static str> {
        match self.safe_category.load(Ordering::Relaxed) {
            1 => Some("credential"),
            2 => Some("model"),
            3 => Some("session"),
            4 => Some("rateLimit"),
            5 => Some("approval"),
            6 => Some("other"),
            _ if self.saw_output.load(Ordering::Relaxed) => Some("other"),
            _ => None,
        }
    }

    #[cfg(test)]
    fn redacted_tail(&self) -> String {
        let tail = self
            .tail
            .lock()
            .map(|tail| tail.clone())
            .unwrap_or_default();
        String::from_utf8_lossy(&tail).to_string()
    }
}

fn classify_stderr_category(text: &str) -> u8 {
    let text = text.to_ascii_lowercase();
    if [
        "approval policy is never",
        "requires approval",
        "approval required",
        "approval was rejected",
        "permission denied",
        "permission to use",
        "not authorized",
        "user cancelled mcp tool call",
        "user canceled mcp tool call",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        5
    } else if [
        "unauthorized",
        "authentication",
        "invalid api key",
        "credential",
        "login required",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        1
    } else if ["model not found", "unknown model", "invalid model"]
        .iter()
        .any(|needle| text.contains(needle))
    {
        2
    } else if [
        "session not found",
        "thread not found",
        "conversation not found",
        "invalid session",
        "expired session",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        3
    } else if text.contains("rate limit") || text.contains("too many requests") {
        4
    } else {
        6
    }
}

fn sanitize_stderr_text(text: &str, redactions: &[String]) -> String {
    let home = std::env::var("HOME").ok().filter(|value| !value.is_empty());
    let text = redactions.iter().fold(text.to_string(), |text, secret| {
        text.replace(secret, "[redacted]")
    });
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "api_key",
                "api-key",
                "authorization",
                "bearer ",
                "token=",
                "secret",
                "password",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
            {
                "[redacted sensitive stderr line]".to_string()
            } else if let Some(home) = &home {
                line.replace(home, "$HOME")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn spawn_stderr_drain(
    stderr: ChildStderr,
) -> (Arc<StderrCapture>, tauri::async_runtime::JoinHandle<()>) {
    spawn_stderr_drain_with_redactions(stderr, Vec::new())
}

fn spawn_stderr_drain_with_redactions(
    mut stderr: ChildStderr,
    redactions: Vec<String>,
) -> (Arc<StderrCapture>, tauri::async_runtime::JoinHandle<()>) {
    let capture = Arc::new(StderrCapture::with_redactions(redactions));
    let stderr_capture = capture.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(bytes) => {
                    stderr_capture.record(&buffer[..bytes]);
                }
            }
        }
    });
    (capture, task)
}

pub(crate) fn provider_error(context: &str, stderr: &StderrCapture) -> AdapterError {
    match stderr.safe_hint() {
        Some("credential") => AdapterError::coded(
            LocalCliFailureCode::CredentialRejected,
            format!("{context}; CLI credentials were rejected"),
        ),
        Some("model") => AdapterError::coded(
            LocalCliFailureCode::ModelRejected,
            format!("{context}; CLI model selection was rejected"),
        ),
        Some("session") => AdapterError::coded(
            LocalCliFailureCode::SessionUnavailable,
            format!("{context}; CLI session is unavailable"),
        ),
        Some("rateLimit") => AdapterError::coded(
            LocalCliFailureCode::ProcessExit,
            format!("{context}; CLI rate limit was reached"),
        ),
        Some("approval") => AdapterError::coded(
            LocalCliFailureCode::ProviderApprovalRejected,
            format!("{context}; provider approval rejected the tool call"),
        ),
        Some(_) => format!("{context}; CLI stderr was redacted").into(),
        None => context.to_string().into(),
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
    command_output_capped_with_env(executable, args, &[], timeout, max_output_bytes).await
}

pub(crate) async fn command_output_capped_with_env(
    executable: &Path,
    args: &[&str],
    environment: &[(String, String)],
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(executable);
    apply_minimal_environment(&mut command);
    command.args(args).envs(environment.iter().cloned());
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
    tree_guard: ProcessTreeGuard,
) -> Result<Option<std::process::ExitStatus>, String> {
    finish_process_with_timeout(child, stderr_task, tree_guard, SHUTDOWN_TIMEOUT).await
}

async fn finish_process_with_timeout(
    child: Arc<tokio::sync::Mutex<Box<dyn ChildWrapper>>>,
    mut stderr_task: tauri::async_runtime::JoinHandle<()>,
    mut tree_guard: ProcessTreeGuard,
    shutdown_timeout: Duration,
) -> Result<Option<std::process::ExitStatus>, String> {
    let waited = {
        let mut child = child.lock().await;
        tokio::time::timeout(shutdown_timeout, child.wait()).await
    };
    let result = match waited {
        Ok(Ok(status)) => {
            tree_guard.cleanup();
            Ok(Some(status))
        }
        Ok(Err(_)) => {
            let _ = terminate(&child).await;
            tree_guard.cleanup();
            Err("failed to wait for local CLI process".to_string())
        }
        Err(_) => {
            let _ = terminate(&child).await;
            tree_guard.cleanup();
            Err("local CLI process timed out during shutdown".to_string())
        }
    };
    if tokio::time::timeout(Duration::from_millis(250), &mut stderr_task)
        .await
        .is_err()
    {
        stderr_task.abort();
        let _ = stderr_task.await;
    }
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

pub(crate) fn contains_capability_semantics(value: &Value) -> bool {
    fn contains_capability_marker(value: &str) -> bool {
        let value = value.to_ascii_lowercase();
        [
            "tool",
            "call",
            "write",
            "command",
            "permission",
            "approval",
            "request",
        ]
        .iter()
        .any(|marker| value.contains(marker))
    }

    fn capability_key(key: &str) -> bool {
        contains_capability_marker(key) || key.eq_ignore_ascii_case("capability")
    }

    fn semantic_descriptor_key(key: &str) -> bool {
        let normalized = key
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        matches!(
            normalized.as_str(),
            "type"
                | "event"
                | "eventtype"
                | "kind"
                | "subtype"
                | "capability"
                | "action"
                | "method"
                | "operation"
                | "status"
        )
    }

    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            capability_key(key)
                || match nested {
                    Value::String(text) if semantic_descriptor_key(key) => {
                        contains_capability_marker(text)
                    }
                    _ => contains_capability_semantics(nested),
                }
        }),
        Value::Array(values) => values.iter().any(contains_capability_semantics),
        _ => false,
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

    fn compile_fake_cli() -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("open-builder-fake-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            "open-builder-fake-cli.exe"
        } else {
            "open-builder-fake-cli"
        });
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_local_cli.rs");
        let output = std::process::Command::new("rustc")
            .arg("--edition=2021")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("rustc must compile the portable fake CLI");
        assert!(
            output.status.success(),
            "fake CLI compilation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        (root, executable)
    }

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

    #[tokio::test]
    async fn portable_fake_cli_proves_spawn_stdin_fragmented_stdout_and_redaction() {
        let (root, executable) = compile_fake_cli();
        let run_dir = root.join("run directory with spaces");
        std::fs::create_dir(&run_dir).unwrap();
        let log_path = root.join("invocation.log");
        let mut command = Command::new(&executable);
        apply_minimal_environment(&mut command);
        command
            .arg("exec")
            .arg("--json")
            .current_dir(&run_dir)
            .env("OPEN_BUILDER_FAKE_LOG", &log_path)
            .env("OPEN_BUILDER_FAKE_MODE", "success");
        let process = spawn_wrapped(command).expect("fake CLI must spawn");
        let child = process.child.clone();
        let (stderr_capture, stderr_task) = spawn_stderr_drain(process.stderr);
        let mut stdin = process.stdin;
        let mut stdout = BufReader::new(process.stdout);
        let tree_guard = process.tree_guard;

        stdin
            .write_all(b"complete prompt from stdin\n")
            .await
            .unwrap();
        stdin.shutdown().await.unwrap();
        drop(stdin);
        let first = read_capped_line(&mut stdout).await.unwrap().unwrap();
        let second = read_capped_line(&mut stdout).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&first).unwrap()["thread_id"],
            "fake-thread"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&second).unwrap()["type"],
            "turn.completed"
        );
        let status = finish_process(child, stderr_task, tree_guard)
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());

        let invocation = std::fs::read_to_string(&log_path).unwrap();
        assert!(invocation.contains("args=exec\u{1f}--json"));
        assert!(invocation.contains("stdin=complete prompt from stdin"));
        let canonical_run_dir = std::fs::canonicalize(&run_dir).unwrap();
        assert!(invocation.contains(&format!("cwd={}", canonical_run_dir.display())));
        let safe = provider_error("fake CLI exited", &stderr_capture);
        assert_eq!(safe.code, None);
        assert!(!safe.message.contains("secret-stderr-sentinel"));
        assert!(!stderr_capture
            .redacted_tail()
            .contains("secret-stderr-sentinel"));

        let mut failing = Command::new(&executable);
        apply_minimal_environment(&mut failing);
        failing
            .current_dir(&run_dir)
            .env("OPEN_BUILDER_FAKE_MODE", "nonzero");
        let failing = spawn_wrapped(failing).expect("failing fake CLI must spawn");
        let failing_child = failing.child.clone();
        let (_stderr_capture, stderr_task) = spawn_stderr_drain(failing.stderr);
        let _failing_stdout = failing.stdout;
        drop(failing.stdin);
        let failing_status = finish_process(failing_child, stderr_task, failing.tree_guard)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(failing_status.code(), Some(17));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn portable_fake_cli_covers_input_malformed_and_line_limit_failures() {
        let (root, executable) = compile_fake_cli();

        let mut closed_command = Command::new(&executable);
        apply_minimal_environment(&mut closed_command);
        closed_command.env("OPEN_BUILDER_FAKE_MODE", "close-stdin");
        let mut closed = spawn_wrapped(closed_command).expect("fake CLI must spawn");
        closed.child.lock().await.wait().await.unwrap();
        assert!(closed.stdin.write_all(b"prompt").await.is_err());
        drop(closed.tree_guard);
        drop(closed.stdout);
        drop(closed.stderr);

        let mut malformed_command = Command::new(&executable);
        apply_minimal_environment(&mut malformed_command);
        malformed_command.env("OPEN_BUILDER_FAKE_MODE", "malformed");
        let malformed = spawn_wrapped(malformed_command).expect("fake CLI must spawn");
        let malformed_child = malformed.child.clone();
        let (_stderr_capture, malformed_stderr_task) = spawn_stderr_drain(malformed.stderr);
        drop(malformed.stdin);
        let mut malformed_stdout = BufReader::new(malformed.stdout);
        let line = read_capped_line(&mut malformed_stdout)
            .await
            .unwrap()
            .unwrap();
        assert!(serde_json::from_str::<Value>(&line).is_err());
        finish_process(malformed_child, malformed_stderr_task, malformed.tree_guard)
            .await
            .unwrap();

        let mut oversized_command = Command::new(&executable);
        apply_minimal_environment(&mut oversized_command);
        oversized_command.env("OPEN_BUILDER_FAKE_MODE", "oversized");
        let oversized = spawn_wrapped(oversized_command).expect("fake CLI must spawn");
        let oversized_child = oversized.child.clone();
        let (_stderr_capture, oversized_stderr_task) = spawn_stderr_drain(oversized.stderr);
        drop(oversized.stdin);
        let mut oversized_stdout = BufReader::new(oversized.stdout);
        let error = read_capped_line(&mut oversized_stdout)
            .await
            .expect_err("oversized fake output must be rejected");
        assert!(error.contains("line limit"));
        drop(oversized_stdout);
        finish_process(oversized_child, oversized_stderr_task, oversized.tree_guard)
            .await
            .unwrap();

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shutdown_timeout_is_reported_as_failure_and_kills_the_process() {
        let (root, executable) = compile_fake_cli();
        let mut command = Command::new(&executable);
        apply_minimal_environment(&mut command);
        command.env("OPEN_BUILDER_FAKE_MODE", "wait");
        let process = spawn_wrapped(command).expect("hanging fake CLI must spawn");
        let child = process.child.clone();
        let process_id = child.lock().await.id();
        let (_stderr_capture, stderr_task) = spawn_stderr_drain(process.stderr);
        drop(process.stdin);
        drop(process.stdout);

        let error = finish_process_with_timeout(
            child,
            stderr_task,
            process.tree_guard,
            Duration::from_millis(50),
        )
        .await
        .expect_err("shutdown timeout must not be treated as success");
        assert!(error.contains("timed out"));

        #[cfg(unix)]
        if let Some(process_id) = process_id {
            let still_running = unsafe { libc::kill(process_id as i32, 0) == 0 };
            assert!(
                !still_running,
                "timed-out fake CLI process survived cleanup"
            );
        }
        let _ = std::fs::remove_dir_all(root);
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

    #[test]
    fn capability_semantics_include_descriptor_values_but_not_user_text() {
        for value in [
            serde_json::json!({"eventType":"mcp_tool_call"}),
            serde_json::json!({"kind":"permission_request"}),
            serde_json::json!({"status":"approval_required"}),
            serde_json::json!({"capability":"write"}),
        ] {
            assert!(contains_capability_semantics(&value), "{value}");
        }
        for value in [
            serde_json::json!({"type":"telemetry","status":"completed"}),
            serde_json::json!({"type":"agent_message","text":"I can write a summary"}),
        ] {
            assert!(!contains_capability_semantics(&value), "{value}");
        }
    }

    #[test]
    fn prepared_private_file_rejects_tampering_and_symlinks() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-private-artifact-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("config.json");
        std::fs::write(&path, b"first").unwrap();
        let artifact = PreparedPrivateFile::capture(&path, &root).unwrap();
        artifact.verify_unchanged().unwrap();
        std::fs::write(&path, b"second").unwrap();
        assert!(artifact.verify_unchanged().is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = root.join("target.json");
            let link = root.join("link.json");
            std::fs::write(&target, b"target").unwrap();
            symlink(&target, &link).unwrap();
            assert!(PreparedPrivateFile::capture(&link, &root).is_err());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stderr_capture_is_bounded_redacted_and_only_exposes_safe_hints() {
        let capture = StderrCapture::default();
        capture.record(&vec![b'x'; MAX_STDERR_TAIL_BYTES + 32]);
        assert_eq!(capture.tail.lock().unwrap().len(), MAX_STDERR_TAIL_BYTES);

        capture.record(b"\nAuthorization: Bearer secret-sentinel\n");
        let redacted = capture.redacted_tail();
        assert!(!redacted.contains("secret-sentinel"));
        assert!(redacted.contains("[redacted sensitive stderr line]"));
        assert_eq!(
            provider_error("CLI exited unsuccessfully", &capture).message,
            "CLI exited unsuccessfully; CLI stderr was redacted"
        );

        let credential = StderrCapture::default();
        credential.record(b"authentication failed: invalid API key secret-sentinel");
        let error = provider_error("CLI exited unsuccessfully", &credential);
        assert_eq!(error.code, Some(LocalCliFailureCode::CredentialRejected));
        assert_eq!(
            error.message,
            "CLI exited unsuccessfully; CLI credentials were rejected"
        );
        assert!(!error.message.contains("secret-sentinel"));

        let rate_limit = StderrCapture::default();
        rate_limit.record(b"too many requests: rate limit reached");
        let rate_limit_error = provider_error("CLI exited unsuccessfully", &rate_limit);
        assert_eq!(
            rate_limit_error.code,
            Some(LocalCliFailureCode::ProcessExit)
        );
        assert_eq!(
            rate_limit_error.message,
            "CLI exited unsuccessfully; CLI rate limit was reached"
        );

        let opaque_secret = "opaque-bridge-value-123456";
        let explicit = StderrCapture::with_redactions(vec![opaque_secret.to_string()]);
        explicit.record(format!("provider echoed {opaque_secret}").as_bytes());
        assert!(!explicit.redacted_tail().contains(opaque_secret));
        assert!(explicit.redacted_tail().contains("[redacted]"));

        let approval = StderrCapture::default();
        approval.record(b"MCP tool call requires approval, but approval policy is never");
        assert_eq!(approval.safe_hint(), Some("approval"));
        assert!(approval.terminal_signal.is_cancelled());
        let approval_error = provider_error("Codex run failed", &approval);
        assert_eq!(
            approval_error.code,
            Some(LocalCliFailureCode::ProviderApprovalRejected)
        );
        assert_eq!(
            approval_error.message,
            "Codex run failed; provider approval rejected the tool call"
        );

        let fragmented = StderrCapture::default();
        fragmented.record(b"authentication warning before MCP approval pol");
        fragmented.record(b"icy is never");
        assert_eq!(fragmented.safe_hint(), Some("approval"));
        assert!(fragmented.terminal_signal.is_cancelled());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn frozen_process_and_supervisor_fail_fast_on_terminal_approval() {
        let cwd = std::env::temp_dir().join(format!(
            "open-builder-run-supervisor-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&cwd).unwrap();
        let mut command = Command::new("/bin/sh");
        apply_minimal_environment(&mut command);
        command
            .args([
                "-c",
                "printf '%s' \"$OPEN_BUILDER_FROZEN\"; printf '%s\\n' 'MCP tool call requires approval, but approval policy is never' >&2; sleep 30",
            ])
            .current_dir(&cwd)
            .env("OPEN_BUILDER_FROZEN", "captured");
        let spec = FrozenProcessSpec::capture(&command).unwrap();
        let authority_lifetime = CancellationToken::new();
        let process = RunSupervisor::spawn(spec, authority_lifetime.clone()).unwrap();
        let SupervisedProcess {
            supervisor,
            stdin: _,
            mut stdout,
        } = process;
        let monitored = supervisor.monitor(async move {
            let mut text = String::new();
            stdout
                .read_to_string(&mut text)
                .await
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(text)
        });
        let error = tokio::time::timeout(Duration::from_secs(2), monitored)
            .await
            .expect("terminal approval must not wait for the process timeout")
            .unwrap_err();
        assert!(error.message.contains("provider approval rejected"));
        let outcome = supervisor
            .finish(Err(error), "fixture failed")
            .await
            .unwrap_err();
        assert!(outcome.message.contains("provider approval rejected"));
        assert!(authority_lifetime.is_cancelled());
        let _ = std::fs::remove_dir_all(cwd);
    }

    #[tokio::test]
    async fn terminal_protocol_outcome_closes_host_authority_before_shutdown_wait() {
        let (root, executable) = compile_fake_cli();
        let mut command = Command::new(&executable);
        apply_minimal_environment(&mut command);
        command
            .current_dir(&root)
            .env("OPEN_BUILDER_FAKE_MODE", "delayed-exit");
        let spec = FrozenProcessSpec::capture(&command).unwrap();
        let authority_lifetime = CancellationToken::new();
        let process = RunSupervisor::spawn(spec, authority_lifetime.clone()).unwrap();
        drop(process.stdin);
        drop(process.stdout);
        let finish = process.supervisor.finish(
            Ok(ProtocolOutcome {
                session_id: Some("terminal-session".to_string()),
                aborted: false,
            }),
            "fixture failed",
        );
        tokio::pin!(finish);
        tokio::select! {
            biased;
            _ = authority_lifetime.cancelled() => {}
            result = &mut finish => panic!("shutdown completed before authority closed: {result:?}"),
        }
        assert!(!finish.await.unwrap().aborted);
        let _ = std::fs::remove_dir_all(root);
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
