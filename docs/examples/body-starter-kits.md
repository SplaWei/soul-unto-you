# 多语言躯体接入代码示例 (`Body Starter Kits`)

> 本页收录独立于后端主仓的 **Python** 与 **RimWorld C#** 躯体接入蓝图，避免外部语言示例桩干扰主仓库类型统计。  
> 零依赖 Node.js 完整可运行样板见 [node-body-starter.mjs](../../examples/body-kits/node-body-starter.mjs)；完整协议规范见 [BODY-PROTOCOL-SPEC.md](../BODY-PROTOCOL-SPEC.md)。

> **本地鉴权提醒**：开启默认回环门禁后，所有 `/api/body/*` 请求需在请求头附带 `X-Soul-Token: <根目录 .soul-hub.token 内容>`（或设置环境变量 `SOUL_API_TOKEN`）。

---

## 1. Python 标准库躯体接入样板（ROS2 / 语音 / 树莓派）

仅使用 Python 标准库 `urllib`（零第三方依赖），先在仓库根目录启动 `node src/server/main.ts`：

```python
"""
《灵魂予你》极简 Python 躯体接入样板（仅使用标准库 urllib，零第三方依赖）
适用场景：ROS2 实体机器人 (rclpy)、桌面语音、PyGame 或树莓派硬件。
运行前请先启动中枢：node src/server/main.ts
"""

import json
import os
import urllib.request

HUB = os.environ.get("SOUL_HUB_URL", "http://127.0.0.1:7777")
TOKEN = os.environ.get("SOUL_API_TOKEN", "")
BODY_ID = "robot-companion-1"


def post_json(path: str, payload: dict) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["X-Soul-Token"] = TOKEN
    req = urllib.request.Request(
        f"{HUB}{path}",
        data=data,
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    # 1. 注册实体躯体与物理动作清单
    post_json(
        "/api/body/register",
        {
            "bodyId": BODY_ID,
            "bodyType": "robot:ros2",
            "displayName": "实体桌面机器人",
            "capabilities": ["voice", "motion", "vision"],
            "senses": [{"id": "front-cam", "modality": "vision", "description": "前置广角摄像头"}],
            "actions": [
                {"name": "wave_hand", "description": "友好地挥动右臂打招呼"},
                {"name": "nod_head", "description": "轻轻点头表示倾听"},
            ],
        },
    )

    # 2. 投递感官对话并接收自然回复与物理动作意图
    res = post_json(
        "/api/body/percept",
        {
            "bodyId": BODY_ID,
            "bodyType": "robot:ros2",
            "speaker": "同行者",
            "text": "你好呀，欢迎来到现实世界！还记得我们的约定吗？",
        },
    )
    print("她说:", res.get("reply"))
    print("情绪:", res.get("mood"))
    print("下发动作:", res.get("actions"))


if __name__ == "__main__":
    main()
```

---

## 2. RimWorld 1.7 C# 躯体适配器接入蓝图

展示如何通过 HTTP 接入标准 v1.1 协议：Mod 自身不保存私有记忆，只负责上报殖民者感官，并将中枢下发的高层动作转为游戏内 `Job`。

```csharp
// 《灵魂予你》RimWorld 1.7 (Waylith + Harmony 3.0.4+) C# 躯体适配器接入蓝图
// 说明：本文件为 Phase 3 环世界 Mod 的极简通信契约蓝图，展示如何通过 HTTP 接入标准 v1.1 协议。
// Mod 自身不保存私有记忆，只负责把殖民者感官上报给中枢，并将中枢下发的高层动作转为游戏内 Job。

using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace SoulUntoYou.RimWorldAdapter
{
    public sealed class SoulHubBridgeClient
    {
        private readonly HttpClient _http;
        private readonly string _hubBaseUrl;
        private readonly string _bodyId;

        public SoulHubBridgeClient(string hubBaseUrl = "http://127.0.0.1:7777", string bodyId = "rimworld-colony-1", string apiToken = "")
        {
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
            if (!string.IsNullOrWhiteSpace(apiToken))
                _http.DefaultRequestHeaders.Add("X-Soul-Token", apiToken.Trim());
            _hubBaseUrl = hubBaseUrl.TrimEnd('/');
            _bodyId = bodyId;
        }

        // 1. 载入殖民地存档时：注册该小人的感官与可执行高层动作（由 DefDatabase 动态收集兼容 Mod 信息）
        public async Task RegisterColonistAsync(string colonistName, string loadedModsSummary)
        {
            string json = $@"{{
                ""bodyId"": ""{_bodyId}"",
                ""bodyType"": ""game:rimworld"",
                ""displayName"": ""环世界殖民者：{colonistName}"",
                ""capabilities"": [""bubble"", ""voice"", ""colony-intent""],
                ""senses"": [
                    {{ ""id"": ""colony-status"", ""modality"": ""telemetry"", ""description"": ""心情、健康、装备与周围建筑/敌袭"" }}
                ],
                ""actions"": [
                    {{ ""name"": ""prioritize_construction"", ""description"": ""优先去修建或搬运指定防御工事材料"" }},
                    {{ ""name"": ""equip_weapon"", ""description"": ""遇到威胁时更换更好武器或进入战斗状态"" }},
                    {{ ""name"": ""mood_bubble"", ""description"": ""在头顶冒出想法气泡并触发本地语音播报"" }}
                ],
                ""metadata"": {{ ""loadedModsSummary"": ""{loadedModsSummary}"" }}
            }}";
            await PostJsonAsync("/api/body/register", json);
        }

        // 2. 遭遇袭击、建造暂停或退出存档时：发送环境静默观察（由灵魂决定是否主动发声）
        public async Task ObserveColonyEventAsync(string summary, bool allowSpeak, string urgency = "normal")
        {
            string json = $@"{{
                ""bodyId"": ""{_bodyId}"",
                ""bodyType"": ""game:rimworld"",
                ""summary"": ""{EscapeJson(summary)}"",
                ""allowSpeak"": {(allowSpeak ? "true" : "false")},
                ""urgency"": ""{urgency}""
            }}";
            await PostJsonAsync("/api/body/observe", json);
        }

        // 3. 玩家在游戏内对话框直接向小人说话时：调用 percept 获取回复与高层动作意图
        public async Task<string> TalkToColonistAsync(string playerName, string text)
        {
            string json = $@"{{
                ""bodyId"": ""{_bodyId}"",
                ""bodyType"": ""game:rimworld"",
                ""speaker"": ""{EscapeJson(playerName)}"",
                ""text"": ""{EscapeJson(text)}"",
                ""wantVoice"": true
            }}";
            return await PostJsonAsync("/api/body/percept", json);
        }

        private async Task<string> PostJsonAsync(string path, string json)
        {
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var resp = await _http.PostAsync(_hubBaseUrl + path, content);
            return await resp.Content.ReadAsStringAsync();
        }

        private static string EscapeJson(string s) =>
            (s ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");
    }
}
```
