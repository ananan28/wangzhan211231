use crate::{
    shutdown,
    sidecar::SidecarSupervisor,
    update_attempt::{self, InstallerHandoff, LastUpdateResult, UpdateFailureReason},
};
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const UPDATE_TARGET: &str = "windows-x86_64";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const UPDATE_TARGET: &str = "darwin-aarch64";
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const UPDATE_TARGET: &str = "darwin-x86_64";
#[cfg(target_os = "linux")]
const UPDATE_TARGET: &str = "linux-x86_64";

/// Nanfu serves one signed manifest per platform from its own download domain,
/// published by the build pipeline as `nanfu/update/<platform>/latest-v2.json`.
const UPDATE_HOST: &str = "dl.xzckfn.eu.cc";
const MAX_RELEASE_HIGHLIGHTS: usize = 3;

const UPDATE_BUSY: &str = "已有更新操作正在进行。";
const CHECK_FAILED: &str = "南孚浏览器无法检查更新，请稍后再试。";
const DOWNLOAD_FAILED: &str = "南孚浏览器下载或校验更新失败，请稍后再试。";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const INSTALLATION_UNSAFE: &str =
    "当前安装无法安全更新。请关闭南孚浏览器后从下载页运行完整安装包覆盖安装，不要卸载。";
#[cfg(target_os = "macos")]
const INSTALLATION_UNSAFE: &str =
    "当前副本无法更新。请将南孚浏览器移动到「应用程序」文件夹后再试，或重新运行安装命令。";
#[cfg(target_os = "linux")]
const INSTALLATION_UNSAFE: &str = "当前副本无法更新。请关闭南孚浏览器后重新运行安装命令。";
const CLEANUP_FAILED: &str = "更新未安装：无法安全关闭浏览器服务，当前版本保持不变。";
const INSTALL_FAILED: &str = "南孚浏览器无法启动已校验的更新，当前版本将重新启动。";

