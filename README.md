# SoulUntoYou (`v0.5.0` Early Prototype)

> **English** | [简体中文](./README.zh-CN.md) | [Beginner's Guide (EN)](./docs/BEGINNER-GUIDE.md) | [纯小白使用说明书 (中文)](./docs/BEGINNER-GUIDE.zh-CN.md)

An **early personal prototype built with AI assistance by a non-programmer**.

What it actually does: it stores an AI companion's persona, chat logs, summaries, and reminders as **local plain UTF-8 text files (Markdown + JSONL + JSON)**, and runs a local loopback server exposing an OpenAI-compatible proxy (`/v1`), simple HTTP/WebSocket/SSE endpoints, and an MCP server so different chat apps or tools can read and write the same text folder.

The simple idea behind it: apps shut down and databases break, while plain text files can still be opened in Notepad, backed up like ordinary documents, and read years later.

---

## Known Limitations (Read This First)

This project is **not** production-grade and has clear gaps right now:

* **Basic memory system**: Built-in recall currently does linear JSONL file scanning + simple CJK/word lexical matching + optional single-vector cosine similarity + basic time-decay weights. It has **no knowledge graph, no automatic contradiction/fact-updating logic** (new facts do not automatically supersede old conflicting facts), and **no benchmark scores on real long-conversation evaluations**.
* **Tests are offline logic checks only**: `node --test tests/*.test.ts` checks file writes, protocol wiring, security guards, and mock flows. Passing those tests does **not** prove memory quality in real multi-hundred-turn LLM conversations.
* **Unvalidated experimental modules**: Prompt-based mood tracking, inner drives, idle heartbeat, and fragment reconstruction are early experiments and have not been validated in long-term daily use.
* **Why multiple languages appear in the repo**:
  * The actual runnable backend is **TypeScript on Node.js (`>= 22.18.0`, zero npm dependencies)** plus a plain HTML/CSS/JS local web UI.
  * The `.py` and `.cs` files shown in GitHub's language bar are just two standalone example stubs in `examples/body-kits/`, and `adapters/minecraft-mindcraft/` (`.mjs`) is a shelved prototype—none of them are needed to run the server.
  * Candid note: for an AI memory tool, **Python would likely be simpler and easier to maintain** than a 80-file TypeScript project. Node.js native TypeScript was originally chosen to avoid installing external dependencies; simplifying the codebase (or moving toward a much smaller Python core) is under consideration.

---

## What Currently Works Locally

* **Plain-text local storage**: On first start, copies the clean template from `examples/demo-soul/` into a gitignored folder `private-souls/default-soul/` (`SEED.md`, `SOUL.md`, `MEMORIES/*.jsonl`, etc.).
* **Local loopback server (`127.0.0.1:7777`)**: Enforces local token auth (`.soul-hub.token`), `HttpOnly; SameSite=Strict` cookies, strict CSP, and Host/Origin checks.
* **OpenAI-compatible proxy**: Point external clients to `http://127.0.0.1:7777/v1` (or `/v1/bodies/<bodyType>/<id>`) so they inject context from the same text archive.
* **Body HTTP/WS/SSE & MCP endpoints**: `/api/body/percept`, `/api/body/observe`, `/ws/body`, `/api/events`, `/mcp`, and `node src/server/mcp-stdio.ts`.
* **Local Web UI (`EN` / `中文`)**: Two side-by-side chat test panes (`α` / `β`), plain-text file viewer, model settings, and diagnostic checks.
* **Pluggable memory hook**: `MemoryRetriever` interface allows swapping in an external HTTP memory service instead of the built-in basic search.
* **QQ OneBot v11 adapter**: Located in `adapters/qq-onebot/` (tested offline against mocks; real NapCat/Lagrange usage needs live testing).

---

## Quick Start

Requires only **Node.js `>= 22.18.0`** (no `npm install`, no database).

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

## Why `v0.5.0` & Next Steps

`v0.5.0` is an early public snapshot shared to test the plain-text archive format and gather honest feedback—not a finished product.

The immediate priority is **cutting unnecessary complexity and running real-world evaluations** (testing long conversations with real LLMs and replacing or simplifying the basic memory search) rather than adding more experimental features.

---

## Offline Checks & License

```bash
node --test tests/*.test.ts   # Offline unit/integration and privacy-hygiene checks (not a real-LLM memory eval)
```

[MIT License](./LICENSE)
