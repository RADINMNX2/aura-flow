use std::{fs, path::Path};

// The wizard embeds the app installer as `payload/flow_<version>_x64-setup.exe`, and that
// version belongs to the app, not to the setup. Read it from the app config so a version
// bump cannot leave a stale payload embedded in the next installer.
fn version_of(conf: &Path) -> String {
    let text = fs::read_to_string(conf).unwrap_or_else(|e| panic!("read {}: {e}", conf.display()));
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("\"version\"") {
            if let Some(value) = rest.split(':').nth(1) {
                let value = value.trim().trim_end_matches(',').trim_matches('"');
                if !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }
    panic!("no \"version\" field in {}", conf.display());
}

fn main() {
    let manifest = Path::new(&env!("CARGO_MANIFEST_DIR")).to_path_buf();
    let app_conf = manifest.join("../../src-tauri/tauri.conf.json");
    let setup_conf = manifest.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", app_conf.display());
    println!("cargo:rerun-if-changed={}", setup_conf.display());

    let app_version = version_of(&app_conf);
    println!("cargo:rustc-env=FLOW_APP_VERSION={app_version}");
    println!("cargo:rustc-env=FLOW_PAYLOAD_NSIS=flow_{app_version}_x64-setup.exe");

    tauri_build::build()
}
