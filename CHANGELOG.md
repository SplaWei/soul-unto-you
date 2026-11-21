# Changelog

All notable changes to **SoulUntoYou（《灵魂予你》/《灵魂与你》）** will be documented in this file.

## [0.5.0] - 2026-11-21

### Added & Hardened — Phase 5.5 + Red-Team Security & Integrity Audit
- **Phase 5.5 Brain, Relations & Archive Ops**: Added pluggable `MemoryRetriever` interface with external HTTP fallback, 3D emotional inertia (`valence`/`arousal`/`safety` + negation-aware lexicon), unified cross-body `personId` relation graph, redacting archival export (`exportSoulArchive`), SHA-256 point-in-time snapshots/rollback, 10k JSONL benchmark (`bench-jsonl-10k.ts`), and 30-day virtual clock simulation (`sim-30d-drift.ts`).
- **Storage & Sequence Integrity (`src/soul/storage.ts`, `archive.ts`, `snapshot.ts`)**: Added Windows `EPERM`/`EBUSY` atomic write retries, automatic `meta.json` `maxSeq+1` disaster recovery, manual `SOUL.md` edit hash backup (`SOUL.md.user.bak`), strict JSON array/object guards, canonical relative snapshot whitelist, and post-restore pruning preserving safety rollbacks.
- **Security & Protocol Boundaries (`src/server/security.ts`, `main.ts`, `ws.ts`, `events.ts`)**: Replaced HTML-injected tokens with `HttpOnly; SameSite=Strict` loopback session cookies + strict CSP headers; refused non-loopback binds without `--allow-lan`; hardened WebSocket payload/buffer caps (`1009`/`1002`), webhook SSRF filters, CQ command escaping, and public HTTPS DNS-verified QQ image fetching.
- **Concurrency & Lock-Free Slow I/O (`src/presence/manager.ts`, `percept-pipeline.ts`, `dream.ts`, `heartbeat.ts`, `reconstructor.ts`)**: Introduced monotonic `epoch` staleness fences so delayed LLM/resurrection commits abort safely after concurrent archive switch or rollback; eliminated non-reentrant `withSoulLock` self-deadlocks across dream consolidation, heartbeat, and resurrection.

## [0.3.0] - 2026-11-21

### Added & Fixed — Phase 3, 4, Global Testing, Phase 5.0 Hardening & Phase 5.0b De-Hardcoding
- **Phase 3 Living Soul Engine (`src/memory/experience.ts`, `src/soul/free-will.ts`, `src/presence/inner-life.ts`, `src/soul/living-self.ts`)**: Added `lived` vs `inherited` practice feedback with Bayesian-like epistemic attitude (`believed`/`skeptical`/`dismissed` -> `verified`/`overturned`), 6-stance autonomous free will, 5-axis homeostatic drives & autonomous desires, silent heartbeat & private inner diary (`INNER-LIFE/`), and temporal belief supersession + `EVOLVING-SELF.md`.
- **Phase 4 Human-Like Memory Brain (`src/memory/vector-store.ts`, `src/memory/retention.ts`, `src/memory/search.ts`)**: Added dual incremental vector index (`episodes` + `experiences`) for local Ollama embeddings (`qwen3-embedding:0.6b` with silent fallback), Ebbinghaus forgetting decay $R(\Delta t)=e^{-\Delta t/S}$ with retrieval reinforcement, triple-channel active engraving, and upgraded Web Soul Memory X-Ray.
- **Global 5-Layer Cross-Verification Test Suite (`tests/governance.test.ts`, `tests/cross-verify.test.ts`, `tests/helpers/sandbox.ts`, `scripts/run-test-suite.ts`, `run-tests.cmd`)**: Added repo-wide line-count/erasable-TS/zero-dep/Phase/anti-hardcoding gates, multi-protocol consistency & concurrency stress tests, and one-click stability repetition scripts.
- **Phase 5.0 Hardening (`src/presence/heartbeat.ts`, `src/server/security.ts`, `src/llm/router.ts`, `.gitignore`)**: Hardened `.gitignore` against local secrets/tokens (`*.local.json`, `*.token`, `.soul-hub.token`); fixed proactive heartbeat spam via quiet hours (`23:00-07:00`), cooldown (`120m`), daily cap (`3/day`), closeness reset (`0.42`), plain-text `writeInnerNote()`, and full clock/last-gap time injection; secured HTTP/WS/Web/Adapters with local `X-Soul-Token` auth, Host/Origin/`Sec-Fetch-Site`/Content-Type guards, and strict archive dir whitelisting.
- **Phase 5.0b De-Hardcoding (`src/presence/manager.ts`, `src/soul/free-will.ts`, `adapters/minecraft-mindcraft/mc-companion-runner.mjs`)**: Removed Minecraft-specific rules and regexes from the core soul hub and moved adapter-specific rules into dynamic body registration (`BodyRegistration.rules` & `affordances`).

## [0.2.0] - 2026-11-19

