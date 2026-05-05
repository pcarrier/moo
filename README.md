# Moo

**Moo is the local agent workbench.**

Moo is a local agent harness you drive from a browser web UI and inspect while it works: a Rust/V8 host, a TypeScript tool runtime, Chrome DevTools Protocol debugging, attachment-aware chat, a Solid web shell, and a SQLite store for chats, memory, diffs, and MCP state.

👉 **Read the docs and install Moo at [moo.pcarrier.com](https://moo.pcarrier.com).**

## What you get

- **Local-first runtime:** no hosted backend required by default.
- **Tool-rich agents:** files, processes, HTTP, environment access, validation, events, RDF facts, attachments, and MCP tools.
- **Inspectable state:** chats, timelines, tool calls, pointers, objects, facts, memory diffs, rendered snapshots, and source views.
- **Browser web shell:** chat, browse the timeline, inspect memory, view diffs, preview Markdown and HTML, manage MCP, open generated apps, and resize the Solid UI sidebars while everything stays local.
- **Queryable memory:** assert, retract, patch, and query durable memory globally or per project with typed RDF terms, graph history, joins, vocabulary helpers, and SPARQL.
- **Hackable primitives:** content hashes, compare-and-swap pointers, JSON objects, RDF quads, command files, and ordinary static docs.

## Install

Use the install commands, release binaries, and platform notes on the website:

[https://moo.pcarrier.com](https://moo.pcarrier.com)

## Source map

| Path | What lives there |
| --- | --- |
| [src/](src/) | Rust host, V8 runtime, server, websocket, and native ops |
| [harness/src/](harness/src/) | TypeScript harness that defines the agent-facing `moo` API and commands |
| [web/src/](web/src/) | Solid UI for chats, timeline, memory, apps, and MCP setup |
| [docs/](docs/) | Static website published at [moo.pcarrier.com](https://moo.pcarrier.com) |
| [process-compose.yaml](process-compose.yaml) | One-command local development loop |
| [flake.nix](flake.nix) | Nix shells for development and release-binary builds |

For usage, installation, architecture, limits, and launch-page details, go to **[moo.pcarrier.com](https://moo.pcarrier.com)**.
