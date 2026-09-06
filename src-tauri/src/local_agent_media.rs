use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::local_agent::{
    create_run_directory, resolve_executable, LocalAgentAvailability, LocalAgentPreference,
    LocalAgentProvider, LocalAgentState,
};
use crate::local_agent_adapter::{probe as probe_adapter, ResolvedAdapterProbe};
use crate::local_agent_models::LaunchValidation;
use crate::local_agent_runtime::{
    infer_failure_phase, AdapterError, InstallationIdentity, LocalCliFailure, LocalCliFailureCode,
    LocalCliFailurePhase, LocalCliRetryPolicy,
};

const MAX_ACTIVE_IMAGE_TASKS: usize = 4;
const MAX_IMAGE_TASK_DURATION: Duration = Duration::from_secs(10 * 60);
const MAX_TASK_ID_BYTES: usize = 256;
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_REFERENCE_COUNT: usize = 5;
const MAX_REFERENCE_BYTES: usize = 20 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES: usize = 40 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MEDIA_UNSUPPORTED: &str = "local CLI image generation is unsupported";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageReferenceInput {
    id: String,
    name: String,
    mime_type: String,
    data: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageGenerationRequest {
    task_id: String,
    provider: LocalAgentProvider,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
    #[serde(default)]
    references: Vec<LocalImageReferenceInput>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalGeneratedImage {
    id: String,
    mime_type: String,
    data: String,
    size: usize,
    sha256: String,
    revised_prompt: Option<String>,
    file_name: Option<String>,
}

pub(crate) struct PreparedLocalImageReference {
    pub(crate) path: PathBuf,
}

pub(crate) struct PreparedLocalImageRequest {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) prompt: String,
    pub(crate) references: Vec<PreparedLocalImageReference>,
    pub(crate) run_dir: PathBuf,
    pub(crate) cancellation: CancellationToken,
}

#[derive(Debug)]
pub(crate) struct GeneratedImageBytes {
    pub(crate) id: String,
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) revised_prompt: Option<String>,
    pub(crate) file_name: Option<String>,
}

pub(crate) struct ActiveImageTask {
    pub(crate) cancellation: CancellationToken,
    pub(crate) run_dir: PathBuf,
}

fn valid_opaque_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_TASK_ID_BYTES
        && !value.chars().any(char::is_control)
}

fn parse_task_authority_id(value: &str) -> Result<(&str, &str), String> {
    if !valid_opaque_id(value) {
        return Err("invalid local image task id".to_string());
    }
    let (run_id, call_id) = value
        .split_once(':')
        .ok_or_else(|| "invalid local image task id".to_string())?;
    if call_id.contains(':') {
        return Err("invalid local image task id".to_string());
    }
    let run_uuid =
        uuid::Uuid::parse_str(run_id).map_err(|_| "invalid local image task id".to_string())?;
    let call_uuid =
        uuid::Uuid::parse_str(call_id).map_err(|_| "invalid local image task id".to_string())?;
    if run_uuid.hyphenated().to_string() != run_id || call_uuid.hyphenated().to_string() != call_id
    {
        return Err("invalid local image task id".to_string());
    }
    Ok((run_id, call_id))
}

fn normalize_option(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn validate_request(request: &LocalImageGenerationRequest) -> Result<(), String> {
    parse_task_authority_id(&request.task_id)?;
    if request.prompt.trim().is_empty()
        || request.prompt.len() > MAX_PROMPT_BYTES
        || request.prompt.contains('\0')
    {
        return Err("invalid local image prompt".to_string());
    }
    for value in [request.model.as_deref(), request.effort.as_deref()]
        .into_iter()
        .flatten()
    {
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err("invalid local image model selection".to_string());
        }
    }
    if request.references.len() > MAX_REFERENCE_COUNT {
        return Err("too many local image references".to_string());
    }
    let mut ids = HashSet::new();
    let mut encoded_total = 0usize;
    for reference in &request.references {
        if !valid_opaque_id(&reference.id)
            || reference.name.is_empty()
            || reference.name.len() > 512
            || reference.name.chars().any(char::is_control)
            || !ids.insert(reference.id.as_str())
            || !matches!(
                reference.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            )
        {
            return Err("invalid local image reference metadata".to_string());
        }
        let max_encoded = MAX_REFERENCE_BYTES.div_ceil(3) * 4;
        if reference.data.is_empty() || reference.data.len() > max_encoded {
            return Err("local image reference exceeds the size limit".to_string());
        }
        encoded_total = encoded_total
            .checked_add(reference.data.len())
            .ok_or_else(|| "local image reference size overflowed".to_string())?;
    }
    if encoded_total > MAX_REFERENCE_TOTAL_BYTES.div_ceil(3) * 4 {
        return Err("local image references exceed the total size limit".to_string());
    }
    Ok(())
}

