use crate::credentials::CredentialOrigin;
use crate::sidecar::SidecarSupervisor;
use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

static QUIT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
struct Roster {
    profiles: Vec<RosterProfile>,
}

#[derive(Debug, Deserialize)]
struct RosterProfile {
    running: bool,
}

async fn active_browser_count(origin: &str) -> Result<usize, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/ui/api/profiles"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 2 * 1024 * 1024 {
        return Err("profile activity is unavailable".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("profile activity is unavailable".to_owned());
    }
    let roster: Roster =
        serde_json::from_slice(&bytes).map_err(|_| "profile activity is unavailable".to_owned())?;
    Ok(roster
        .profiles
        .iter()
        .filter(|profile| profile.running)
        .count())
}

#[derive(Clone, Copy)]
enum CleanupAction {
    Exit,
    Restart,
}

pub(crate) async fn graceful_sidecar_cleanup(sidecar: &SidecarSupervisor) -> Result<(), String> {
    sidecar.request_shutdown()?;
    sidecar.wait_for_shutdown().await
}

pub(crate) fn exit_after_cleanup_failure(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    error: String,
) {
    exit_after_cleanup_failure_message(
        app,
        sidecar,
        "南孚浏览器退出失败",
        format!("南孚浏览器无法确认浏览器已安全关闭。{error}"),
    );
}

pub(crate) fn exit_after_update_cleanup_failure(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    error: String,
) {
    exit_after_cleanup_failure_message(
        app,
        sidecar,
        "南孚浏览器更新未安装",
        format!(
            "无法确认浏览器已安全关闭，因此这次更新没有安装；当前版本保持不变。{error}"
        ),
    );
}

fn exit_after_cleanup_failure_message(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    title: &str,
    message: String,
) {
    let _ = sidecar.kill_owned();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.exit(1));
}

fn finish_after_cleanup(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    action: CleanupAction,
) {
    let _ = window.hide();
    tauri::async_runtime::spawn(async move {
        match graceful_sidecar_cleanup(&sidecar).await {
            Ok(()) => match action {
                CleanupAction::Exit => app.exit(0),
                CleanupAction::Restart => app.request_restart(),
            },
            Err(error) => exit_after_cleanup_failure(app, &sidecar, error),
        }
    });
}

#[tauri::command]
pub fn restart_after_mode_change(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
) {
    finish_after_cleanup(app, window, sidecar.inner().clone(), CleanupAction::Restart);
}

fn ask_to_close(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    active: Result<usize, String>,
) {
    let message = match active {
        Ok(1) => "还有 1 个浏览器环境在运行。南孚浏览器会先保存会话状态并关闭它，然后退出。".to_owned(),
        Ok(count) => format!("还有 {count} 个浏览器环境在运行。南孚浏览器会先保存会话状态并关闭它们，然后退出。"),
        Err(_) => "无法确认浏览器活动状态。南孚浏览器会先保存会话状态并关闭所有运行中的浏览器，然后退出。".to_owned(),
    };
    app.dialog()
        .message(message)
        .title("退出南孚浏览器？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |confirmed| {
            if confirmed {
                finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
            } else {
                QUIT_IN_PROGRESS.store(false, Ordering::Release);
            }
        });
}

pub fn request_quit(app: AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };
    if QUIT_IN_PROGRESS.swap(true, Ordering::AcqRel) {
        return;
    }
    let origin = app.state::<CredentialOrigin>().0.clone();
    let sidecar = app.state::<SidecarSupervisor>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let active = active_browser_count(&origin).await;
        if matches!(active, Ok(0)) {
            finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
        } else {
            ask_to_close(app, window, sidecar, active);
        }
    });
}

pub fn install_close_handler(window: WebviewWindow) {
    let window_to_hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // The close button parks the app in the tray so a stray click cannot take
            // down running profiles; quitting is an explicit choice in the tray menu.
            api.prevent_close();
            let _ = window_to_hide.hide();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{Roster, RosterProfile};

    #[test]
    fn counts_only_active_roster_entries() {
        let roster = Roster {
            profiles: vec![
                RosterProfile { running: true },
                RosterProfile { running: false },
                RosterProfile { running: true },
            ],
        };
        assert_eq!(
            roster
                .profiles
                .iter()
                .filter(|profile| profile.running)
                .count(),
            2
        );
    }
}