struct DiscoveredUpdate {
    update: Update,
    highlights: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state")]
pub enum UpdateStatus {
    #[serde(rename = "upToDate")]
    UpToDate {
        #[serde(rename = "currentVersion")]
        current_version: String,
    },
    #[serde(rename = "available")]
    Available {
        #[serde(rename = "currentVersion")]
        current_version: String,
        version: String,
        highlights: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateProgress {
    Preparing,
    Ready {
        version: String,
        highlights: Vec<String>,
    },
    Downloading {
        percent: Option<u8>,
    },
    Verifying,
    ClosingBrowsers,
    Installing,
}

#[derive(Default)]
pub struct UpdateCoordinator(Mutex<()>);

fn update_manifest_url() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let platform = "mac-arm";
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    let platform = "mac-intel";
    #[cfg(target_os = "linux")]
    let platform = "linux-x64";
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let platform = "win-x64";
    format!("https://{UPDATE_HOST}/nanfu/update/{platform}/latest-v2.json")
}

/// Release notes are curated `- ` bullets; the UI shows the first three.
fn nanfu_notes_highlights(body: Option<&str>) -> Vec<String> {
    let Some(body) = body else {
        return Vec::new();
    };
    body.lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("- ").map(str::trim))
        .filter(|line| !line.is_empty())
        .take(MAX_RELEASE_HIGHLIGHTS)
        .map(str::to_owned)
        .collect()
}

/// The installer the manifest points at must come from Nanfu's download domain
/// over HTTPS, with no credentials, port, query or fragment — so a tampered
/// manifest can never redirect the updater elsewhere.
fn is_nanfu_download_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(UPDATE_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn download_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((downloaded.saturating_mul(100) / total).min(100) as u8)
}

/// The plugin already parsed the manifest; double-check every field it will act
/// on so an inconsistent or foreign manifest is rejected before any download.
fn validate_nanfu_manifest(
    version: &str,
    target: &str,
    download_url: &Url,
    signature: &str,
    raw_json: &Value,
) -> Result<(), String> {
    let manifest_version = Version::parse(version).map_err(|error| error.to_string())?;
    if target != UPDATE_TARGET {
        return Err("更新清单不含本系统的更新".to_owned());
    }
    if !is_nanfu_download_url(download_url) {
        return Err("更新清单的安装包地址不是南孚官方下载地址".to_owned());
    }
    if signature.trim().is_empty() {
        return Err("更新清单签名缺失".to_owned());
    }

    let raw_version = raw_json
        .get("version")
        .and_then(Value::as_str)
        .and_then(|value| Version::parse(value.strip_prefix('v').unwrap_or(value)).ok())
        .ok_or_else(|| "更新清单版本无效".to_owned())?;
    let platforms = raw_json
        .get("platforms")
        .and_then(Value::as_object)
        .ok_or_else(|| "更新清单平台字段无效".to_owned())?;
    let platform = platforms
        .get(UPDATE_TARGET)
        .and_then(Value::as_object)
        .ok_or_else(|| "更新清单不含本系统的更新".to_owned())?;
    let raw_url = platform
        .get("url")
        .and_then(Value::as_str)
        .and_then(|value| Url::parse(value).ok())
        .ok_or_else(|| "更新清单安装包地址无效".to_owned())?;
    let raw_signature = platform
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if raw_version != manifest_version
        || platforms.len() != 1
        || raw_url != *download_url
        || raw_signature != signature
    {
        return Err("更新清单内容不一致".to_owned());
    }
    Ok(())
}

async fn discover_update(
    app: &AppHandle,
    handoff: Option<&InstallerHandoff>,
) -> Result<Option<DiscoveredUpdate>, String> {
    let builder = app
        .updater_builder()
        .target(UPDATE_TARGET)
        .no_proxy()
        .configure_client(|client| {
            client
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(30))
        });
    let builder = if let Some(handoff) = handoff {
        let app_handle = app.clone();
        let sidecar = app.state::<SidecarSupervisor>().inner().clone();
        builder
            .on_before_exit(move || {
                let _ = sidecar.kill_owned();
                app_handle.cleanup_before_exit();
            })
            .relaunch_args([handoff.relaunch_argument()])
            .clear_installer_args()
            .installer_args(handoff.installer_arguments())
    } else {
        builder
    };
    let updater = builder
        .endpoints(vec![update_manifest_url()])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    validate_nanfu_manifest(
        &update.version,
        &update.target,
        &update.download_url,
        &update.signature,
        &update.raw_json,
    )?;
    let highlights = nanfu_notes_highlights(update.body.as_deref());
    Ok(Some(DiscoveredUpdate { update, highlights }))
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    coordinator: tauri::State<'_, UpdateCoordinator>,
) -> Result<UpdateStatus, String> {
    if !cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        return Err("南孚浏览器暂不支持在此系统更新。".to_owned());
    }
    let _guard = coordinator
        .0
        .try_lock()
        .map_err(|_| UPDATE_BUSY.to_owned())?;
    let current_version = env!("CARGO_PKG_VERSION").to_owned();
    match discover_update(&app, None).await {
        Ok(Some(discovered)) => Ok(UpdateStatus::Available {
            current_version,
            version: discovered.update.version,
            highlights: discovered.highlights,
        }),
        Ok(None) => Ok(UpdateStatus::UpToDate { current_version }),
        Err(error) => {
            eprintln!("Nanfu update check failed: {error}");
            Err(CHECK_FAILED.to_owned())
        }
    }
}

#[tauri::command]
pub fn last_update_result(app: AppHandle) -> Result<Option<LastUpdateResult>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "南孚浏览器无法读取上一次更新结果。".to_owned())?;
    update_attempt::last_update_result(&data_dir)
        .map_err(|_| "南孚浏览器无法读取上一次更新结果。".to_owned())
}

fn restart_after_install_failure(app: AppHandle, error: impl std::fmt::Display) {
    eprintln!("Nanfu update installation failed: {error}");
    app.dialog()
        .message("南孚浏览器无法启动已校验的更新，当前版本将重新启动。")
        .title("南孚浏览器更新失败")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.request_restart());
}

fn record_update_failure(
    data_dir: &std::path::Path,
    attempt_id: &str,
    reason: UpdateFailureReason,
) {
    if update_attempt::record_failure(data_dir, attempt_id, reason).is_err() {
        eprintln!("Nanfu could not store the failed update result");
    }
}

