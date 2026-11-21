# `adapters/minecraft-mindcraft/` — Minecraft Java 版轻量联动方案

> 通过《灵魂予你》OpenAI 兼容代理路由（`/v1/bodies/game:minecraft/mindcraft-bot`）或原生 Body Protocol，让她在 Minecraft 中的冒险记忆直接与 QQ、网页端、环世界互通。

---

## 第一步：在 PCL2 中安装独立纯净原版 Java（零干扰现有整合包）

Forge / 大型整合包常修改网络数据包，容易导致 Mineflayer 握手断开。建议专门下载一个纯净原版：

1. 打开你的 `PCL2` 启动器（保持你现有的 Forge 与整合包完全不动）。
2. 进入 **下载 → 原版下载**，选择一个纯净原版：**`1.21.1`（推荐，Mindcraft / Mineflayer 支持最稳）** 或 `1.20.4`。
3. 版本名保持默认（例如 `1.21.1`），不装 Forge / Fabric / 任何改动联机协议的 Mod。
4. 启动 `1.21.1` 后，新建或进入一个单人测试存档（建议开启**允许作弊**、设为**离线登录名称**以便本地测试）。
5. 按 `Esc` → 点击 **「对局域网开放 (Open to LAN)」** → 端口可填 **`55916`**（或记住画面提示的端口），确认开启！

---

## 第二步：接入方案 A（Mindcraft 完整智能体 · 推荐玩法）

> **重要环境提醒**：Mindcraft 依赖的部分底层图形包（如 `gl`）在 Node.js `v24+` / `v26` 上可能触发 C++ 原生编译报错，建议使用 **Node.js `20 LTS`**（可用 `nvm` 或便携 Node 20）在仓库外部单独目录运行 Mindcraft。

1. 在仓库外部目录克隆并安装 Mindcraft（`mindcraft-bots/mindcraft`）：
   ```bash
   git clone https://github.com/mindcraft-bots/mindcraft.git
   cd mindcraft
   npm install
   ```
2. 将本目录下的配置模板复制进 Mindcraft 目录：
   - `soul-companion.profile.json` → `mindcraft/profiles/soul-companion.json`
   - `settings.soul.js` → `mindcraft/settings.js`（若你在 MC 里用了别的局域网端口，请同步修改 `port` 与 `minecraft_version`）
   - `keys.example.json` → `mindcraft/keys.json`（保留占位密钥 `"soul-unto-you-local"` 即可，真实 API 密钥安全存放在《灵魂予你》中枢本地配置）
3. 确认《灵魂予你》中枢已启动：
   ```powershell
   node src/server/main.ts
   ```
4. 运行本目录预检脚本确认中枢路由与 MC 局域网端口畅通：
   ```powershell
   node adapters/minecraft-mindcraft/check-bridge.ts --mc-port 55916 --smoke
   ```
5. 启动 Mindcraft：
   ```bash
   node main.js
   ```

### 为什么指向 `/v1/bodies/game:minecraft/mindcraft-bot`？
标准 OpenAI SDK 不方便自带自定义 HTTP 请求头，因此《灵魂予你》在 `/v1` 代理中开放了躯体专属路径：
`http://127.0.0.1:7777/v1/bodies/game:minecraft/mindcraft-bot`
中枢会自动识别她此刻正处于 `game:minecraft` 躯体中，自动注入她的灵魂人格、未完约定与跨端记忆，并保留 Mindcraft 的游戏指令系统提示词。

---

## 第三步：接入方案 B（极简 Mineflayer 伴侣脚本）

如果你当前环境仅装了最新版 Node.js 不想折腾 `gl` 编译，可使用同目录的 `mineflayer-minimal-blueprint.mjs`：
1. 在仓库外部新建一个空文件夹并执行 `npm install mineflayer`。
2. 复制 `mineflayer-minimal-blueprint.mjs` 到该目录，修改 `MC_PORT` 为游戏局域网端口后运行：
   ```powershell
   node mineflayer-minimal-blueprint.mjs
   ```
   即可在 MC 聊天栏直接和她对话、同步出生点与受伤危机观察。

---

## 第四步：跨端联动实测闭环

1. 在 Minecraft 游戏内对她说：**「我们今晚一起先把木屋庇护所搭好，明天再下矿挖铁！」**
2. 等待闲置自动做梦整理触发（或在网页控制台点一次 **执行做梦整理**）。
3. 切到 QQ（或网页端 B 窗）只问一句：**「早安，昨晚在方块世界说好要干嘛来着？」**
4. 她会带着 `[game:minecraft]` 记忆自然续上你们建木屋和挖铁的约定！
