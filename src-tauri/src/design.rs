use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_PROJECT_FILES: usize = 1_000;
const MAX_PROJECT_BYTES: usize = 12 * 1024 * 1024;
const MAX_PROJECT_ASSETS: usize = 100;
const MAX_PROJECT_ASSET_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROJECT_ASSETS_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignProjectAssetInput {
    path: String,
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignExportResult {
    path: String,
    directory_name: String,
    file_count: usize,
}

fn safe_relative_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\0') || path.contains('\\') {
        return Err(format!("Unsafe project path: {path:?}"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(format!("Project path must be relative: {path:?}"));
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) if !part.is_empty() => normalized.push(part),
            _ => return Err(format!("Unsafe project path: {path:?}")),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(format!("Unsafe project path: {path:?}"));
    }
    Ok(normalized)
}

fn safe_directory_stem(value: &str) -> String {
    let mut stem = value
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, ' ' | '-' | '_'))
        .take(80)
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if stem.is_empty() {
        stem = "open-builder-project".to_string();
    }
    stem
}

fn create_unique_directory(parent: &Path, stem: &str) -> Result<(PathBuf, String), String> {
    for suffix in 1..=10_000 {
        let name = if suffix == 1 {
            stem.to_string()
        } else {
            format!("{stem}-{suffix}")
        };
        let path = parent.join(&name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok((path, name)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create export directory {}: {error}",
                    path.display()
                ))
            }
        }
    }
    Err("Could not allocate a unique export directory.".to_string())
}

