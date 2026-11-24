# 向量与 Rerank 重排配置指南（本地 Ollama & 云端千问）

《灵魂予你》默认自带**零依赖 SQLite FTS5 + CJK 双字切片 + 艾宾浩斯遗忘曲线检索引擎**，不填任何 API Key 即可开箱准确召回。当你想开启「同义词跨词联想」与「精排去噪」时，可按本指南配置本地 Ollama 或云端兼容接口（DashScope / 硅基流动）。

> **断网/无密钥自动兜底**：若未配置云端 API Key 或向量/Rerank 服务暂未启动，中枢**不会外发空密钥网络请求**，也不会报错卡死，而是自动无缝回退至离线 SQLite FTS5 检索。

---

## 方案 A：纯本地免费（Ollama `Qwen3-Embedding-0.6B`）

1. 安装 [Ollama](https://ollama.com/) 并拉取模型：
   ```powershell
   ollama pull qwen3-embedding:0.6b
   ```
2. 在网页控制台 `http://127.0.0.1:7777` → **「V 开放插座」** 中配置：
   - 勾选 **启用千问向量检索**
   - **Embedding 端点**：`http://127.0.0.1:11434/v1`
   - **Embedding 模型**：`qwen3-embedding:0.6b`
   - **Embedding API Key**：留空即可
3. 点击 **探测向量服务** → **同步增量向量索引** → **保存配置**。

---

## 方案 B：云端 Embedding + Rerank 精排（硅基流动 / DashScope）

### 1. 硅基流动（SiliconFlow，标准 OpenAI + `/v1/rerank`）
- **Embedding 端点**：`https://api.siliconflow.cn/v1`
- **Embedding 模型**：`Qwen/Qwen3-Embedding-0.6B`（或 `Qwen/Qwen3-Embedding-4B`）
- **Rerank 端点**：`https://api.siliconflow.cn/v1`
- **Rerank 模型**：`Qwen/Qwen3-Reranker-0.6B`（或 `Qwen/Qwen3-Reranker-4B`）
- **API Key**：填写你在平台申请的密钥（占位如 `<YOUR_API_KEY>`）。

### 2. 阿里云百炼（DashScope）
- **Embedding 端点**：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- **Embedding 模型**：`text-embedding-v4`（中枢已内置单批 `<= 10` 条分片兼容）
- **Rerank 端点**：`https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank`
- **Rerank 模型**：`qwen3-rerank`（中枢自动识别 `/services/rerank/` 并切换 DashScope 原生请求体）

---

## 3. 检索去噪与阈值说明

- `retriever.topK`（默认 `5`）：每轮注入上下文的最大召回碎片数。
- `retriever.minScore`（默认 `0.12`）：未开启 Rerank 时的最低混合相关度门槛，抑制零相关噪音进入 Prompt。
- `rerank.minScore`（默认 `0.25`）：开启 Rerank 后仅保留重排得分不低于阈值的片段，其余自动过滤。
- **长期事实冲突消解**：`MEMORIES/facts.jsonl` 会在做梦整理时自动执行 `ADD / UPDATE / DELETE / NONE` 状态机；旧事实标为 `superseded` 保留在纯文本供追溯，但检索与 Prompt 默认只召回 `active` 有效事实。
- **外部记忆引擎插座**：如需外接 Mem0 或 Graphiti，请参阅 [MEMORY-RETRIEVER-PROTOCOL.md](./MEMORY-RETRIEVER-PROTOCOL.md)。
