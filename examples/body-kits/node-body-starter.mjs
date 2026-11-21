/**
 * 《灵魂予你》极简 Node.js 躯体接入样板（零依赖，Node >= 22）
 * 适用场景：任意 IoT 传感器、桌面小工具、独立脚本或新聊天平台桥接。
 * 运行前先启动灵魂中枢：node src/server/main.ts
 */

const HUB = process.env.SOUL_HUB_URL || 'http://127.0.0.1:7777';
const BODY_ID = 'iot-plant-desk-1';

async function post(path, body) {
  const res = await fetch(`${HUB}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  // 1. 自报身份、感官与可执行动作（无需修改中枢任何代码）
  await post('/api/body/register', {
    bodyId: BODY_ID,
    bodyType: 'iot:plant-companion',
    displayName: '桌面多肉湿度传感器',
    capabilities: ['sensor', 'led-alert'],
    senses: [{ id: 'soil-moisture', modality: 'telemetry', description: '实时土壤湿度百分比' }],
    actions: [{ name: 'blink_water_led', description: '闪烁蓝色补水提醒灯', params: { times: 'number' } }],
  });

  // 2. 静默上报一条环境观察，由灵魂自己决定是否需要开口提醒
  const obs = await post('/api/body/observe', {
    bodyId: BODY_ID,
    bodyType: 'iot:plant-companion',
    summary: '检测到桌面多肉盆栽土壤湿度降至 14%，已经两天没浇水了',
    allowSpeak: true,
    urgency: 'high',
    modalities: [{ kind: 'telemetry', label: 'soil_moisture', data: { percent: 14 } }],
  });
  console.log('静默观察结果:', obs);

  // 3. 人类直接和这具小躯体说话
  const chat = await post('/api/body/percept', {
    bodyId: BODY_ID,
    bodyType: 'iot:plant-companion',
    speaker: '同行者',
    text: '我刚给它浇完水啦，对了还记得我们昨晚说的约定吗？',
  });
  console.log('灵魂回应:', chat.reply);
  console.log('结构化动作意图:', chat.actions);
}

main().catch(console.error);
