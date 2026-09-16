import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "../../docs/install");
const releaseApi = "https://api.github.com/repos/pcarrier/moo/releases/latest";
const version = "9.8.7";
const binary = `#!/bin/sh\nprintf 'moo ${version}\\n'\n`;

function runInstaller(
  platform: string,
  arch: string,
  target = "",
  options: { installed?: boolean; badChecksum?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "moo-install-test-"));
  try {
    const tools = join(root, "tools");
    const archiveDir = join(root, "archive");
    const binDir = join(root, "bin");
    mkdirSync(tools);
    mkdirSync(archiveDir);
    writeFileSync(join(archiveDir, "moo"), binary, { mode: 0o755 });
    const archive = join(root, "moo.tar.gz");
    const packed = spawnSync("tar", ["-czf", archive, "-C", archiveDir, "moo"], { encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`could not create installer fixture: ${packed.error ?? packed.stderr}`);
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(join(root, "moo.tar.gz.sha256"), `${options.badChecksum ? "0".repeat(64) : checksum}  dist/moo.tar.gz\n`);

    const assetUrl = `https://example.invalid/moo-v${version}-${target}.tar.gz`;
    const targets = ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"];
    writeFileSync(join(root, "release.json"), JSON.stringify({
      tag_name: `v${version}`,
      assets: targets.map((name) => ({
        browser_download_url: `https://example.invalid/moo-v${version}-${name}.tar.gz`,
      })),
    }, null, 2));
    writeFileSync(join(tools, "uname"), `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$TEST_PLATFORM" ;;
  -m) printf '%s\\n' "$TEST_ARCH" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    // Never delegate to real curl: even unexpected URLs fail without networking.
    writeFileSync(join(tools, "curl"), `#!/bin/sh
set -eu
printf 'called\\n' >> "$FIXTURE_DIR/curl-calls"
url=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; out="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$FIXTURE_DIR/requests"
case "$url" in
  "$RELEASE_API") cat "$FIXTURE_DIR/release.json" ;;
  "$ASSET_URL") cp "$FIXTURE_DIR/moo.tar.gz" "$out" ;;
  "$ASSET_URL.sha256") cp "$FIXTURE_DIR/moo.tar.gz.sha256" "$out" ;;
  *) echo "unexpected curl URL: $url" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(tools, "codesign"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FIXTURE_DIR/codesign-calls"\n`, { mode: 0o755 });
    if (options.installed) {
      mkdirSync(binDir);
      writeFileSync(join(binDir, "moo"), binary, { mode: 0o755 });
    }

    const result = spawnSync("sh", [installer], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        HOME: root,
        TMPDIR: root,
        BIN_DIR: binDir,
        TEST_PLATFORM: platform,
        TEST_ARCH: arch,
        FIXTURE_DIR: root,
        RELEASE_API: releaseApi,
        ASSET_URL: assetUrl,
      },
    });
    if (result.error) throw result.error;
    const readLines = (name: string) => existsSync(join(root, name))
      ? readFileSync(join(root, name), "utf8").trim().split("\n")
      : [];
    return {
      ...result,
      assetUrl,
      curlCalls: readLines("curl-calls"),
      requests: readLines("requests"),
      codesignCalls: readLines("codesign-calls"),
      installed: existsSync(join(binDir, "moo")) ? readFileSync(join(binDir, "moo"), "utf8") : null,
      binDirExists: existsSync(binDir),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release installer platforms", () => {
  for (const arch of ["x86_64", "amd64"]) {
    test(`rejects Intel macOS (${arch}) before any network request`, () => {
      const result = runInstaller("Darwin", arch);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Intel macOS");
      expect(result.stderr).toContain("requires Apple Silicon (arm64)");
      expect(result.curlCalls).toEqual([]);
      expect(result.binDirExists).toBe(false);
    });
  }

  for (const [platform, arch, target] of [
    ["Darwin", "arm64", "aarch64-apple-darwin"],
    ["Darwin", "aarch64", "aarch64-apple-darwin"],
    ["Linux", "x86_64", "x86_64-unknown-linux-gnu"],
    ["Linux", "amd64", "x86_64-unknown-linux-gnu"],
  ]) {
    test(`installs the correct verified asset for ${platform} ${arch}`, () => {
      const result = runInstaller(platform, arch, target);
      expect(result.status).toBe(0);
      expect(result.requests).toEqual([releaseApi, result.assetUrl, `${result.assetUrl}.sha256`]);
      expect(result.installed).toBe(binary);
      expect(result.stdout).toContain("installed moo to");
      expect(result.codesignCalls).toHaveLength(platform === "Darwin" ? 1 : 0);
    });
  }

  test("still skips downloads when the latest version is installed", () => {
    const result = runInstaller("Darwin", "arm64", "aarch64-apple-darwin", { installed: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`moo ${version} is already installed`);
    expect(result.requests).toEqual([releaseApi]);
    expect(result.installed).toBe(binary);
  });

  test("still rejects a mismatched checksum", () => {
    const result = runInstaller("Linux", "x86_64", "x86_64-unknown-linux-gnu", { badChecksum: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(result.installed).toBeNull();
  });

  test("still rejects unsupported Linux architectures without networking", () => {
    const result = runInstaller("Linux", "aarch64");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported platform: Linux aarch64");
    expect(result.curlCalls).toEqual([]);
    expect(result.binDirExists).toBe(false);
  });
});
