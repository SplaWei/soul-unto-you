# 本地轻量向量检索配置指南（可选 · `Qwen3-Embedding-0.6B`）

《灵魂予你》默认自带**零外部依赖的 CJK 二元组 + 词法检索引擎**，开箱即可跨躯体精确召回关键词记忆。当你累积了数百上千条跨越数月/数年的情景记忆，希望连「语义相近但用词不同」的回忆也能秒级联想时，可按本指南开启本地轻量向量检索。

---

## 1. 准备本地 Ollama + `Qwen3-Embedding-0.6B`

1. 安装 [Ollama](https://ollama.com/)（约 0.6B 参数模型仅占用不到 1GB 显存/内存，12GB VRAM 可轻松常驻运行）。
2. 拉取轻量中文强力嵌入模型：
   ```powershell
   ollama pull qwen3-embedding:0.6b
   ```
3. 验证 Ollama OpenAI 兼容 Embeddings 接口可用：
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:11434/v1/embeddings" -Method Post -ContentType "application/json" -Body '{"model":"qwen3-embedding:0.6b","input":["昨晚在环世界修西侧防线"]}'
   ```

---

## 2. 在《灵魂予你》中开启向量索引

1. 打开网页控制台 `http://127.0.0.1:7777` → 切换到 **「🔌 万能插座与设置」**。
2. 勾选 **「启用千问向量检索」**：
   - **Embedding 端点**：`http://127.0.0.1:11434/v1`
   - **Embedding 模型**：`qwen3-embedding:0.6b`
3. 点击 **保存配置**。

---

## 3. 自动索引与检索验证

- 每次执行 **手动做梦整理**（`POST /api/dream`）或 **闲置自动做梦整理** 时，`syncVectorIndex()` 会自动把新增的情景记忆卡向量化并写入灵魂存档的 `INDEX/vectors.json`（纯 JSON 文本格式，仍脱离数据库独立永存）。
- 日常对话中 `recallMemories()` 会按 `0.55 * 语义相似度 + 0.20 * 词法匹配 + 0.15 * 重要度 + 0.10 * 时效性` 混合加权排序；若本地 Ollama 暂未启动，中枢会自动无缝回退到纯词法检索，**绝不报错或阻塞对话**。