fn image_mime_type(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() >= 20
        && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && &bytes[12..16] == b"IHDR"
        && bytes.ends_with(b"\x00\x00\x00\x00IEND\xaeB`\x82")
    {
        return Ok("image/png");
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9])
    {
        return Ok("image/jpeg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if declared.checked_add(8) == Some(bytes.len()) {
            return Ok("image/webp");
        }
    }
    Err("local image bytes have an invalid or unsupported signature".to_string())
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => unreachable!("MIME type was validated before staging"),
    }
}

fn secure_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "failed to secure private local image reference".to_string())?;
    }
    Ok(())
}

fn stage_references(
    run_dir: &Path,
    references: &[LocalImageReferenceInput],
) -> Result<Vec<PreparedLocalImageReference>, String> {
    if references.is_empty() {
        return Ok(Vec::new());
    }
    let directory = run_dir.join("references");
    std::fs::create_dir(&directory)
        .map_err(|_| "failed to create private local image reference directory".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "failed to secure private local image reference directory".to_string())?;
    }

    let mut staged = Vec::with_capacity(references.len());
    let mut decoded_total = 0usize;
    for (index, reference) in references.iter().enumerate() {
        let bytes = BASE64
            .decode(reference.data.as_bytes())
            .map_err(|_| "local image reference is not valid base64".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_REFERENCE_BYTES {
            return Err("local image reference exceeds the size limit".to_string());
        }
        decoded_total = decoded_total
            .checked_add(bytes.len())
            .ok_or_else(|| "local image reference size overflowed".to_string())?;
        if decoded_total > MAX_REFERENCE_TOTAL_BYTES {
            return Err("local image references exceed the total size limit".to_string());
        }
        let detected = image_mime_type(&bytes)?;
        if detected != reference.mime_type {
            return Err("local image reference MIME type does not match its bytes".to_string());
        }
        let path = directory.join(format!(
            "reference-{index}.{}",
            extension_for_mime(detected)
        ));
        std::fs::write(&path, bytes)
            .map_err(|_| "failed to stage private local image reference".to_string())?;
        secure_file(&path)?;
        staged.push(PreparedLocalImageReference { path });
    }
    Ok(staged)
}

pub(crate) fn read_generated_image(
    run_dir: &Path,
    path: &Path,
) -> Result<(String, Vec<u8>, String), String> {
    let root = std::fs::canonicalize(run_dir)
        .map_err(|_| "failed to resolve local image task directory".to_string())?;
    let link_metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "generated local image file is unavailable".to_string())?;
    if link_metadata.file_type().is_symlink()
        || !link_metadata.is_file()
        || link_metadata.len() == 0
        || link_metadata.len() > MAX_GENERATED_IMAGE_BYTES as u64
    {
        return Err("generated local image file is invalid".to_string());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "failed to resolve generated local image file".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("generated local image escaped its private task directory".to_string());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&canonical)
        .map_err(|_| "failed to open generated local image file".to_string())?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| "failed to inspect generated local image file".to_string())?;
    if !opened_metadata.is_file()
        || opened_metadata.len() == 0
        || opened_metadata.len() > MAX_GENERATED_IMAGE_BYTES as u64
    {
        return Err("generated local image file is invalid".to_string());
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "failed to read generated local image file".to_string())?;
    if bytes.len() != opened_metadata.len() as usize {
        return Err("generated local image changed while it was read".to_string());
    }
    let mime_type = image_mime_type(&bytes)?.to_string();
    let expected_extension = extension_for_mime(&mime_type);
    let actual_extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension_matches = actual_extension == expected_extension
        || mime_type == "image/jpeg" && actual_extension == "jpeg";
    if !extension_matches {
        return Err("generated local image extension does not match its bytes".to_string());
    }
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "generated local image file name is invalid".to_string())?
        .to_string();
    if file_name.len() > 512 || file_name.chars().any(char::is_control) {
        return Err("generated local image file name is invalid".to_string());
    }
    Ok((mime_type, bytes, file_name))
}

