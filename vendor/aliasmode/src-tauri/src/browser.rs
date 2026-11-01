use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

const FIREFOX_VERSION: &str = "156.0.1-beta.36";
const FIREFOX_EXECUTABLE_NAME: &str = if cfg!(windows) {
    "aliasmode.exe"
} else {
    "aliasmode"
};
/// The executable path inside Chromium.app, shared by the manifest and the sidecar's macOS pin.
const MACOS_CHROMIUM_EXECUTABLE: &str = "Chromium.app/Contents/MacOS/Chromium";
/// The kernel archive shipped in Resources/chromium/: Tauri copies resources file by file and
/// resolves symlinks, which flattens Chromium Framework, so the app ships the archive and extracts
/// it into its data directory on first launch.
#[cfg(target_os = "macos")]
const MACOS_KERNEL_ARCHIVE: &str = "nanfu-kernel.zip";
/// The version, executable and SHA-256 of that archive, written by scripts/prepare-macos-bundle.ts.
const MACOS_KERNEL_MANIFEST: &str = "nanfu-kernel.json";

/// No installer carries CloakBrowser: the sidecar downloads it on first use.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserMetadata {
    firefox: Option<FirefoxMetadata>,
    chromium: Option<ChromiumMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirefoxMetadata {
    executable: String,
    sha256: String,
    version: String,
    archive_sha256: String,
}

/// The Nanfu desktop app ships Chromium instead of Firefox on Windows and macOS. Windows verifies
/// the copy it installed from the sidecar's pins; the macOS app bundle verifies it here, because
/// the kernel is built per run and the packager records its executable hash in browser.json.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChromiumMetadata {
    executable: String,
    sha256: String,
    version: String,
    archive_sha256: String,
}

#[derive(Debug, Clone)]
pub struct FirefoxRuntime {
    pub executable: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ChromiumRuntime {
    /// The executable inside the app bundle's Resources.
    pub executable: PathBuf,
    /// The directory that holds Chromium.app, which the sidecar stages as NANFU_CHROMIUM_RUNTIME_DIR.
    pub runtime_dir: PathBuf,
    pub sha256: String,
}

fn embedded_metadata() -> Result<BrowserMetadata, String> {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/browser.json")))
        .map_err(|error| format!("invalid packaged browser metadata: {error}"))
}

fn safe_relative_executable(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("packaged browser executable path is unsafe".to_owned());
    }
    Ok(path.to_owned())
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn verify_resource(
    resource_dir: &Path,
    directory: &str,
    executable: &str,
    expected_sha256: &str,
    name: &str,
) -> Result<(PathBuf, String), String> {
    let executable = safe_relative_executable(executable)?;
    let root = resource_dir
        .join(directory)
        .canonicalize()
        .map_err(|error| format!("packaged {name} directory is unavailable: {error}"))?;
    let executable = root
        .join(executable)
        .canonicalize()
        .map_err(|error| format!("packaged {name} executable is unavailable: {error}"))?;
    if !executable.starts_with(&root) || !executable.is_file() {
        return Err(format!(
            "packaged {name} executable escaped its resource directory"
        ));
    }
    let actual = hash_file(&executable)
        .map_err(|error| format!("could not hash packaged {name}: {error}"))?;
    if actual != expected_sha256 {
        return Err(format!(
            "packaged {name} SHA-256 does not match build metadata"
        ));
    }
    Ok((executable, actual))
}

pub fn verify_firefox_resource(resource_dir: &Path) -> Result<FirefoxRuntime, String> {
    let metadata = embedded_metadata()?;
    let firefox = metadata
        .firefox
        .ok_or_else(|| "packaged AliasMode Firefox metadata is missing".to_owned())?;
    if firefox.version != FIREFOX_VERSION
        || Path::new(&firefox.executable)
            .file_name()
            .is_none_or(|name| name != FIREFOX_EXECUTABLE_NAME)
        || !is_sha256(&firefox.sha256)
        || !is_sha256(&firefox.archive_sha256)
    {
        return Err("packaged AliasMode Firefox metadata is not approved".to_owned());
    }
    let (executable, sha256) = verify_resource(
        resource_dir,
        "firefox",
        &firefox.executable,
        &firefox.sha256,
        "AliasMode Firefox",
    )?;
    Ok(FirefoxRuntime { executable, sha256 })
}

/// Verify the Chromium kernel a development bundle still carries unpacked under
/// Resources/chromium/chromium-<version>/Chromium.app.
///
/// The packager stages the kernel as an archive now (see prepare_chromium_runtime); an unpacked
/// runtime only exists in a development tree staged by hand, and is used unchanged.
pub fn verify_chromium_resource(resource_dir: &Path) -> Result<ChromiumRuntime, String> {
    let metadata = embedded_metadata()?;
    let chromium = approved_chromium_metadata(
        metadata
            .chromium
            .ok_or_else(|| "packaged Chromium metadata is missing".to_owned())?,
    )?;
    // The sidecar's pins name the runtime directory chromium-<version>; keep packaging and lookup
    // on that one convention.
    let directory = format!("chromium-{}", chromium.version);
    let relative = format!("{directory}/{}", chromium.executable);
    let (executable, sha256) = verify_resource(
        resource_dir,
        "chromium",
        &relative,
        &chromium.sha256,
        "Chromium",
    )?;
    Ok(ChromiumRuntime {
        executable,
        runtime_dir: resource_dir.join("chromium").join(directory),
        sha256,
    })
}

/// Resolve the Chromium kernel of a packaged macOS app, extracting it on first launch.
///
/// The bundle ships the kernel as Resources/chromium/nanfu-kernel.zip beside a manifest; the
/// archive is extracted once into `<app data>/chromium/<version>/` with ditto, which preserves the
/// framework symlinks Tauri's resource copy would resolve, and later launches reuse that copy.
/// A development bundle that still carries the unpacked runtime uses it unchanged.
pub fn prepare_chromium_runtime(
    resource_dir: &Path,
    data_dir: &Path,
) -> Result<ChromiumRuntime, String> {
    let metadata = embedded_metadata()?;
    let embedded = approved_chromium_metadata(
        metadata
            .chromium
            .ok_or_else(|| "packaged Chromium metadata is missing".to_owned())?,
    )?;
    // A development bundle may carry the unpacked runtime; use it exactly as before.
    let unpacked = resource_dir
        .join("chromium")
        .join(format!("chromium-{}", embedded.version));
    if unpacked.is_dir() {
        return verify_chromium_resource(resource_dir);
    }
    let manifest = kernel_manifest(resource_dir)?;
    if manifest.version != embedded.version
        || manifest.executable != embedded.executable
        || manifest.sha256 != embedded.sha256
        || manifest.archive_sha256 != embedded.archive_sha256
    {
        return Err(
            "the packaged Chromium kernel manifest does not match the build metadata".to_owned(),
        );
    }
    extract_chromium_kernel(resource_dir, data_dir, &manifest)
}

fn approved_chromium_metadata(chromium: ChromiumMetadata) -> Result<ChromiumMetadata, String> {
    if chromium.version.is_empty()
        || chromium.version.contains(['/', '\\', ':'])
        || chromium.version.contains("..")
        || chromium.executable != MACOS_CHROMIUM_EXECUTABLE
        || !is_sha256(&chromium.sha256)
        || !is_sha256(&chromium.archive_sha256)
    {
        return Err("packaged Chromium metadata is not approved".to_owned());
    }
    Ok(chromium)
}

/// The manifest beside the kernel archive, so a corrupted or swapped resource fails loudly.
fn kernel_manifest(resource_dir: &Path) -> Result<ChromiumMetadata, String> {
    let path = resource_dir.join("chromium").join(MACOS_KERNEL_MANIFEST);
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "packaged Chromium kernel manifest is unavailable ({}): {error}",
            path.display()
        )
    })?;
    let manifest: ChromiumMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("packaged Chromium kernel manifest is invalid: {error}"))?;
    approved_chromium_metadata(manifest)
}