fn validate_image_asset(asset: &DesignProjectAssetInput) -> Result<(), String> {
    let extension = Path::new(&asset.path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = &asset.bytes;
    let signature_matches = match asset.mime_type.as_str() {
        "image/png" => {
            matches!(extension.as_str(), "png")
                && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
        }
        "image/jpeg" => {
            matches!(extension.as_str(), "jpg" | "jpeg")
                && bytes.starts_with(&[0xff, 0xd8, 0xff])
                && bytes.ends_with(&[0xff, 0xd9])
        }
        "image/webp" => {
            matches!(extension.as_str(), "webp")
                && bytes.starts_with(b"RIFF")
                && bytes.get(8..12) == Some(b"WEBP")
        }
        _ => false,
    };
    if !signature_matches {
        return Err(format!(
            "Project asset {:?} does not match its declared image type.",
            asset.path
        ));
    }
    Ok(())
}

fn export_project_files(
    parent: &Path,
    project_name: &str,
    files: &BTreeMap<String, String>,
    assets: &[DesignProjectAssetInput],
) -> Result<DesignExportResult, String> {
    if !parent.is_dir() {
        return Err("The selected export parent is not a directory.".to_string());
    }
    if files.is_empty() || files.len() > MAX_PROJECT_FILES {
        return Err("Project export must contain between 1 and 1,000 files.".to_string());
    }
    let total_bytes = files
        .values()
        .try_fold(0usize, |total, content| total.checked_add(content.len()))
        .ok_or_else(|| "Project export size overflowed.".to_string())?;
    if total_bytes > MAX_PROJECT_BYTES {
        return Err("Project export exceeds the 12 MiB limit.".to_string());
    }
    if assets.len() > MAX_PROJECT_ASSETS {
        return Err(format!(
            "Project export contains too many assets (max {MAX_PROJECT_ASSETS})."
        ));
    }
    let asset_bytes = assets.iter().try_fold(0usize, |total, asset| {
        if asset.bytes.is_empty() || asset.bytes.len() > MAX_PROJECT_ASSET_BYTES {
            return Err(format!(
                "Project asset {:?} has an invalid size.",
                asset.path
            ));
        }
        total
            .checked_add(asset.bytes.len())
            .ok_or_else(|| "Project asset export size overflowed.".to_string())
    })?;
    if asset_bytes > MAX_PROJECT_ASSETS_BYTES {
        return Err(format!(
            "Project assets exceed the {MAX_PROJECT_ASSETS_BYTES} byte limit."
        ));
    }
    let validated = files
        .keys()
        .map(|path| safe_relative_path(path).map(|relative| (path, relative)))
        .collect::<Result<Vec<_>, _>>()?;
    let validated_assets = assets
        .iter()
        .map(|asset| {
            let relative = safe_relative_path(&asset.path)?;
            if files.contains_key(&asset.path) {
                return Err(format!(
                    "Project asset path conflicts with a text file: {:?}",
                    asset.path
                ));
            }
            validate_image_asset(asset)?;
            Ok((asset, relative))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let stem = safe_directory_stem(project_name);
    let (destination, directory_name) = create_unique_directory(parent, &stem)?;
    let write_result = (|| {
        for (source_path, relative) in validated {
            let output_path = destination.join(relative);
            if let Some(directory) = output_path.parent() {
                fs::create_dir_all(directory).map_err(|error| {
                    format!("Could not create {}: {error}", directory.display())
                })?;
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output_path)
                .map_err(|error| format!("Could not create {}: {error}", output_path.display()))?;
            output
                .write_all(files[source_path].as_bytes())
                .map_err(|error| format!("Could not write {}: {error}", output_path.display()))?;
        }
        for (asset, relative) in validated_assets {
            let output_path = destination.join(relative);
            if let Some(directory) = output_path.parent() {
                fs::create_dir_all(directory).map_err(|error| {
                    format!("Could not create {}: {error}", directory.display())
                })?;
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output_path)
                .map_err(|error| format!("Could not create {}: {error}", output_path.display()))?;
            output
                .write_all(&asset.bytes)
                .map_err(|error| format!("Could not write {}: {error}", output_path.display()))?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(DesignExportResult {
        path: destination.to_string_lossy().into_owned(),
        directory_name,
        file_count: files.len() + assets.len(),
    })
}

/// Exports the project into a new directory under a parent chosen in a native
/// folder dialog. The dialog runs here, on the host side, so the webview never
/// supplies a filesystem destination; a cancelled dialog yields `None`.
#[tauri::command]
pub async fn design_export_project(
    app: AppHandle,
    project_name: String,
    files: BTreeMap<String, String>,
    assets: Vec<DesignProjectAssetInput>,
) -> Result<Option<DesignExportResult>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |selected| {
        let _ = sender.send(selected);
    });
    let Some(selected) = receiver
        .await
        .map_err(|_| "export folder picker was cancelled".to_string())?
    else {
        return Ok(None);
    };
    let parent = selected
        .into_path()
        .map_err(|_| "selected export folder is invalid".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        export_project_files(&parent, &project_name, &files, &assets)
    })
    .await
    .map_err(|_| "project export task failed".to_string())?
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl TemporaryDirectory {
        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn temporary_directory() -> TemporaryDirectory {
        let path =
            std::env::temp_dir().join(format!("open-builder-design-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        TemporaryDirectory { path }
    }

    #[test]
    fn export_uses_unique_directories_without_overwriting() {
        let parent = temporary_directory();
        let existing = parent.path().join("Demo");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("keep.txt"), "untouched").unwrap();
        let files = BTreeMap::from([
            ("index.html".to_string(), "<main />".to_string()),
            ("src/app.ts".to_string(), "export {}".to_string()),
        ]);

        let first = export_project_files(parent.path(), "Demo", &files, &[]).unwrap();
        let second = export_project_files(parent.path(), "Demo", &files, &[]).unwrap();

        assert_eq!(first.directory_name, "Demo-2");
        assert_eq!(second.directory_name, "Demo-3");
        assert_eq!(
            fs::read_to_string(existing.join("keep.txt")).unwrap(),
            "untouched"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&first.path).join("src/app.ts")).unwrap(),
            "export {}"
        );
    }

    #[test]
    fn export_rejects_unsafe_paths_without_creating_a_project() {
        let parent = temporary_directory();
        let files = BTreeMap::from([("../escape.txt".to_string(), "no".to_string())]);
        assert!(export_project_files(parent.path(), "Unsafe", &files, &[]).is_err());
        assert!(!parent.path().join("Unsafe").exists());
    }

    #[test]
    fn export_writes_valid_image_assets_and_rejects_mismatched_signatures() {
        let parent = temporary_directory();
        let files = BTreeMap::from([("index.html".to_string(), "<main />".to_string())]);
        let png = DesignProjectAssetInput {
            path: "public/generated/hero.png".to_string(),
            mime_type: "image/png".to_string(),
            bytes: vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0],
        };

        let result = export_project_files(parent.path(), "Images", &files, &[png]).unwrap();
        assert_eq!(result.file_count, 2);
        assert_eq!(
            fs::read(Path::new(&result.path).join("public/generated/hero.png")).unwrap(),
            vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]
        );

        let invalid = DesignProjectAssetInput {
            path: "public/generated/fake.png".to_string(),
            mime_type: "image/png".to_string(),
            bytes: b"not a png".to_vec(),
        };
        assert!(export_project_files(parent.path(), "Invalid", &files, &[invalid]).is_err());
        assert!(!parent.path().join("Invalid").exists());
    }
}