fn encoded_image(image: GeneratedImageBytes) -> LocalGeneratedImage {
    let size = image.bytes.len();
    let sha256 = format!("{:x}", Sha256::digest(&image.bytes));
    LocalGeneratedImage {
        id: image.id,
        mime_type: image.mime_type,
        data: BASE64.encode(image.bytes),
        size,
        sha256,
        revised_prompt: image.revised_prompt,
        file_name: image.file_name,
    }
}

async fn generate_prepared(
    provider: LocalAgentProvider,
    executable: PathBuf,
    request: PreparedLocalImageRequest,
) -> Result<GeneratedImageBytes, AdapterError> {
    if request.cancellation.is_cancelled() {
        return Err(AdapterError::from("local image task cancelled"));
    }
    match provider {
        LocalAgentProvider::Codex => {
            crate::local_agent_codex::generate_image(executable, request).await
        }
        LocalAgentProvider::Antigravity if !request.references.is_empty() => {
            Err(AdapterError::coded(
                LocalCliFailureCode::CliUnsupported,
                "Antigravity local image editing is unsupported",
            ))
        }
        LocalAgentProvider::Antigravity => {
            crate::local_agent_antigravity::generate_image(executable, request).await
        }
        LocalAgentProvider::Claude | LocalAgentProvider::Pi => Err(MEDIA_UNSUPPORTED.into()),
    }
}

fn failure(
    provider: LocalAgentProvider,
    phase: LocalCliFailurePhase,
    error: &AdapterError,
    cancelled: bool,
) -> LocalCliFailure {
    if error.message == MEDIA_UNSUPPORTED || error.code == Some(LocalCliFailureCode::CliUnsupported)
    {
        let safe_message = if error.message.contains("editing") {
            "The selected local CLI does not support reference-image editing."
        } else {
            "The selected local CLI does not support image generation."
        };
        return LocalCliFailure::new(
            provider,
            LocalCliFailureCode::CliUnsupported,
            phase,
            safe_message,
            LocalCliRetryPolicy::Manual,
        );
    }
    LocalCliFailure::from_adapter(provider, phase, error, false, cancelled)
}

