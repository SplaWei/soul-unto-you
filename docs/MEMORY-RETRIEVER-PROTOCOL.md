# MemoryRetriever External Socket Protocol / 外部记忆引擎插座协议

《灵魂予你》通过 `src/memory/retriever.ts` 定义了可插拔的 **`MemoryRetriever` 外部记忆插座协议**。默认使用内置混合检索引擎 `builtin-hybrid`（SQLite FTS5 + 词法 + Embedding + 通用 Rerank + 艾宾浩斯记忆保留率 + `MEMORIES/facts.jsonl` 事实冲突消解）；当需要接入 **Mem0**、**Graphiti** 或自定义 RAG/图谱微服务时，只需实现下方 3 个 HTTP 端点并在 `soul-hub.local.json` 中切换 `retriever.mode = "http"`。

> **唯一真相源原则**：外部引擎仅作为**只读检索与派生加速插座**；`SEED.md`、`SOUL.md`、`MEMORIES/*.jsonl`（含 `MEMORIES/facts.jsonl`）永远留在本地纯文本档案中。当外部服务离线、超时或返回异常格式时，Soul Hub 会自动无缝回退至 `builtin-hybrid`，并在 `recallTrace.retrieverFallbackFrom` 如实记录回退来源。

---

## 1. HTTP 插座规范 (`retriever.mode = "http"`)

当配置 `retriever.endpoint`（如 `http://127.0.0.1:8090`）后，中枢将携带 `Content-Type: application/json` 与可选 `Authorization: Bearer <apiKey>` 发起请求：

### 1.1 健康探测 `GET /health`
- **用途**：`GET /api/memory/retriever` 检查外部引擎在线状态与耗时。
- **响应体**：
  ```json
  {
    "ok": true,
    "detail": "Mem0 / Graphiti sidecar online"
  }
  ```

### 1.2 记忆召回 `POST /retrieve`
- **请求体**（由中枢在 `withSoulLock` 锁外异步发起，不阻塞并发写入）：
  ```json
  {
    "archiveId": "a1b2c3d4e5f6",
    "query": "我现在住哪、喝什么？",
    "bodyId": "qq-client-b",
    "bodyType": "chat:qq",
    "topK": 5,
    "minScore": 0.12,
    "experienceTopK": 4,
    "nowMs": 1764000000000
  }
  ```
- **响应体**（`items` 数组必填；中枢自动按 `topK` 截断并补全默认溯源与字段）：
  ```json
  {
    "embeddingActive": true,
    "embeddingModel": "Qwen/Qwen3-Embedding-0.6B",
    "rerankActive": true,
    "rerankModel": "Qwen/Qwen3-Reranker-0.6B",
    "items": [
      {
        "id": "fact_9b8e1a2c",
        "kind": "fact",
        "seq": 42,
        "score": 0.94,
        "rerankScore": 0.96,
        "bodyType": "chat:qq",
        "provenance": "verified",
        "timestamp": "2026-11-24T10:00:00.000Z",
        "title": "事实:residence",
        "text": "同行者住在成都高新区",
        "retentionPct": 100,
        "strength": 365,
        "recallCount": 1,
        "mentionCount": 1,
        "semanticSim": 0.91,
        "lexicalSim": 0.45,
        "recallReason": "外部 Mem0 有效事实",
        "recallChannels": ["rerank", "semantic"]
      }
    ],
    "experiences": []
  }
  ```
- **诚实溯源默认**：若外部引擎未返回 `provenance` 字段，中枢默认规范化为 `inferred`（推演），避免未核实外部片段被伪装成亲历记忆。

### 1.3 增量同步 `POST /sync`
- **用途**：由 `POST /api/memory/retriever/sync` 触发外部引擎与本地 `MEMORIES/*.jsonl` 同步。
- **请求体**：`{ "archiveId": "a1b2c3d4e5f6" }`
- **响应体**：`{ "ok": true, "synced": 12 }`

---

## 2. 对接 Mem0 / Graphiti 外部引擎映射建议

| SoulUntoYou 本地概念 | Mem0 桥接映射 | Graphiti (Zep) 桥接映射 |
| :--- | :--- | :--- |
| `MEMORIES/facts.jsonl` (`status: active`) | `mem0.search(query, user_id=archiveId)`（`ADD/UPDATE/DELETE/NONE`） | Temporal Graph 边 `valid_at` 且 `invalid_at == null` |
| `MEMORIES/facts.jsonl` (`status: superseded`) | Mem0 历史版本 `event=UPDATE` 的旧记录 | 已设置 `invalid_at` 的过期关系边（默认不召回） |
| `items[].kind` | `'fact'` 或 `'episode'` | `'fact'`（Edge Fact）或 `'episode'`（Episode Node） |
| `items[].provenance` | 来自原档验证标 `'verified'`，推理总结标 `'inferred'` | 原始 Episode 标 `'verified'`，摘要社区节点标 `'inferred'` |

---

## 3. `soul-hub.local.json` 常用检索组合配置参考

### 3.1 零配置离线模式（默认，无需任何 API Key）
```json
{
  "embedding": { "enabled": false, "endpoint": "http://127.0.0.1:11434/v1", "model": "qwen3-embedding:0.6b", "apiKey": "" },
  "rerank": { "enabled": false, "endpoint": "", "model": "Qwen/Qwen3-Reranker-0.6B", "apiKey": "" },
  "retriever": { "mode": "builtin", "topK": 5, "minScore": 0.12 }
}
```

### 3.2 本地 Ollama + 硅基流动 / DashScope 混合精排
```json
{
  "embedding": {
    "enabled": true,
    "endpoint": "https://api.siliconflow.cn/v1",
    "model": "Qwen/Qwen3-Embedding-0.6B",
    "apiKey": "<YOUR_API_KEY>"
  },
  "rerank": {
    "enabled": true,
    "endpoint": "https://api.siliconflow.cn/v1",
    "model": "Qwen/Qwen3-Reranker-0.6B",
    "apiKey": "<YOUR_API_KEY>",
    "topN": 5,
    "minScore": 0.25,
    "protocol": "auto"
  },
  "retriever": { "mode": "builtin", "topK": 5, "minScore": 0.12 }
}
```

### 3.3 外接独立 Mem0 / Graphiti Sidecar
```json
{
  "retriever": {
    "mode": "http",
    "endpoint": "http://127.0.0.1:8090",
    "apiKey": "<YOUR_SIDECAR_TOKEN>",
    "timeoutMs": 4000,
    "topK": 5,
    "minScore": 0.12
  }
}
```
