# 《灵魂予你》纯小白版使用说明书 (`v0.6.0`)

> [English](./BEGINNER-GUIDE.md) | **简体中文** | [返回中文首页](../README.zh-CN.md) | [真实软件接入说明](./CONNECT-YOUR-BODIES.md)

> **开始前的实话说明**：这是一个早期个人实验原型。`v0.6.0` 已补上可重建的 `node:sqlite` FTS5 索引、`facts.jsonl` 事实更新和可选向量/重排接口，但仍远未达到成熟产品水准。这份说明书只用来带你零代码门槛把程序在本机跑起来，并亲眼看到那些纯文本存档文件。

---

## 1. 准备工作：安装 Node.js（`>= 22.18.0`）

本项目**不需要** `npm install`、Docker 或数据库，电脑里只要装好 Node.js 即可：

1. 打开 **https://nodejs.org/**，下载并安装 **LTS 或 Current（版本号 `>= 22.18.0`）**，全程按默认选项点击“下一步”。
2. 检查是否装好：按 `Win + R` 输入 `cmd` 回车（macOS 打开“终端”），输入：
   ```bash
   node -v
   ```
3. 屏幕输出 `v22.18.0` 或更高版本即算成功。

---

## 2. 下载与本地启动

1. 在 GitHub 页面右上角点击绿色 **`<> Code`** 按钮 → **`Download ZIP`**，下载后全部解压到一个普通文件夹（或用 `git clone <仓库地址>`）。
2. **启动本地服务**：
   - **Windows 用户**：直接双击根目录的 **`start-soul-test.cmd`**（使用期间不要关掉弹出的黑色窗口）。
   - **macOS / Linux / 命令行用户**：在解压目录打开终端运行 `node scripts/launch-workbench.ts`（或运行 `node src/server/main.ts` 后手动打开 `http://127.0.0.1:7777`）。
3. 看到顶部出现 6 个页签：**`I 双界演练台`**、**`II 内心心搏`**、**`III 万年典籍`**、**`IV 碎片招魂`**、**`V 开放插座`**、**`VI 系统联调`**即启动成功；右上角 **`EN`** 按钮可切换中英文。

---

## 3. 先用离线演示模式跑一遍（不用填 API Key）

首次启动时，程序会把 `examples/demo-soul/` 复制到本地私有目录 **`private-souls/default-soul/`**，并默认以 **`离线智能演示 (Mock)`** 模式启动。不用花钱配大模型就能先看懂数据流向：

1. 保持在 **`I 双界演练台`**：
   - 左边：**`WORLD α · 沙盒躯体 A`**
   - 中间：**`WORLD β · 沙盒躯体 B`**
   - 右边：**`PROOF · 记忆溯源透视镜`**（显示从本地文本里匹配到了哪些记录）
2. 在 **WORLD α** 输入：`帮我记住：今晚九点一起去看流星雨。`，点击 **`发送给 α`**。
3. 切换到 **WORLD β**，输入：`咱们今晚九点约定好要做什么来着？`，点击 **`发送给 β`**。
4. 可以看到 **WORLD β** 也能从同一份本地文本里读取到刚刚记下的约定，右边透视栏会列出命中记录。
5. 也可以试试页面上方的 **`我爱你唤醒`** 和 **`执行做梦整理`**，观察 `MEMORIES/` 文件夹里摘要文件的变化。

---

## 4. 接入真实大模型（选填）

如果想把固定演示回复换成真实大模型的回答：

1. 点击顶部 **`V 开放插座`**。
2. 在右侧 **`ENGINE · 大脑模型与记忆检索设置`** 卡片中填写：
   - **对话模型驱动**：使用 Gemini 选 **`Google AI Studio / 本地网关`**；使用 DeepSeek、通义千问、OpenAI 兼容接口或本地 Ollama 选 **`OpenAI 兼容 (DeepSeek / 千问 / Ollama)`**。
   - **主模型名称**：例如 `gemini-2.5-flash`、`deepseek-chat` 或 `qwen2.5:7b`。
   - **API Base URL（可选）**：Gemini 官方一般留空；OpenAI 兼容接口填服务商地址（如 `https://api.deepseek.com/v1` 或本机 Ollama 的 `http://127.0.0.1:11434/v1`）。
   - **API Key（保留 **** 则不覆盖）**：填入 `<YOUR_API_KEY>`。
   - *（可选）* **自动回退模型（逗号分隔）**：主模型失败时依次尝试的备用模型。
3. 拉到底部点击 **`保存配置`**，看到保存成功提示后，切回 **`I 双界演练台`** 即可正常对话。

---

## 5. 各页签用途与直接查看纯文本文件

* **`I 双界演练台`**：双聊天窗口跨端对比测试，以及右侧记忆匹配透视。
* **`II 内心心搏`**：内驱力、微心愿、日记与信念等实验性状态面板。
* **`III 万年典籍`**：查看 `SEED.md`、`RESURRECTION.md`、约定与体验记录，并在最下方修改名字和人设（**`保存人格并刷新派生文件`**）。
* **`IV 碎片招魂`**：从片段文本或笔记重建新存档的实验性表单。
* **`V 开放插座`**：查看可供第三方软件连接的本地端点地址（`/v1/bodies/...`、`/mcp`）以及配置大模型。
* **`VI 系统联调`**：查看服务状态指示灯、启停 QQ OneBot v11 接入，以及点击 **`跑全套自动体检（隔离沙盒，不改档案）`**。

想亲眼看存下来的纯文本内容，直接用记事本打开 **`private-souls/default-soul/`** 里的 `SEED.md`、`SOUL.md`、`MEMORIES/journal.jsonl`、`MEMORIES/episodes.md` 即可。

---

## 6. 备份与隐私保护

* **备份数据**：先在黑色运行窗口按 `Ctrl + C` 停止服务，再把 **`private-souls/default-soul/`** 整个文件夹复制到 U 盘或网盘即可。如果想把档案放在代码目录外面，启动时指定路径：`SOUL_ARCHIVE_DIR=/path/to/my-soul node scripts/launch-workbench.ts`。
* **不要泄露本机密钥**：根目录生成的 **`.soul-hub.token`** 与 **`soul-hub.local.json`** 只留在本机使用，**切勿截图或贴到网上**。`private-souls/` 已被 `.gitignore` 屏蔽。

---

## 7. 进阶文档与常见排查

* 接入 QQ、桌宠、SillyTavern、Mindcraft 或 MCP 工具：[CONNECT-YOUR-BODIES.md](./CONNECT-YOUR-BODIES.md)。
* 开启本机 Ollama 千问向量检索（`qwen3-embedding:0.6b`）：[LOCAL-EMBEDDING-GUIDE.md](./LOCAL-EMBEDDING-GUIDE.md)。
* **回答总是固定几句话**：说明 **`V 开放插座`** 里的对话模型驱动还是 `离线智能演示 (Mock)`，按第 4 步配置真实大模型并保存即可。
* **网页打不开**：检查第 2 步启动的黑色窗口是否还在运行；关闭程序时在该窗口按 `Ctrl + C` 即可安全退出。