#[tauri::command]
pub async fn local_agent_generate_image(
    app: AppHandle,
    state: tauri::State<'_, LocalAgentState>,
    mut request: LocalImageGenerationRequest,
) -> Result<LocalGeneratedImage, LocalCliFailure> {
    let provider = request.provider;
    validate_request(&request).map_err(|_| {
        LocalCliFailure::new(
            provider,
            LocalCliFailureCode::SelectionRejected,
            LocalCliFailurePhase::Prepare,
            "The local image generation request is invalid.",
            LocalCliRetryPolicy::None,
        )
    })?;
    if !matches!(
        provider,
        LocalAgentProvider::Codex | LocalAgentProvider::Antigravity
    ) {
        return Err(LocalCliFailure::new(
            provider,
            LocalCliFailureCode::CliUnsupported,
            LocalCliFailurePhase::Prepare,
            "The selected local CLI does not support image generation.",
            LocalCliRetryPolicy::Manual,
        ));
    }
    let (run_id, call_id) = parse_task_authority_id(&request.task_id).map_err(|_| {
        LocalCliFailure::new(
            provider,
            LocalCliFailureCode::SelectionRejected,
            LocalCliFailurePhase::Tool,
            "The local image task is not authorized by an active generate_image tool call.",
            LocalCliRetryPolicy::None,
        )
    })?;
    let cancellation = state
        .claim_image_task_authority(run_id, call_id, provider)
        .map_err(|_| {
            LocalCliFailure::new(
                provider,
                LocalCliFailureCode::SelectionRejected,
                LocalCliFailurePhase::Tool,
                "The local image task is not authorized by an active generate_image tool call.",
                LocalCliRetryPolicy::None,
            )
        })?;
    let (executable, _) = resolve_executable(&app, provider)
        .map_err(|message| {
            LocalCliFailure::classified(
                provider,
                LocalCliFailurePhase::Inspect,
                &message,
                false,
                false,
            )
        })?
        .ok_or_else(|| {
            LocalCliFailure::new(
                provider,
                LocalCliFailureCode::ExecutableNotFound,
                LocalCliFailurePhase::Inspect,
                "The selected local CLI executable could not be found.",
                LocalCliRetryPolicy::Reprobe,
            )
        })?;
    state
        .ensure_stale_runs_cleaned(&app, provider)
        .map_err(|message| {
            LocalCliFailure::classified(
                provider,
                LocalCliFailurePhase::Prepare,
                &message,
                false,
                false,
            )
        })?;
    let run_dir = create_run_directory(&app, provider).map_err(|message| {
        LocalCliFailure::classified(
            provider,
            LocalCliFailurePhase::Prepare,
            &message,
            false,
            false,
        )
    })?;
    {
        let mut tasks = state.image_tasks.lock().map_err(|_| {
            LocalCliFailure::new(
                provider,
                LocalCliFailureCode::Internal,
                LocalCliFailurePhase::Prepare,
                "The local image task registry is unavailable.",
                LocalCliRetryPolicy::Manual,
            )
        })?;
        if tasks.len() >= MAX_ACTIVE_IMAGE_TASKS || tasks.contains_key(&request.task_id) {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(LocalCliFailure::new(
                provider,
                LocalCliFailureCode::RunAlreadyActive,
                LocalCliFailurePhase::Prepare,
                "This local image task is already active or the image task limit was reached.",
                LocalCliRetryPolicy::None,
            ));
        }
        tasks.insert(
            request.task_id.clone(),
            ActiveImageTask {
                cancellation: cancellation.clone(),
                run_dir: run_dir.clone(),
            },
        );
    }

    let task_id = request.task_id.clone();
    let work = async {
        let references = stage_references(&run_dir, &request.references)?;
        let installation = InstallationIdentity::capture(&executable)?;
        let preference = LocalAgentPreference {
            model: request.model.clone().unwrap_or_default(),
            effort: request.effort.clone().unwrap_or_default(),
        };
        let ResolvedAdapterProbe {
            probe,
            launch_validation,
            ..
        } = tokio::select! {
            _ = cancellation.cancelled() => return Err(AdapterError::from("local image task cancelled")),
            result = probe_adapter(
                provider,
                installation.canonical_path(),
                &state.model_strategy,
                preference,
                false,
            ) => result,
        };
        if probe.availability != LocalAgentAvailability::Ready {
            return Err(match probe.availability {
                LocalAgentAvailability::NeedsSetup => AdapterError::coded(
                    LocalCliFailureCode::SetupRequired,
                    "local CLI needs setup before image generation",
                ),
                LocalAgentAvailability::Unsupported => {
                    AdapterError::coded(LocalCliFailureCode::CliUnsupported, MEDIA_UNSUPPORTED)
                }
                _ => AdapterError::from("local CLI image preflight failed"),
            });
        }
        let actual = match launch_validation {
            LaunchValidation::Allowed { actual, .. } => actual,
            LaunchValidation::Rejected { message } => return Err(message.into()),
        };
        installation.verify_unchanged()?;
        request.model = normalize_option(actual.model);
        request.effort = normalize_option(actual.effort);
        generate_prepared(
            provider,
            installation.canonical_path().to_path_buf(),
            PreparedLocalImageRequest {
                model: request.model,
                effort: request.effort,
                prompt: request.prompt,
                references,
                run_dir: run_dir.clone(),
                cancellation: cancellation.clone(),
            },
        )
        .await
    };

    let mut result = match tokio::time::timeout(MAX_IMAGE_TASK_DURATION, work).await {
        Ok(result) => result,
        Err(_) => {
            cancellation.cancel();
            Err(AdapterError::coded(
                LocalCliFailureCode::Timeout,
                "local image task timed out",
            ))
        }
    };
    if cancellation.is_cancelled() && result.is_ok() {
        result = Err(AdapterError::from("local image task cancelled"));
    }
    if let Ok(mut tasks) = state.image_tasks.lock() {
        tasks.remove(&task_id);
    }
    let _ = std::fs::remove_dir_all(&run_dir);

    result.map(encoded_image).map_err(|error| {
        let phase = infer_failure_phase(&error.message, LocalCliFailurePhase::Stream);
        let cancelled =
            cancellation.is_cancelled() && error.code != Some(LocalCliFailureCode::Timeout);
        failure(provider, phase, &error, cancelled)
    })
}