/// Keeps the cause of a failed install step. The app writes its error text only to its
/// standard error, and that is lost when the app starts from the desktop.
fn log_install_failure(data_dir: &std::path::Path, version: &str, error: &str) {
    use std::io::Write;
    let logs = data_dir.join("logs");
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let written = std::fs::create_dir_all(&logs).and_then(|()| {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("desktop-update.log"))?;
        writeln!(
            file,
            "{seconds} update from {} to {version} failed at the install step: {error}",
            env!("CARGO_PKG_VERSION")
        )
    });
    if written.is_err() {
        eprintln!("Nanfu could not store the cause of the failed update");
    }
}

#[derive(Debug, PartialEq)]
enum UpdatePreparationError {
    Download(String),
    Prepare(String),
    Cleanup(String),
    Install(String),
}

async fn run_verified_update<Download, Prepare, Cleanup, Install>(
    download: Download,
    prepare: Prepare,
    cleanup: Cleanup,
    install: Install,
) -> Result<(), UpdatePreparationError>
where
    Download: std::future::Future<Output = Result<Vec<u8>, String>>,
    Prepare: std::future::Future<Output = Result<(), String>>,
    Cleanup: std::future::Future<Output = Result<(), String>>,
    Install: FnOnce(&[u8]) -> Result<(), String>,
{
    let bytes = download.await.map_err(UpdatePreparationError::Download)?;
    prepare.await.map_err(UpdatePreparationError::Prepare)?;
    cleanup.await.map_err(UpdatePreparationError::Cleanup)?;
    install(&bytes).map_err(UpdatePreparationError::Install)
}

/// Windows: the NSIS installer takes over and ends this process, so a return is a failure.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn install_verified_update(
    update: &Update,
    bytes: &[u8],
    _app: &AppHandle,
    _handoff: &InstallerHandoff,
) -> Result<(), String> {
    update.install(bytes).map_err(|error| error.to_string())?;
    Err("the verified installer returned without transferring control".to_owned())
}

