use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let source = manifest.join("generated/browser.json");
    println!("cargo:rerun-if-changed={}", source.display());

    let metadata = fs::read_to_string(&source)
        .expect("generated browser metadata is missing; run `bun run desktop:prepare` first");
    let parsed: serde_json::Value =
        serde_json::from_str(&metadata).expect("valid generated browser metadata");
    // Build scripts run on the host, so the target comes from Cargo's environment.
    let windows = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    // Apple's linker signs arm64 programs by itself, but not x86_64 ones. Tauri signs the main
    // program before aliasmode-mcp, and codesign refuses to seal an app around unsigned code.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
    {
        println!("cargo:rustc-link-arg-bins=-Wl,-adhoc_codesign");
    }

    if windows {
        let chromium = parsed.get("chromium").expect("browser metadata is missing chromium");
        assert_eq!(
            chromium,
            &serde_json::json!({
                "executable": "chrome.exe",
                "sha256": "0ef4de1bef7c12534031318e07ac89fa7942916a3abc89057985aafefbca619f",
                "version": "155.0.8059.85-aliasmode.4",
                "archiveSha256": "cfea275e4b7f3274b701e64c0483b46cbf6cd12ead9a6cfda6ff77b2680e7a23"
            }),
            "Chromium metadata must match the approved Windows runtime"
        );
        assert!(parsed.get("firefox").is_none(), "Windows metadata must not require Firefox");
    } else {
        let firefox = parsed
            .get("firefox")
            .and_then(|value| value.as_object())
            .expect("browser metadata is missing firefox");
        for key in ["executable", "sha256", "archiveSha256", "version"] {
            assert!(
                firefox
                    .get(key)
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| !value.is_empty()),
                "Firefox metadata is missing {key}"
            );
        }
        assert_eq!(
            firefox.get("version").and_then(|value| value.as_str()),
            Some("156.0.1-beta.36"),
            "Firefox metadata must use the approved runtime version"
        );
        let firefox_executable = firefox
            .get("executable")
            .and_then(|value| value.as_str())
            .expect("Firefox metadata is missing executable");
        assert!(
            !firefox_executable.starts_with('/')
                && !firefox_executable.starts_with('\\')
                && !firefox_executable.contains(':')
                && firefox_executable
                    .split(['/', '\\'])
                    .all(|component| !component.is_empty() && component != "." && component != "..")
                && firefox_executable.split(['/', '\\']).next_back()
                    == Some(if windows {
                        "aliasmode.exe"
                    } else {
                        "aliasmode"
                    }),
            "Firefox metadata executable path is unsafe"
        );
        for key in ["sha256", "archiveSha256"] {
            let sha256 = firefox
                .get(key)
                .and_then(|value| value.as_str())
                .expect("Firefox metadata is missing hash");
            assert!(
                sha256.len() == 64
                    && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && sha256.bytes().any(|byte| byte != b'0'),
                "Firefox metadata has an invalid {key}"
            );
        }
    }

    let out = PathBuf::from(env::var("OUT_DIR").expect("build output directory"));
    fs::write(out.join("browser.json"), metadata).expect("write embedded browser metadata");
}
