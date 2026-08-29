use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

use serde::Serialize;

const MAX_PROJECT_FILES: usize = 1_000;
const MAX_PROJECT_BYTES: usize = 12 * 1024 * 1024;

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

fn export_project_files(
    parent: &Path,
    project_name: &str,
    files: &BTreeMap<String, String>,
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
    let validated = files
        .keys()
        .map(|path| safe_relative_path(path).map(|relative| (path, relative)))
        .collect::<Result<Vec<_>, _>>()?;
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
        Ok::<(), String>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(DesignExportResult {
        path: destination.to_string_lossy().into_owned(),
        directory_name,
        file_count: files.len(),
    })
}

#[tauri::command]
pub fn design_export_project(
    parent_path: String,
    project_name: String,
    files: BTreeMap<String, String>,
) -> Result<DesignExportResult, String> {
    export_project_files(Path::new(&parent_path), &project_name, &files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "open-builder-design-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn export_uses_unique_directories_without_overwriting() {
        let parent = temporary_directory();
        let existing = parent.join("Demo");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("keep.txt"), "untouched").unwrap();
        let files = BTreeMap::from([
            ("index.html".to_string(), "<main />".to_string()),
            ("src/app.ts".to_string(), "export {}".to_string()),
        ]);

        let first = export_project_files(&parent, "Demo", &files).unwrap();
        let second = export_project_files(&parent, "Demo", &files).unwrap();

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
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn export_rejects_unsafe_paths_without_creating_a_project() {
        let parent = temporary_directory();
        let files = BTreeMap::from([("../escape.txt".to_string(), "no".to_string())]);
        assert!(export_project_files(&parent, "Unsafe", &files).is_err());
        assert!(!parent.join("Unsafe").exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
