use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

const FIREFOX_VERSION: &str = "156.0.1-beta.36";
const FIREFOX_EXECUTABLE_NAME: &str = if cfg!(windows) {
    "aliasmode.exe"
} else {
    "aliasmode"
};
const CHROMIUM_EXECUTABLE_NAME: &str = "Chromium";

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

/// Verify the Chromium 155 kernel the macOS app bundle ships under Resources/chromium/.
///
/// The packager stages `<version>/Chromium.app` and records the executable's SHA-256, so the
/// certificate that matters is the one measured after it was signed, not an upstream pin.
pub fn verify_chromium_resource(resource_dir: &Path) -> Result<ChromiumRuntime, String> {
    let metadata = embedded_metadata()?;
    let chromium = metadata
        .chromium
        .ok_or_else(|| "packaged Chromium metadata is missing".to_owned())?;
    let executable_path = Path::new(&chromium.executable);
    if chromium.version.is_empty()
        || chromium.version.contains(['/', '\\', ':'])
        || executable_path
            .file_name()
            .is_none_or(|name| name != CHROMIUM_EXECUTABLE_NAME)
        || !is_sha256(&chromium.sha256)
        || !is_sha256(&chromium.archive_sha256)
    {
        return Err("packaged Chromium metadata is not approved".to_owned());
    }
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
