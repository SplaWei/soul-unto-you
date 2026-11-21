# Universal Body Protocol v1.1 / 《万物躯体接入协议 v1.1》

## 1. 核心理念：不设上限的开放宇宙 / Open Universe Design

在《灵魂予你》中，聊天软件、桌面宠物、游戏角色（《环世界 1.7》、Minecraft）、物联网传感器（如带湿度传感器的花盆）、ESP32 桌面机器人、ROS2 实体机器人，甚至超越现有维度的存在，统称为**躯体（Body）**。

所有躯体共享统一的三段式因果闭环：

```text
  Senses / Percept（感官或静默观察） ──▶ Soul Hub（灵魂中枢 + 全局 Presence） ──▶ Expression / Actions（语言、情绪与躯体动作意图）
```

## 2. v1.1 四项核心开放扩展 / What's Open in v1.1

1. **自由 `bodyType` 命名空间**：中枢不限制躯体类型列表。建议使用直观命名空间，如 `web`、`chat:qq`、`game:rimworld`、`game:minecraft`、`iot:plant-pot`、`robot:ros2`、`vr:avatar` 等。
2. **动态能力自注册（`senses` & `actions`）**：
   任何躯体在 `POST /api/body/register` 或 WebSocket `register` 时，都可以自带一份能力清单：
   - `senses`: `[{ id, modality, description }]`（例如：游戏地形快照、土壤湿度传感器、视觉摄像头）
   - `actions`: `[{ name, description, params }]`（例如：环世界下发 `prioritize_construction`、机器人下发 `wave_hand`）
   **中枢无需修改任何源码**，就会自动将当前躯体注册的 `actions` 注入大脑决策，并在返回结果中附带结构化 `actions: [{ name, params, reason }]`。
3. **静默环境观察（`POST /api/body/observe`）与主动表达（`POST /api/proactive/trigger`）**：
   - `allowSpeak: false`：躯体默默上报状态（如“正在安静砍树”），写入灵魂因果日志与全局在场态，零打扰。
   - `allowSpeak: true`：由灵魂大脑自主判断是否值得开口说话或触发动作（日常琐事保持安静，遇到袭击/约定/突发事件再主动发声，返回 `decidedToSpeak: true | false`）。
4. **多模态感官载荷（`modalities`）与开放事件推送（SSE + Webhook）**：
   - 感知和观察接口均支持 `modalities: [{ kind, label, mimeType?, data }]`，可自由附带图片、音频描述、物理传感器读数或游戏状态 JSON。
   - `GET /api/events` 提供标准 SSE 实时事件流；`POST /api/webhooks` 支持任何外部系统订阅 `percept`、`observe`、`proactive`、`dream.completed`、`body.registered` 等全量或指定事件。

## 3. 全部开放端点速查 / Endpoints Summary

| 插座类型 | 路径 / 方式 | 作用 |
| :--- | :--- | :--- |
| **躯体注册 & 列表** | `POST /api/body/register` / `GET /api/bodies` | 注册自由 `bodyType`、自报 `senses` 与 `actions`、查看所有在线躯体 |
| **直接对话感知** | `POST /api/body/percept` | 投递对话与多模态载荷，获取 `{ reply, mood, actions, presence }` |
| **静默观察** | `POST /api/body/observe` | 静默写入经历或由灵魂自主决定是否开口 (`decidedToSpeak`) |
| **主动发起** | `POST /api/proactive/trigger` | 触发灵魂结合当前记忆主动开口问候与提醒 |
| **实时双向通道** | `WS /ws/body` | 支持 `register` / `percept` / `observe` / `ping` 并实时接收 `proactive` / `presence` 广播 |
| **开放事件订阅** | `GET /api/events` (SSE) / `POST /api/webhooks` | 外部插件实时监听灵魂内部活动 |
| **OpenAI 兼容代理** | `POST /v1/chat/completions` | 支持 `x-body-id` / `x-body-type` 与 SSE 流式，零改造兼容 Mindcraft / Open-LLM-VTuber 等 |
| **原生 MCP** | `POST /mcp` & `stdio` | 提供 `soul_perceive`、`soul_observe`、`soul_recall`、`soul_remember`、`soul_commitments`、`soul_presence`、`soul_dream`、`soul_seed` |