/// macOS and Linux: the app bundle or folder is swapped and the call returns; nothing
/// restarts the app for us.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_verified_update(
    update: &Update,
    bytes: &[u8],
    app: &AppHandle,
    handoff: &InstallerHandoff,
) -> Result<(), String> {
    // Started first, so the relaunch still happens if this process dies during the swap.
    let mut relaunch =
        update_attempt::spawn_relaunch_after_exit(handoff).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let installed = update.install(bytes).map_err(|error| error.to_string());
    // The updater's own Linux step replaces an AppImage file; this app is a folder.
    #[cfg(target_os = "linux")]
    let installed = {
        let _ = update;
        update_attempt::replace_linux_install(&handoff.canonical_root, bytes)
            .map_err(|error| error.to_string())
    };
    if let Err(error) = installed {
        let _ = relaunch.kill();
        return Err(error);
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn update_now(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    coordinator: tauri::State<'_, UpdateCoordinator>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    if !cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        return Err("南孚浏览器暂不支持在此系统更新。".to_owned());
    }
    let _guard = coordinator
        .0
        .try_lock()
        .map_err(|_| UPDATE_BUSY.to_owned())?;
    let _ = on_progress.send(UpdateProgress::Preparing);
    let handoff = InstallerHandoff::prepare().map_err(|error| {
        eprintln!("Nanfu update install-root preparation failed: {error}");
        INSTALLATION_UNSAFE.to_owned()
    })?;
    let data_dir = app.path().app_data_dir().map_err(|_| {
        eprintln!("Nanfu update app-data path was unavailable");
        INSTALLATION_UNSAFE.to_owned()
    })?;
    let discovered = match discover_update(&app, cfg!(windows).then_some(&handoff)).await {
        Ok(Some(discovered)) => discovered,
        Ok(None) => return Err("南孚浏览器已是最新版本。".to_owned()),
        Err(error) => {
            eprintln!("Nanfu update recheck failed: {error}");
            return Err(CHECK_FAILED.to_owned());
        }
    };
    let _ = on_progress.send(UpdateProgress::Ready {
        version: discovered.update.version.clone(),
        highlights: discovered.highlights,
    });
    let update = discovered.update;
    let expected_version = update.version.clone();
    let sidecar = sidecar.inner().clone();
    let download_progress = on_progress.clone();
    let verifying_progress = on_progress.clone();
    let cleanup_progress = on_progress.clone();
    let install_progress = on_progress.clone();
    let install_window = window.clone();
    let preparation_handoff = handoff.clone();
    let install_handoff = handoff.clone();
    let install_app = app.clone();
    let preparation_data_dir = data_dir.clone();
    let preparation_version = expected_version.clone();
    match run_verified_update(
        async {
            let mut downloaded = 0_u64;
            let mut last_reported = None;
            update
                .download(
                    move |chunk_length, content_length| {
                        downloaded = downloaded.saturating_add(chunk_length as u64);
                        let percent = download_percent(downloaded, content_length);
                        if last_reported != Some(percent) {
                            let _ = download_progress.send(UpdateProgress::Downloading { percent });
                            last_reported = Some(percent);
                        }
                    },
                    move || {
                        let _ = verifying_progress.send(UpdateProgress::Verifying);
                    },
                )
                .await
                .map_err(|error| error.to_string())
        },
        async move {
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            update_attempt::validate_registered_install(
                &preparation_handoff,
                env!("CARGO_PKG_VERSION"),
            )
            .map_err(|error| error.to_string())?;
            update_attempt::begin_attempt(
                &preparation_data_dir,
                &preparation_handoff,
                env!("CARGO_PKG_VERSION"),
                &preparation_version,
            )
            .map_err(|error| error.to_string())
        },
        async {
            let _ = cleanup_progress.send(UpdateProgress::ClosingBrowsers);
            shutdown::graceful_sidecar_cleanup(&sidecar).await
        },
        |bytes| {
            let _ = install_progress.send(UpdateProgress::Installing);
            let _ = install_window.hide();
            install_verified_update(&update, bytes, &install_app, &install_handoff)
        },
    )
    .await
    {
        // macOS and Linux: the app is replaced and this process is exiting for the relaunch.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        Ok(()) => Ok(()),
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        Ok(()) => {
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::InstallerLaunch);
            let _ = window.show();
            let _ = window.set_focus();
            restart_after_install_failure(app, "the installer returned unexpectedly");
            Err(INSTALL_FAILED.to_owned())
        }
        Err(UpdatePreparationError::Download(error)) => {
            eprintln!("Nanfu update download or signature verification failed: {error}");
            Err(DOWNLOAD_FAILED.to_owned())
        }
        Err(UpdatePreparationError::Prepare(error)) => {
            eprintln!("Nanfu update install-root validation failed: {error}");
            Err(INSTALLATION_UNSAFE.to_owned())
        }
        Err(UpdatePreparationError::Cleanup(error)) => {
            eprintln!("Nanfu update browser cleanup failed: {error}");
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::BrowserCleanup);
            shutdown::exit_after_update_cleanup_failure(app, &sidecar, error);
            Err(CLEANUP_FAILED.to_owned())
        }
        Err(UpdatePreparationError::Install(error)) => {
            record_update_failure(&data_dir, &handoff.id, UpdateFailureReason::InstallerLaunch);
            log_install_failure(&data_dir, &expected_version, &error);
            let _ = window.show();
            let _ = window.set_focus();
            restart_after_install_failure(app, error);
            Err(INSTALL_FAILED.to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        download_percent, is_nanfu_download_url, log_install_failure, nanfu_notes_highlights,
        run_verified_update, validate_nanfu_manifest, UpdateCoordinator, UpdatePreparationError,
        UpdateProgress, UpdateStatus, UPDATE_HOST, UPDATE_TARGET,
    };
    use serde_json::json;
    use std::cell::Cell;
    use url::Url;

    fn installer_url(version: &str) -> String {
        format!("https://{UPDATE_HOST}/nanfu/{version}/win-x64/nanfu-{version}-x64-setup.exe")
    }

    fn update_json(version: &str, url: &str, signature: &str) -> serde_json::Value {
        json!({
            "version": version,
            "platforms": {
                UPDATE_TARGET: {
                    "url": url,
                    "signature": signature,
                }
            }
        })
    }

    #[test]
    fn accepts_only_nanfu_download_urls() {
        let valid =
            Url::parse(&installer_url("0.1.0-beta.72")).expect("valid Nanfu installer URL");
        assert!(is_nanfu_download_url(&valid));
        for invalid in [
            format!("http://{UPDATE_HOST}/nanfu/x.exe"),
            "https://example.com/nanfu/x.exe".to_owned(),
            format!("https://{UPDATE_HOST}:8443/nanfu/x.exe"),
            format!("https://user@{UPDATE_HOST}/nanfu/x.exe"),
            format!("https://{UPDATE_HOST}/nanfu/x.exe?raw=1"),
            format!("https://{UPDATE_HOST}/nanfu/x.exe#frag"),
        ] {
            assert!(
                !is_nanfu_download_url(&Url::parse(&invalid).expect("parse")),
                "{invalid}"
            );
        }
    }

    #[test]
    fn extracts_curated_notes_highlights() {
        assert_eq!(
            nanfu_notes_highlights(Some(
                "- Faster updates\n- Clear progress\n\n- Better tabs\n- Hidden fourth"
            )),
            ["Faster updates", "Clear progress", "Better tabs"]
        );
        assert!(nanfu_notes_highlights(None).is_empty());
        assert!(nanfu_notes_highlights(Some("No bullets here")).is_empty());
    }

    #[test]
    fn binds_manifest_to_version_target_url_and_signature() {
        let version = "0.1.0-beta.72";
        let url_text = installer_url(version);
        let url = Url::parse(&url_text).expect("parse");
        let raw = update_json(version, &url_text, "signed");
        assert!(validate_nanfu_manifest(version, UPDATE_TARGET, &url, "signed", &raw).is_ok());

        // Version in the header must match the manifest body.
        assert!(validate_nanfu_manifest("0.1.0-beta.73", UPDATE_TARGET, &url, "signed", &raw)
            .is_err());
        // The installer URL must be a Nanfu download, whatever the body claims.
        let foreign_url = "https://evil.example/nanfu.exe";
        let foreign = update_json(version, foreign_url, "signed");
        assert!(validate_nanfu_manifest(
            version,
            UPDATE_TARGET,
            &Url::parse(foreign_url).expect("parse"),
            "signed",
            &foreign,
        )
        .is_err());
        // A manifest for another platform is rejected.
        assert!(validate_nanfu_manifest(version, "darwin-aarch64", &url, "signed", &raw).is_err());
        // A missing signature is rejected.
        assert!(validate_nanfu_manifest(version, UPDATE_TARGET, &url, "", &raw).is_err());
        // An inconsistent body is rejected.
        let mismatched = update_json(version, &installer_url("0.1.0-beta.99"), "signed");
        assert!(validate_nanfu_manifest(
            version,
            UPDATE_TARGET,
            &url,
            "signed",
            &mismatched,
        )
        .is_err());
    }

    #[test]
    fn failed_verified_download_cannot_start_preparation_cleanup_or_install() {
        let preparation_started = Cell::new(false);
        let cleanup_started = Cell::new(false);
        let install_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Err::<Vec<u8>, String>("bad signature".to_owned()) },
            async {
                preparation_started.set(true);
                Ok(())
            },
            async {
                cleanup_started.set(true);
                Ok(())
            },
            |_| {
                install_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Download("bad signature".to_owned()))
        );
        assert!(!preparation_started.get());
        assert!(!cleanup_started.get());
        assert!(!install_started.get());
    }

    #[test]
    fn every_update_stage_runs_in_order_after_verified_download() {
        let stage = Cell::new(0);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async {
                stage.set(1);
                Ok(vec![1, 2, 3])
            },
            async {
                assert_eq!(stage.get(), 1);
                stage.set(2);
                Ok(())
            },
            async {
                assert_eq!(stage.get(), 2);
                stage.set(3);
                Ok(())
            },
            |bytes| {
                assert_eq!(stage.get(), 3);
                assert_eq!(bytes, [1, 2, 3]);
                stage.set(4);
                Ok(())
            },
        ));
        assert_eq!(result, Ok(()));
        assert_eq!(stage.get(), 4);
    }

    #[test]
    fn preparation_failure_cannot_start_cleanup_or_install() {
        let cleanup_started = Cell::new(false);
        let install_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Ok(vec![1, 2, 3]) },
            async { Err("install root mismatch".to_owned()) },
            async {
                cleanup_started.set(true);
                Ok(())
            },
            |_| {
                install_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Prepare(
                "install root mismatch".to_owned(),
            ))
        );
        assert!(!cleanup_started.get());
        assert!(!install_started.get());
    }

    #[test]
    fn cleanup_failure_cannot_start_install() {
        let install_started = Cell::new(false);
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Ok(vec![1, 2, 3]) },
            async { Ok(()) },
            async { Err("browser cleanup unconfirmed".to_owned()) },
            |_| {
                install_started.set(true);
                Ok(())
            },
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Cleanup(
                "browser cleanup unconfirmed".to_owned(),
            ))
        );
        assert!(!install_started.get());
    }

    #[test]
    fn install_failure_is_not_reported_as_success() {
        let result = tauri::async_runtime::block_on(run_verified_update(
            async { Ok(vec![1, 2, 3]) },
            async { Ok(()) },
            async { Ok(()) },
            |_| Err("installer could not start".to_owned()),
        ));
        assert_eq!(
            result,
            Err(UpdatePreparationError::Install(
                "installer could not start".to_owned(),
            ))
        );
    }

    #[test]
    fn calculates_bounded_download_percentages() {
        assert_eq!(download_percent(25, Some(100)), Some(25));
        assert_eq!(download_percent(150, Some(100)), Some(100));
        assert_eq!(download_percent(25, Some(0)), None);
        assert_eq!(download_percent(25, None), None);
    }

    #[test]
    fn serializes_update_progress_for_the_ipc_channel() {
        assert_eq!(
            serde_json::to_value(UpdateProgress::Preparing).unwrap(),
            json!({ "phase": "preparing" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Ready {
                version: "0.1.0-beta.72".to_owned(),
                highlights: vec!["Newest change".to_owned()],
            })
            .unwrap(),
            json!({
                "phase": "ready",
                "version": "0.1.0-beta.72",
                "highlights": ["Newest change"],
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading { percent: Some(42) }).unwrap(),
            json!({ "phase": "downloading", "percent": 42 })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading { percent: None }).unwrap(),
            json!({ "phase": "downloading", "percent": null })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Verifying).unwrap(),
            json!({ "phase": "verifying" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::ClosingBrowsers).unwrap(),
            json!({ "phase": "closingBrowsers" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Installing).unwrap(),
            json!({ "phase": "installing" })
        );
    }

    #[test]
    fn keeps_the_cause_of_a_failed_install() {
        let directory = tempfile::tempdir().unwrap();
        log_install_failure(
            directory.path(),
            "0.1.0-beta.99",
            "Operation not permitted (os error 1)",
        );
        log_install_failure(directory.path(), "0.1.0-beta.99", "second failure");
        let text =
            std::fs::read_to_string(directory.path().join("logs/desktop-update.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(
            "to 0.1.0-beta.99 failed at the install step: Operation not permitted (os error 1)"
        ));
        assert!(lines[1].ends_with("second failure"));
    }

    #[test]
    fn coordinator_rejects_overlapping_operations() {
        let coordinator = UpdateCoordinator::default();
        let _operation = coordinator.0.try_lock().unwrap();
        assert!(coordinator.0.try_lock().is_err());
    }

    #[test]
    fn serializes_only_safe_update_status_fields() {
        let status = UpdateStatus::Available {
            current_version: "0.1.0-beta.71".to_owned(),
            version: "0.1.0-beta.72".to_owned(),
            highlights: vec!["Faster updates".to_owned()],
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "state": "available",
                "currentVersion": "0.1.0-beta.71",
                "version": "0.1.0-beta.72",
                "highlights": ["Faster updates"],
            }),
        );
    }
}
