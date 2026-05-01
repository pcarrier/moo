#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function usage() {
  console.error(`usage: scripts/bump-version.mjs [--dry-run] [--from <old-version>] <new-version>

Updates the moo package version in Cargo.toml, Cargo.lock, flake.nix, and
harness/src/moo.ts. By default, <old-version> is read from Cargo.toml.`);
}

function parseArgs(argv) {
  let dryRun = false;
  let from = null;
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--from") {
      from = argv[++i];
      if (!from) throw new Error("--from requires a version");
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }

  if (rest.length !== 1) throw new Error("expected exactly one new version");
  return { dryRun, from, to: rest[0] };
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  }
}

function read(root, path) {
  return readFileSync(resolve(root, path), "utf8");
}

function write(root, path, text) {
  writeFileSync(resolve(root, path), text);
}

function cargoTomlVersion(text) {
  const match = text.match(/(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m);
  if (!match) throw new Error("could not find [package] version in Cargo.toml");
  return match[2];
}

function replaceOne(path, text, pattern, oldVersion, newVersion) {
  let count = 0;
  const next = text.replace(pattern, (...args) => {
    const current = args[2];
    if (current !== oldVersion) {
      throw new Error(`${path} has version ${current}, expected ${oldVersion}`);
    }
    count++;
    return args[1] + newVersion + args[3];
  });

  if (count !== 1) {
    throw new Error(`expected one version match in ${path}, found ${count}`);
  }
  return next;
}

function replacements(root, oldVersion, newVersion) {
  return [
    {
      path: "Cargo.toml",
      pattern: /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
    },
    {
      path: "Cargo.lock",
      pattern: /(^\[\[package\]\]\nname\s*=\s*"moo"\nversion\s*=\s*")([^"]+)(")/m,
    },
    {
      path: "flake.nix",
      pattern: /(pname\s*=\s*"moo";\n\s*version\s*=\s*")([^"]+)(";)/,
    },
    {
      path: "harness/src/moo.ts",
      pattern: /(clientInfo:\s*\{\s*name:\s*"moo",\s*version:\s*")([^"]+)("\s*\})/,
    },
  ].map(({ path, pattern }) => ({
    path,
    text: replaceOne(path, read(root, path), pattern, oldVersion, newVersion),
  }));
}

try {
  const root = repoRoot();
  const { dryRun, from, to } = parseArgs(process.argv.slice(2));
  if (!VERSION_RE.test(to)) throw new Error(`invalid new version: ${to}`);

  const oldVersion = from ?? cargoTomlVersion(read(root, "Cargo.toml"));
  if (!VERSION_RE.test(oldVersion)) throw new Error(`invalid old version: ${oldVersion}`);
  if (oldVersion === to) throw new Error(`version is already ${to}`);

  const updates = replacements(root, oldVersion, to);
  if (!dryRun) {
    for (const update of updates) write(root, update.path, update.text);
  }

  const verb = dryRun ? "would update" : "updated";
  for (const update of updates) console.log(`${verb} ${update.path}: ${oldVersion} -> ${to}`);
} catch (error) {
  console.error(`bump-version: ${error.message}`);
  usage();
  process.exit(1);
}
