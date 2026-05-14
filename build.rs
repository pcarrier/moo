use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    println!("cargo:rerun-if-changed=harness/package.json");
    println!("cargo:rerun-if-changed=harness/bun.lock");
    println!("cargo:rerun-if-changed=harness/tsconfig.json");
    emit_rerun_if_changed(Path::new("harness/src"));

    println!("cargo:rerun-if-changed=web/package.json");
    println!("cargo:rerun-if-changed=web/bun.lock");
    println!("cargo:rerun-if-changed=web/tsconfig.json");
    println!("cargo:rerun-if-changed=web/vite.config.ts");
    println!("cargo:rerun-if-changed=web/index.html");
    emit_rerun_if_changed(Path::new("web/src"));

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    build_harness(&out_dir);
    build_ui(&out_dir);
}

fn build_harness(out_dir: &Path) {
    let out_file = out_dir.join("default_harness.js");

    if let Some(prebuilt) = env::var_os("MOO_HARNESS_BUNDLE") {
        let prebuilt = PathBuf::from(prebuilt);
        fs::copy(&prebuilt, &out_file).unwrap_or_else(|err| {
            panic!(
                "failed to copy {} -> {}: {err}",
                prebuilt.display(),
                out_file.display()
            )
        });
        let mut prebuilt_map = prebuilt.into_os_string();
        prebuilt_map.push(".map");
        let prebuilt_map = PathBuf::from(prebuilt_map);
        if prebuilt_map.exists() {
            fs::copy(&prebuilt_map, out_dir.join("default_harness.js.map")).unwrap_or_else(|err| {
                panic!(
                    "failed to copy {} -> default_harness.js.map: {err}",
                    prebuilt_map.display()
                )
            });
        }
        return;
    }

    require_harness_deps();

    let output = Command::new("bun")
        .current_dir("harness")
        .arg("build")
        .arg("src/index.ts")
        .arg("--outdir")
        .arg(out_dir)
        .arg("--entry-naming=default_harness.[ext]")
        .arg("--format=iife")
        .arg("--target=browser")
        .arg("--sourcemap=linked")
        .output()
        .expect("failed to run bun; install Bun to build the embedded default harness");

    assert!(
        output.status.success(),
        "failed to build embedded default harness with bun build: status={}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        out_file.exists(),
        "bun build completed but did not produce {}",
        out_file.display()
    );
}

fn build_ui(out_dir: &Path) {
    let generated_dist = out_dir.join("web-dist");
    let dist: PathBuf = env::var_os("MOO_VITE_DIST").map_or_else(
        || {
            require_web_deps();

            let output = Command::new("bun")
                .current_dir("web")
                .arg("run")
                .arg("build")
                .arg("--")
                .arg("--outDir")
                .arg(&generated_dist)
                .arg("--emptyOutDir")
                .output()
                .expect("failed to run bun; install Bun to build the embedded Vite UI");

            assert!(
                output.status.success(),
                "failed to build embedded Vite UI with bun run build: status={}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );

            generated_dist
        },
        PathBuf::from,
    );

    let html_path = dist.join("index.html");
    let html = fs::read_to_string(&html_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", html_path.display()));
    let html = inline_vite_assets(&html, &dist);
    fs::write(out_dir.join("default_ui.html"), &html)
        .unwrap_or_else(|err| panic!("failed to write embedded UI html: {err}"));
    fs::write(
        out_dir.join("default_ui.html.br"),
        brotli_compress(html.as_bytes()),
    )
    .unwrap_or_else(|err| panic!("failed to write embedded UI Brotli html: {err}"));
}

fn brotli_compress(input: &[u8]) -> Vec<u8> {
    let (quality, lgwin) = if is_release_profile() {
        (11, 22)
    } else {
        // Keep developer and profiling builds fast; maximum compression only
        // matters for release artifacts.
        (0, 10)
    };

    let mut out = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(&mut out, 4096, quality, lgwin);
        writer
            .write_all(input)
            .expect("failed to Brotli-compress embedded UI html");
    }

    out
}

fn is_release_profile() -> bool {
    let Ok(out_dir) = env::var("OUT_DIR") else {
        return false;
    };

    let components: Vec<_> = Path::new(&out_dir).components().collect();
    components
        .windows(2)
        .any(|pair| pair[0].as_os_str() == "release" && pair[1].as_os_str() == "build")
}

fn require_harness_deps() {
    assert!(
        typescript_package_exists(),
        "missing harness dependencies: run `bun install --cwd harness --frozen-lockfile --no-progress` before Cargo builds, or set MOO_HARNESS_BUNDLE to a prebuilt harness bundle"
    );
}

fn typescript_package_exists() -> bool {
    Path::new("harness/node_modules/typescript/package.json").exists()
}

fn require_web_deps() {
    assert!(
        vite_bin_exists(),
        "missing web dependencies: run `bun install --cwd web --frozen-lockfile --no-progress` before Cargo builds, or set MOO_VITE_DIST to a prebuilt Vite dist directory"
    );
}

fn vite_bin_exists() -> bool {
    ["vite", "vite.exe", "vite.cmd", "vite.ps1"]
        .iter()
        .any(|name| Path::new("web/node_modules/.bin").join(name).exists())
}

fn inline_vite_assets(html: &str, dist: &Path) -> String {
    let mut out = html.to_string();

    while let Some((start, end, href)) = find_tag_with_attr(&out, "<link", "stylesheet", "href") {
        let css = read_dist_asset(dist, &href);
        let replacement = format!("<style>\n{css}\n</style>");
        out.replace_range(start..end, &replacement);
    }

    while let Some((start, end, src)) = find_tag_with_attr(&out, "<script", "module", "src") {
        let js = read_dist_asset(dist, &src);
        let replacement = format!("<script type=\"module\">\n{js}\n</script>");
        out.replace_range(start..end, &replacement);
    }

    out
}

fn find_tag_with_attr(
    html: &str,
    tag_start: &str,
    required_substr: &str,
    attr: &str,
) -> Option<(usize, usize, String)> {
    let mut search_from = 0;
    while let Some(rel_start) = html[search_from..].find(tag_start) {
        let start = search_from + rel_start;
        let open_end = html[start..].find('>').map(|i| start + i + 1)?;
        let open_tag = &html[start..open_end];
        search_from = open_end;
        if !open_tag.contains(required_substr) {
            continue;
        }
        let Some(value) = attr_value(open_tag, attr) else {
            continue;
        };
        let end = if tag_start == "<script" {
            html[open_end..]
                .find("</script>")
                .map(|i| open_end + i + "</script>".len())?
        } else {
            open_end
        };
        return Some((start, end, value));
    }
    None
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')?;
    Some(tag[start..start + end].to_string())
}

fn read_dist_asset(dist: &Path, asset: &str) -> String {
    let relative = asset.trim_start_matches('/');
    let path = dist.join(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()))
}

fn emit_rerun_if_changed(path: &Path) {
    if path.is_file() {
        println!("cargo:rerun-if-changed={}", path.display());
        return;
    }

    let entries =
        fs::read_dir(path).unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    for entry in entries {
        let entry =
            entry.unwrap_or_else(|err| panic!("failed to read entry in {}: {err}", path.display()));
        let path = entry.path();
        if path.is_dir() {
            emit_rerun_if_changed(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
