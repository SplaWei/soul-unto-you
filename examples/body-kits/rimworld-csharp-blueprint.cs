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

        public SoulHubBridgeClient(string hubBaseUrl = "http://127.0.0.1:7777", string bodyId = "rimworld-colony-1")
        {
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
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
