"""
《灵魂予你》极简 Python 躯体接入样板（仅使用标准库 urllib，零第三方依赖）
适用场景：ROS2 实体机器人 (rclpy)、桌面语音、PyGame 或树莓派硬件。
运行前请先启动中枢：node src/server/main.ts
"""

import json
import os
import urllib.request

HUB = os.environ.get("SOUL_HUB_URL", "http://127.0.0.1:7777")
BODY_ID = "robot-companion-1"


def post_json(path: str, payload: dict) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{HUB}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
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
