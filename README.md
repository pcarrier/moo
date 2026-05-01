# moo

A small local agent harness with a Rust core, a TypeScript runtime, a Solid UI, and SQLite for memory. It is meant to be hackable, inspectable, and pretty calm to run on your machine.

## What it does

- runs a JavaScript/TypeScript agent harness inside V8
- keeps chats, refs, objects, and RDF-style facts in a local SQLite store
- serves a local web shell for chatting, browsing memory, and managing MCP servers
- exposes host ops for files, processes, HTTP, env, refs, facts, and more
- embeds the default harness and UI into the Rust binary at build time

No cloud service is required by default. Bring your own model/API wiring in the harness when you want it.

## Quick start

With direnv and Nix, the repo shell is automatic after one allow:

```sh
direnv allow
```

The included `.envrc` enters the Nix dev shell, so Rust, Bun, and the other dev tools are available when you `cd` into the repo. Without direnv/Nix, install Rust and Bun yourself.

```sh
# Install the web UI dependencies
cd web
bun install
cd ..

# Build and run the local web shell
cargo run -- serve
```

Then open:

```
http://127.0.0.1:7777
```

The Cargo build runs Bun for you and embeds the harness plus the built UI into the binary.

## CLI basics

```sh
# Start the local web shell
cargo run -- serve --port 7777 --host 127.0.0.1

# Run the bundled harness once
cargo run -- run

# Run with a JSON input
cargo run -- eval '{"hello":"moo"}'

# Dump stored quads, optionally for one chat
cargo run -- dump
cargo run -- dump <chat-id>

# Build a V8 startup snapshot
cargo run -- snapshot snapshot.bin
```

For the full list:

```sh
cargo run -- --help
cargo run -- serve --help
```

## Dev loop

For a live-reload setup, run process-compose from the repo root:

```sh
process-compose
```

That runs:

- `harness`: watches `harness/src` and rebuilds `harness/dist/harness.js`
- `backend`: restarts the Rust server on `src` changes and rereads the harness bundle per request
- `frontend`: runs Vite on port `5173` and proxies API calls to the backend

Manual version:

```sh
# Terminal 1
cd harness
bun run dev

# Terminal 2
cargo run --profile profiling -- serve \
  --port 7777 \
  --host 127.0.0.1 \
  --watch \
  --bundle harness/dist/harness.js

# Terminal 3
cd web
bun run dev
```

## Project map

| Path | What lives there |
| --- | --- |
| `src/` | Rust host, V8 runtime, server, websocket, and native ops |
| `harness/src/` | TypeScript harness that defines the agent-facing `moo` API and commands |
| `web/src/` | Solid UI for chats, timeline, memory, apps, and MCP setup |
| `build.rs` | Builds and embeds the default harness and UI during Cargo builds |
| `process-compose.yaml` | One-command local dev loop |
| `flake.nix` | Nix shells for development and release-binary builds |

## Data and local state

The SQLite store defaults to:

1. `$MOO_DB`, if set
2. `$XDG_DATA_HOME/moo/store.sqlite`
3. `~/.local/share/moo/store.sqlite`

Repo-local scratch data goes in `.moo/`, which is intentionally ignored. Keep it around while developing unless you really mean to reset local work/state.

## Useful build commands

```sh
# Rust build
cargo build

# Rust tests
cargo test

# Build just the harness bundle
cd harness && bun run build

# Build just the web UI
cd web && bun run build
```

## Notes

Moo is local-first. Keep changes small, make state easy to inspect, and prefer boring tools when they do the job.
