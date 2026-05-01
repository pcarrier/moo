use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    println!("cargo:rerun-if-changed=harness/package.json");
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

    let bun_out = Path::new("harness/src/default_harness.js");
    let output = Command::new("bun")
        .current_dir("harness")
        .arg("build")
        .arg("src/index.ts")
        .arg("--outfile=src/default_harness.js")
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
    fs::copy(bun_out, &out_file).unwrap_or_else(|err| {
        panic!(
            "failed to copy {} -> {}: {err}",
            bun_out.display(),
            out_file.display()
        )
    });
    let bun_map = Path::new("harness/src/default_harness.js.map");
    if bun_map.exists() {
        fs::copy(bun_map, out_dir.join("default_harness.js.map")).unwrap_or_else(|err| {
            panic!(
                "failed to copy {} -> default_harness.js.map: {err}",
                bun_map.display()
            )
        });
    }
    let _ = fs::remove_file(bun_out);
    let _ = fs::remove_file(bun_map);
}

fn build_ui(out_dir: &Path) {
    let dist: PathBuf = env::var_os("MOO_VITE_DIST").map_or_else(
        || {
            let output = Command::new("bun")
                .current_dir("web")
                .arg("run")
                .arg("build")
                .output()
                .expect("failed to run bun; install Bun to build the embedded Vite UI");

            assert!(
                output.status.success(),
                "failed to build embedded Vite UI with bun run build: status={}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );

            PathBuf::from("web/dist")
        },
        PathBuf::from,
    );

    let html_path = dist.join("index.html");
    let html = fs::read_to_string(&html_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", html_path.display()));
    let html = inline_vite_assets(&html, &dist);
    fs::write(out_dir.join("default_ui.html"), html)
        .unwrap_or_else(|err| panic!("failed to write embedded UI html: {err}"));
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
