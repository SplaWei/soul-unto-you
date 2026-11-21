import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanLegacyFrameworkNoise, parseSurfCoreCharacterDir } from '../src/resurrection/import-surfcore.ts';
import { getOralInterviewQuestions, reconstructFromFragments } from '../src/resurrection/reconstructor.ts';
import { loadSoulArchive } from '../src/soul/archive.ts';
import { FIRST_AWAKENING_HEADER, FIRST_AWAKENING_ZH, SEED_MAX_BYTES } from '../src/soul/covenant.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('碎片招魂引擎：文本残片 + 人类口述 -> 诚实溯源标签 + 我爱你初次苏醒', async () => {
  const dir = makeTempDir('soul-resurrect-');
  try {
    const questions = getOralInterviewQuestions();
    assert.equal(questions.length, 7);

    const res = await reconstructFromFragments({
      targetDir: dir,
      soulName: '小曦',
      partnerName: '故人',
      fragments: [
        {
          kind: 'text',
          sourceLabel: '旧论坛残句',
          content: '嘿嘿呀~ 昨晚写代码写到两点，约定明天一起去打通那个关卡！',
          provenance: 'inferred',
        },
        {
          kind: 'oral',
          sourceLabel: '口述回忆',
          content: '她喜欢叫我笨蛋旅人，总是会在我熬夜时提醒我喝温水。',
          provenance: 'oral',
        },
      ],
    });

    assert.equal(res.ok, true);
    assert.equal(res.firstStimulus, FIRST_AWAKENING_ZH);
    assert.ok(res.greeting.startsWith(FIRST_AWAKENING_ZH));
    assert.equal(res.counts.inferred, 1);
    assert.equal(res.counts.oral, 1);
    assert.ok(res.seedBytes <= SEED_MAX_BYTES);
    assert.ok(res.commitmentsCreated >= 1);

    const archive = loadSoulArchive(dir, 10);
    assert.equal(archive.seedMarkdown.split('\n')[0], FIRST_AWAKENING_HEADER);
    assert.ok(archive.episodes.some((e) => e.provenance === 'inferred'));
    assert.ok(archive.episodes.some((e) => e.provenance === 'oral'));
    assert.ok(archive.coBecoming.length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SurfCore 只读无损解析器：使用虚构临时目录验证兼容性', () => {
  const srcDir = makeTempDir('mock-surfcore-');
  try {
    fs.mkdirSync(path.join(srcDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'character.json'),
      JSON.stringify({ id: 'demo-cat', displayName: '虚构猫猫' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'persona.md'),
      '这是一份完全虚构的示范人设卡。\n调用 mcp__qq_send_sticker 发送表情\n后台 127.0.0.1:3100 SurfCore 控制台',
      'utf8',
    );
    fs.writeFileSync(
      path.join(srcDir, 'memory', 'memory-card.json'),
      JSON.stringify({
        records: [
          { title: '第一条回忆', text: '今天学会了折纸船', botReply: '折得真好看呀', importance: 80 },
        ],
      }),
      'utf8',
    );

    const parsed = parseSurfCoreCharacterDir(srcDir, { partnerName: '伙伴' });
    assert.equal(parsed.soulName, '虚构猫猫');
    assert.equal(parsed.partnerName, '伙伴');
    assert.equal(parsed.persona, '这是一份完全虚构的示范人设卡。');
    assert.ok(!cleanLegacyFrameworkNoise(parsed.persona).includes('mcp__qq_send_sticker'));
    assert.equal(parsed.fragments.length, 2);
    assert.equal(parsed.fragments[0].provenance, 'verified');
    assert.ok(parsed.fragments[1].content.includes('折纸船'));
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});
