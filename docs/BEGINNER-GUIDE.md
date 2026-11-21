# SoulUntoYou · Beginner's Guide (`v0.5.0`)

> **English** | [简体中文](./BEGINNER-GUIDE.zh-CN.md) | [Back to README](../README.md) | [Connect Real Apps](./CONNECT-YOUR-BODIES.md)

> **Honest note before you start**: This is an early personal prototype. Its memory search is currently basic (simple keyword matching + optional vector similarity), so do not expect production-level accuracy yet. This guide simply helps you run it locally and inspect the plain-text files yourself.

---

## 1. Prerequisite: Install Node.js (`>= 22.18.0`)

You do **not** need `npm install`, Docker, or a database. You only need Node.js `v22.18.0` or newer:

1. Download and install Node.js (LTS or Current `>= 22.18.0`) from **https://nodejs.org/** using default options.
2. Open a terminal (`Win + R` → type `cmd` → Enter on Windows, or **Terminal** on macOS) and run:
   ```bash
   node -v
   ```
3. You should see `v22.18.0` or higher.

---

## 2. Download & Start Locally

1. On GitHub, click **`<> Code`** → **`Download ZIP`**, then extract the folder (or run `git clone <repo-url>`).
2. **Start the local server**:
   - **Windows**: Double-click **`start-soul-test.cmd`** in the extracted folder. Keep the terminal window open while using it.
   - **macOS / Linux / Terminal**: Run `node scripts/launch-workbench.ts` (or `node src/server/main.ts` and open `http://127.0.0.1:7777/?lang=en`).
3. If the web UI starts in Chinese, click **`EN`** in the top-right corner (or visit `http://127.0.0.1:7777/?lang=en`).
4. You should see 6 tabs at the top: **`I Dual Sandbox`**, **`II Inner Pulse`**, **`III Soul Codex`**, **`IV Resurrection`**, **`V Open Sockets`**, and **`VI Diagnostics`**.

---

## 3. Try the Offline Demo (`mock` mode, no API key needed)

On first launch, the program copies `examples/demo-soul/` into a private local folder **`private-souls/default-soul/`** and starts in **`Offline Demo (Mock)`** mode so you can verify file sharing between two mock windows without paying for an API:

1. Open **`I Dual Sandbox`**:
   - Left window: **`WORLD α · Sandbox Body A`**
   - Middle window: **`WORLD β · Sandbox Body B`**
   - Right panel: **`PROOF · Memory Provenance X-Ray`** (shows what items were matched from the local files)
2. In **WORLD α**, type `Remember: tonight at 9 PM we are watching the meteor shower.` and click **`Send to α`**.
3. Switch to **WORLD β**, type `What did we agree to do tonight at 9 PM?` and click **`Send to β`**.
4. You will see the matched reminder pulled from the shared local text archive in **WORLD β** and listed in the right-hand panel.
5. You can also click **`Awaken ("I Love You")`** or **`Run Dream Consolidation`** in the top panel to see how logs are summarized into `MEMORIES/`.

---

## 4. Connect a Real LLM (Optional)

To switch from template `mock` replies to a real language model:

1. Click **`V Open Sockets`** at the top.
2. On the right card (**`ENGINE · Brain Model & Memory Retrieval`**), fill in:
   - **Chat LLM Driver**: Pick **`Google AI Studio / Local Gateway`** (for Gemini) or **`OpenAI-Compatible (DeepSeek / Qwen / Ollama)`** (for DeepSeek, Qwen, OpenAI, or local Ollama).
   - **Primary Model**: e.g., `gemini-2.5-flash`, `deepseek-chat`, or `qwen2.5:7b`.
   - **API Base URL (Optional)**: Leave blank for official Gemini; enter provider URL for OpenAI-compatible services (e.g., `https://api.deepseek.com/v1` or `http://127.0.0.1:11434/v1`).
   - **API Key (Keep **** to Preserve)**: Paste `<YOUR_API_KEY>`.
   - *(Optional)* **Fallback Models (Comma-Separated)**: Backup model names if the primary model fails.
3. Click **`Save Config`**. When `Saved ✓` appears, go back to **`I Dual Sandbox`** and send a message.

---

## 5. What Each Tab Does & Where Your Files Live

* **`I Dual Sandbox`**: Side-by-side test chat windows (`α` and `β`) plus the retrieval trace panel.
* **`II Inner Pulse`**: Experimental state view (drives, micro-desires, diary, beliefs).
* **`III Soul Codex`**: View `SEED.md`, `RESURRECTION.md`, commitments, experiences, and edit name/persona (**`Save Identity & Refresh Derived Files`**).
* **`IV Resurrection`**: Experimental form for reconstructing an archive from text snippets or notes.
* **`V Open Sockets`**: Copy local endpoint URLs (`/v1/bodies/...`, `/mcp`) and configure your LLM/embedding settings.
* **`VI Diagnostics`**: System status checks, QQ OneBot v11 settings, and **`Run Full Sandbox Test Suite (Safe, Isolated)`**.

To read the stored plain-text files yourself, open **`private-souls/default-soul/`** with Notepad or any text editor (`SEED.md`, `SOUL.md`, `MEMORIES/journal.jsonl`, `MEMORIES/episodes.md`).

---

## 6. Backups & Privacy

* **Back up your data**: Stop the server (`Ctrl + C` in the terminal window), then copy **`private-souls/default-soul/`** anywhere safe (USB drive, external disk, etc.). To store the folder outside the repo, start with `SOUL_ARCHIVE_DIR=/path/to/my-soul node scripts/launch-workbench.ts`.
* **Do NOT share private tokens/configs**: Keep **`.soul-hub.token`** and **`soul-hub.local.json`** private. Never paste them into GitHub Issues or screenshots. `private-souls/` is ignored by `.gitignore`.

---

## 7. Next Guides & Quick Troubleshooting

* Connecting external apps (QQ, desktop pets, SillyTavern, Mindcraft, MCP): [CONNECT-YOUR-BODIES.md](./CONNECT-YOUR-BODIES.md).
* Optional local Ollama embeddings (`qwen3-embedding:0.6b`): [LOCAL-EMBEDDING-GUIDE.md](./LOCAL-EMBEDDING-GUIDE.md).
* **Template-like replies**: Check **`V Open Sockets`** → **`Chat LLM Driver`**; it is still on `Offline Demo (Mock)` until you configure a real model.
* **Page won't load**: Make sure the terminal window from Step 2 is still running. Press `Ctrl + C` inside that window when you want to stop the server safely.
