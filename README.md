# SoulUntoYou (`v0.6.0` Early Prototype)

> **English** | [简体中文](./README.zh-CN.md) | [Beginner's Guide (EN)](./docs/BEGINNER-GUIDE.md) | [纯小白使用说明书 (中文)](./docs/BEGINNER-GUIDE.zh-CN.md)

An **early personal prototype built with AI assistance by a non-programmer**.

What it actually does: it stores an AI companion's persona, chat logs, episodes, and structured facts as **local plain UTF-8 text files (Markdown + JSONL + JSON)**, accelerates recall with a rebuildable built-in `node:sqlite` FTS5 index, and runs a local loopback server exposing an OpenAI-compatible proxy (`/v1`), HTTP/WebSocket/SSE endpoints, and an MCP server so different chat apps or tools can read and write the same text folder.

The simple idea behind it: apps shut down and databases break, while plain text files can still be opened in Notepad, backed up like ordinary documents, and read years later.

---

## What's New in `v0.6.0`

* **Leaner Repo, Still Zero Dependencies**: Runs on Node.js `>= 22.18.0` native erasable TypeScript with no `node_modules/`. Legacy starter snippets live in [`docs/examples/body-starter-kits.md`](./docs/examples/body-starter-kits.md), and the shelved Mineflayer prototype was excluded from the public repo.
* **Experimental Switches Off by Default**: Mood, inner drives, free will, heartbeat, and fragment reconstruction are kept in code but turned off by default to keep default System Prompts clean; toggle them in the Web UI settings and inspect the exact System Prompt in Diagnostics.
* **Plain-Text Source of Truth + `node:sqlite` FTS5 Index**: `SEED.md`, `SOUL.md`, and `MEMORIES/*.jsonl` remain the sole source of truth, accelerated by a rebuildable `.cache/memory-index.sqlite` FTS5 index (delete it anytime and it rebuilds 100% from plain text on restart).
* **Hybrid Recall & Fact Supersession (`facts.jsonl`)**: Supports OpenAI-compatible `/v1/embeddings` and HTTP/DashScope Rerank (automatically falling back to offline FTS5 when unconfigured), plus `active`/`superseded`/`deleted` fact tracking so updated preferences no longer collide with old ones. Retains the pluggable [`MemoryRetriever`](./docs/MEMORY-RETRIEVER-PROTOCOL.md) HTTP hook.
* **30-Turn Anti-Hallucination LLM Eval (`npm run eval:llm`)**: Includes a real-LLM evaluation harness covering long-range recall, fact updates, cross-body continuity, and honest "I don't know" refusals (verified locally with `deepseek-chat` on the built-in 30-turn scenario: 11/11 checks passed, 0 leaked internal tags, 14.83 ms avg retrieval; note this reflects the built-in scenario rather than a public benchmark).

---

## Known Limitations (Read This First)

This project is **not** production-grade and still has clear boundaries:

* **No full knowledge graph & no public academic benchmark**: `v0.6.0` upgrades recall with `node:sqlite` FTS5, `facts.jsonl` conflict supersession, and optional embeddings/rerank, **but** it still does not build a multi-hop knowledge graph and has only been evaluated on the built-in 30-turn script—not public benchmarks like LoCoMo or LongMemEval.
* **Automated tests & platform coverage**: `node --test tests/*.test.ts` verifies offline logic, file integrity, security guards, and privacy hygiene (90/90 passing on **Windows + Node `v26.13.0`**; minimum `Node 22.18.0`, Linux, and macOS have not yet been independently tested).
* **Experimental modules disabled by default**: Mood tracking, inner drives, free will, heartbeat, and fragment reconstruction remain early unvalidated experiments and are switched off by default in `v0.6.0`.
* **Core runtime stack**: Backend is strictly **Node.js native erasable TypeScript (`>= 22.18.0`, zero npm dependencies, no `node_modules/`)** plus a plain HTML/CSS/JS local web UI; Python and RimWorld C# examples appear only as documentation snippets in [`docs/examples/body-starter-kits.md`](./docs/examples/body-starter-kits.md).

---

## What Currently Works Locally

* **Plain-text local storage**: On first start, copies the clean template from `examples/demo-soul/` into a gitignored folder `private-souls/default-soul/` (`SEED.md`, `SOUL.md`, `MEMORIES/*.jsonl`, `MEMORIES/facts.jsonl`).
* **Local loopback server (`127.0.0.1:7777`)**: Enforces local token auth (`.soul-hub.token`), `HttpOnly; SameSite=Strict` cookies, strict CSP, and Host/Origin checks.
* **OpenAI-compatible proxy**: Point external clients to `http://127.0.0.1:7777/v1` (or `/v1/bodies/<bodyType>/<id>`) so they inject context from the same text archive.
* **Body HTTP/WS/SSE & MCP endpoints**: `/api/body/percept`, `/api/body/observe`, `/ws/body`, `/api/events`, `/mcp`, and `node src/server/mcp-stdio.ts`.
* **Local Web UI (`EN` / `中文`)**: Two side-by-side chat test panes (`α` / `β`), plain-text file viewer, memory/embedding/experimental settings, prompt diagnostics, and automated checks.
* **QQ OneBot v11 adapter**: Located in `adapters/qq-onebot/` (tested offline against mocks; real NapCat/Lagrange usage needs live testing).

---

## Quick Start

Requires only **Node.js `>= 22.18.0`** (no `npm install`, no external database).

```bash
# Start the local server and web UI (uses offline mock mode until you configure an LLM)
node src/server/main.ts

# Or specify a custom folder for your text archive
SOUL_ARCHIVE_DIR=/path/to/my-soul node src/server/main.ts
```

* **Windows**: You can also double-click [`start-soul-test.cmd`](./start-soul-test.cmd).
* Open `http://127.0.0.1:7777/?lang=en` in your browser.
* It starts in offline `mock` mode so you can inspect the files and UI without an API key. To use a real model (Gemini, OpenAI-compatible API, or local Ollama), open **`V Open Sockets` → `ENGINE`** and save your settings.
* Step-by-step instructions: [Beginner's Guide (EN)](./docs/BEGINNER-GUIDE.md) | [Connect Real Apps](./docs/CONNECT-YOUR-BODIES.md)

---

## Why `v0.6.0` & Next Steps

`v0.6.0` focuses on making the core plain-text memory engine cleaner, faster, and less prone to prompt drift or conflicting facts. Next priorities are **SillyTavern character card V2 import**, live multi-client integration (desktop pets, QQ, `/v1` tools), and cross-platform verification on Linux/macOS and Node `22.18`.

---

## Offline Checks & License

```bash
node --test tests/*.test.ts   # Offline unit/integration, governance gates, and privacy-hygiene checks
```

[MIT License](./LICENSE)