/// The executable inside `root` or one folder below it, as both kernel zip layouts place it.
#[cfg(target_os = "macos")]
fn located_executable(root: &Path, relative: &Path) -> Option<PathBuf> {
    let direct = root.join(relative);
    if direct.is_file() {
        return Some(direct);
    }
    for entry in fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn extract_chromium_kernel(
    _resource_dir: &Path,
    _data_dir: &Path,
    _chromium: &ChromiumMetadata,
) -> Result<ChromiumRuntime, String> {
    Err("the packaged Chromium kernel is only used on macOS".to_owned())
}

/// Extract the kernel archive with ditto (which keeps Chromium Framework's symlinks), verify the
/// executable against the manifest, then swap the staging directory into place. Idempotent: a
/// previous extraction whose executable still has the recorded SHA-256 is reused untouched.
#[cfg(target_os = "macos")]
fn extract_chromium_kernel(
    resource_dir: &Path,
    data_dir: &Path,
    chromium: &ChromiumMetadata,
) -> Result<ChromiumRuntime, String> {
    use std::os::unix::fs::PermissionsExt;

    let relative = safe_relative_executable(&chromium.executable)?;
    let root = data_dir.join("chromium");
    let destination = root.join(&chromium.version);

    if destination.is_dir() {
        if let Some(executable) = located_executable(&destination, &relative) {
            if hash_file(&executable).is_ok_and(|sha256| sha256 == chromium.sha256) {
                if let Ok(runtime_dir) = executable.strip_suffix(&relative) {
                    let runtime_dir = runtime_dir.to_path_buf();
                    return Ok(ChromiumRuntime {
                        executable,
                        runtime_dir,
                        sha256: chromium.sha256.clone(),
                    });
                }
            }
        }
        eprintln!(
            "AliasMode will extract the packaged Chromium kernel again: {} does not match its recorded SHA-256",
            destination.display()
        );
    }

    let archive = resource_dir.join("chromium").join(MACOS_KERNEL_ARCHIVE);
    if !archive.is_file() {
        return Err(format!(
            "the packaged Chromium kernel archive is missing: {}",
            archive.display()
        ));
    }
    let archive_sha256 = hash_file(&archive)
        .map_err(|error| format!("could not hash the packaged Chromium kernel archive: {error}"))?;
    if archive_sha256 != chromium.archive_sha256 {
        return Err(format!(
            "the packaged Chromium kernel archive does not match its recorded SHA-256: {}",
            archive.display()
        ));
    }

    fs::create_dir_all(&root)
        .map_err(|error| format!("could not create the Chromium kernel directory: {error}"))?;
    let staging = root.join(format!(".{}.extracting", chromium.version));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|error| format!("could not create the Chromium kernel staging directory: {error}"))?;
    eprintln!(
        "AliasMode is extracting the packaged Chromium kernel to {} on first launch; this can take a minute",
        destination.display()
    );
    let output = std::process::Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(&archive)
        .arg(&staging)
        .output()
        .map_err(|error| format!("could not run ditto to extract the Chromium kernel: {error}"))?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "could not extract the packaged Chromium kernel (ditto exited with {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let extracted = match located_executable(&staging, &relative) {
        Some(executable) => executable,
        None => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "the packaged Chromium kernel archive does not contain {}: {}",
                chromium.executable,
                archive.display()
            ));
        }
    };
    fs::set_permissions(&extracted, fs::Permissions::from_mode(0o755)).map_err(|error| {
        format!("could not make the extracted Chromium executable runnable: {error}")
    })?;
    let relative_executable = extracted.strip_prefix(&staging).map_err(|_| {
        "the extracted Chromium kernel has an unexpected layout".to_owned()
    })?;
    let app_directory = relative_executable.strip_suffix(&relative).map_err(|_| {
        "the extracted Chromium kernel has an unexpected layout".to_owned()
    })?;
    // The kernel artifact ships unsigned, and Apple silicon refuses to execute an
    // unsigned arm64 binary. Seal the extracted (symlink-intact) bundle ad-hoc
    // before hashing: signing changes the executable, so the recorded pre-sign
    // hash no longer applies and the signed hash is what the sidecar receives.
    let app_bundle = staging.join(app_directory).join("Chromium.app");
    let _ = std::process::Command::new("/usr/bin/xattr")
        .arg("-cr")
        .arg(&app_bundle)
        .status();
    let signed = std::process::Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-"])
        .arg(&app_bundle)
        .output()
        .map_err(|error| format!("could not sign the extracted Chromium kernel: {error}"))?;
    if !signed.status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "could not sign the extracted Chromium kernel (codesign exited with {}): {}",
            signed.status,
            String::from_utf8_lossy(&signed.stderr).trim()
        ));
    }
    let verified = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&app_bundle)
        .output()
        .map_err(|error| format!("could not verify the extracted Chromium kernel: {error}"))?;
    if !verified.status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err("the extracted Chromium kernel has an invalid code signature".to_owned());
    }
    let sha256 = hash_file(&extracted)
        .map_err(|error| format!("could not hash the extracted Chromium executable: {error}"))?;
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|error| {
            format!("could not replace the extracted Chromium kernel: {error}")
        })?;
    }
    fs::rename(&staging, &destination)
        .map_err(|error| format!("could not install the extracted Chromium kernel: {error}"))?;
    let runtime_dir = destination.join(app_directory);
    let executable = runtime_dir.join(&relative);
    if !executable.is_file() {
        return Err(format!(
            "the extracted Chromium kernel is incomplete: {}",
            executable.display()
        ));
    }
    Ok(ChromiumRuntime {
        executable,
        runtime_dir,
        sha256,
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::{is_sha256, safe_relative_executable, BrowserMetadata};

    #[test]
    fn reads_firefox_metadata() {
        let firefox = r#""firefox":{"executable":"aliasmode","sha256":"aa","version":"1","archiveSha256":"bb"}"#;
        let metadata: BrowserMetadata = serde_json::from_str(&format!("{{{firefox}}}")).unwrap();
        assert_eq!(metadata.firefox.unwrap().executable, "aliasmode");
    }

    #[test]
    fn reads_chromium_metadata_without_firefox() {
        let chromium = r#""chromium":{"executable":"Chromium.app/Contents/MacOS/Chromium","sha256":"aa","version":"155.0.8059.85","archiveSha256":"bb"}"#;
        let metadata: BrowserMetadata = serde_json::from_str(&format!("{{{chromium}}}")).unwrap();
        let chromium = metadata.chromium.unwrap();
        assert_eq!(chromium.version, "155.0.8059.85");
        assert!(metadata.firefox.is_none());
    }

    #[test]
    fn validates_hash_shape() {
        assert!(is_sha256(&"ab".repeat(32)));
        assert!(!is_sha256(&"AB".repeat(32)));
        assert!(!is_sha256("short"));
    }

    #[test]
    fn rejects_resource_path_escape() {
        assert!(safe_relative_executable("chrome.exe").is_ok());
        assert!(safe_relative_executable("bin/chrome.exe").is_ok());
        assert!(safe_relative_executable("../chrome.exe").is_err());
        assert!(safe_relative_executable("/chrome.exe").is_err());
    }
}