#[tauri::command]
pub fn local_agent_cancel_image(
    state: tauri::State<'_, LocalAgentState>,
    task_id: String,
) -> Result<bool, String> {
    parse_task_authority_id(&task_id)?;
    let tasks = state
        .image_tasks
        .lock()
        .map_err(|_| "local image task lock poisoned".to_string())?;
    let Some(task) = tasks.get(&task_id) else {
        return Ok(false);
    };
    task.cancellation.cancel();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRpayload\x00\x00\x00\x00IEND\xaeB`\x82";

    fn request(data: String, mime_type: &str) -> LocalImageGenerationRequest {
        LocalImageGenerationRequest {
            task_id: "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002"
                .to_string(),
            provider: LocalAgentProvider::Codex,
            model: None,
            effort: None,
            prompt: "Draw a fox".to_string(),
            references: vec![LocalImageReferenceInput {
                id: "attachment-1".to_string(),
                name: "source.png".to_string(),
                mime_type: mime_type.to_string(),
                data,
            }],
        }
    }

    #[test]
    fn task_id_requires_exact_run_and_call_uuids() {
        assert!(parse_task_authority_id(
            "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002"
        )
        .is_ok());
        assert!(parse_task_authority_id("arbitrary-task").is_err());
        assert!(parse_task_authority_id(
            "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:extra"
        )
        .is_err());
    }

    #[test]
    fn reference_bytes_must_match_the_declared_supported_mime() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-media-reference-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let valid = request(BASE64.encode(PNG), "image/png");
        validate_request(&valid).unwrap();
        let staged = stage_references(&root, &valid.references).unwrap();
        assert_eq!(staged.len(), 1);
        assert!(staged[0].path.starts_with(root.join("references")));

        let mismatched = request(BASE64.encode(PNG), "image/webp");
        assert!(stage_references(&root, &mismatched.references).is_err());
        let malformed = request("not-base64".to_string(), "image/png");
        assert!(stage_references(&root, &malformed.references).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generated_images_cannot_escape_the_private_task_directory() {
        let root = std::env::temp_dir().join(format!(
            "open-builder-media-output-{}",
            uuid::Uuid::new_v4()
        ));
        let outside = std::env::temp_dir().join(format!(
            "open-builder-media-outside-{}.png",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let inside = root.join("generated.png");
        std::fs::write(&inside, PNG).unwrap();
        std::fs::write(&outside, PNG).unwrap();

        let (mime_type, bytes, file_name) = read_generated_image(&root, &inside).unwrap();
        assert_eq!(mime_type, "image/png");
        assert_eq!(bytes, PNG);
        assert_eq!(file_name, "generated.png");
        assert!(read_generated_image(&root, &outside).is_err());

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_file(outside).unwrap();
    }

    #[test]
    fn encoded_result_includes_digest_without_a_data_url_prefix() {
        let result = encoded_image(GeneratedImageBytes {
            id: "image-1".to_string(),
            mime_type: "image/png".to_string(),
            bytes: PNG.to_vec(),
            revised_prompt: Some("A fox".to_string()),
            file_name: Some("generated.png".to_string()),
        });
        assert_eq!(result.data, BASE64.encode(PNG));
        assert_eq!(result.size, PNG.len());
        assert_eq!(result.sha256.len(), 64);
    }
}
