// 复制到 Mindcraft 根目录作为 settings.js（先将 soul-companion.profile.json 复制为 profiles/soul-companion.json）
const settings = {
  minecraft_version: "1.21.1",
  host: "127.0.0.1",
  port: 55916,
  auth: "offline",
  language: "zh",
  render_bot_view: false,
  allow_insecure_coding: false,
  allow_vision: false,
  mindserver_port: 8080,
  auto_open_ui: false,
  profiles: [
    "./profiles/soul-companion.json"
  ]
};

export default settings;