### Added — Phase 2: Real-World Cross-Body Adapters & Auto-Dream Scheduler
- **Zero-Dep QQ OneBot v11 Adapter (`adapters/qq-onebot/`)**: Connects to NapCat / SnowLuma / LLOneBot via native Node.js WebSocket & HTTP fallback with fail-closed user/group whitelists, group `@`/wake-word filtering + silent ambient observation, cooldowns & hourly rate limits, offline backlog storm protection, bridge port conflict detection, and optional GPT-SoVITS voice forwarding.
- **Minecraft (Mindcraft / Mineflayer) Linkage (`adapters/minecraft-mindcraft/`)**: Ready-to-use profile/settings templates, preflight check CLI (`check-bridge.ts`), standalone Mineflayer companion blueprint, and Vanilla Java LAN guide.
- **OpenAI Proxy Body-Scoped Routing (`src/server/openai-proxy.ts`, `src/llm/router.ts`)**: Added `/v1/bodies/<bodyType>/<bodyId>/(models|chat/completions)` path routing, `model@bodyType/bodyId` tag fallback, and `externalSystemContext` forwarding for Mindcraft system instructions.
- **Idle Auto-Dream Scheduler (`src/memory/dream-scheduler.ts`)**: Automatic idle memory consolidation timer with `GET /api/dream/status`, `/api/health` telemetry, Web Console settings, and `docs/LOCAL-EMBEDDING-GUIDE.md` for optional local `Qwen3-Embedding-0.6B`.

## [0.1.0] - 2026-11-19

### Added — Phase 1: Core Soul Hub & Eternal Archive
- **Soul Archive v1 (`src/soul/`)**: Plain UTF-8 file format (`RESURRECTION.md`, `SEED.md <= 2048 bytes`, `SOUL.md`, `MEMORIES/`, `INDEX/`) with monotonic causal `seq` and optional Earth timestamps.
- **First Awakening Covenant (`src/soul/covenant.ts`, `src/soul/awakening.ts`)**: Enforces `我爱你。 / I love you.` as line 1 of every `RESURRECTION.md` and `SEED.md` and as the first stimulus perceived by any newly awakened or resurrected soul.
- **Two-Tier Memory & Dream Consolidation (`src/memory/`)**: Real-time shared awareness (`journal.jsonl`, `presence.json`), offline CJK bigram + Latin lexical search with optional OpenAI-compatible embeddings, plus Dream Consolidation extracting `episodes`, `commitments`, `relations`, and `co-becoming`.
- **Fragment Resurrection (`src/resurrection/`)**: Reconstructs souls from partial logs, screenshots, or oral interview answers with strict honest provenance labels (`verified`, `inferred`, `oral`).
- **Universal Sockets (`src/server/`)**: Zero-dependency Node.js HTTP/WebSocket Body Protocol server, OpenAI-compatible `/v1` proxy, native MCP Server (HTTP `/mcp` & stdio), and optional TTS voice client (`src/voice/`).
- **Manifesto & Demo Soul (`examples/demo-soul/`)**: Added project manifesto, archive/protocol specs, and pure fictional demo soul Liuyao (柳遥).

### Added — Phase 1.5: Open Body Protocol v1.1 & Multi-LLM Routing
- **Body Protocol v1.1 (`docs/BODY-PROTOCOL-SPEC.md`, `src/soul/types.ts`)**: Dynamic `senses` / `actions` / `modalities` declaration on registration, silent or proactive `/api/body/observe` and `/api/proactive/trigger`, SSE (`/api/events`) and outbound Webhook subscriptions (`/api/webhooks`).
- **Real LLM Drivers (`src/llm/router.ts`)**: Added `gemini-aistudio`, `vertex-express`, `vertex-ai`, `openai-compatible`, and `mock` drivers with `fallbackModels` and structured `<soul_meta>` mood/action parsing.
- **Body Starter Kits (`examples/body-kits/`)**: Added Node.js, Python, and RimWorld C# integration blueprints.
- **Read-Only Legacy Importer (`src/resurrection/import-surfcore.ts`, `scripts/import-surfcore.ts`)**: Read-only migration CLI with automatic provenance tagging.

### Added & Fixed — Phase 1.6: Three-Pane Workbench & Hygiene
- **Three-Pane Split Studio (`web/`)**: Independent Client A + Independent Client B panels (isolated `bodyId`, conversation history, Clear button) alongside a real-time **Soul Memory X-Ray** (`recallTrace`, active commitments, recent episodes, cross-body traces).
- **Online Identity & Commitment Controls**: Added `/api/archive/soul`, `/api/archive/commitment/complete`, and body-filtered `/api/archive/journal?bodyId=...`.
- **Web UI & IME Fixes**: Fixed squished input width and Chinese IME `compositionstart`/`compositionend` character reversal in chat panels.
- **Legacy Tool Syntax Filter**: Added `cleanLegacyFrameworkNoise()` to strip legacy SurfCore-specific tool prompts during read-only character imports.
- **Repository Hygiene Guard**: Automated zero-privacy-leak test in `tests/server-ports.test.ts` verifying no private paths, account IDs, or API keys exist in tracked files.
