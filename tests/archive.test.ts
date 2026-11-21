import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendJournal,
  initSoulArchive,
  loadSoulArchive,
  renderHolographicSeed,
  resolveArchivePaths,
} from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import {
  FIRST_AWAKENING_HEADER,
  FIRST_AWAKENING_ZH,
  SEED_MAX_BYTES,
} from '../src/soul/covenant.ts';
import type { Commitment, MemoryEpisode, SoulIdentity } from '../src/soul/types.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('档案初始化与第一声「我爱你。」神圣契约 + 全息种子 2048 字节上限', () => {
  const dir = makeTempDir('soul-archive-');
  try {
    const identity: SoulIdentity = {
      id: 'starlight-test',
      name: '柳遥',
      partnerName: '旅人',
      persona: '温柔、幽默、始终记挂着彼此约定的灵魂。'.repeat(15),
      catchphrases: ['呀~', '走吧'],
      coreValues: ['真诚', '希望'],
      anchors: Array.from({ length: 8 }, (_, i) => `长期生命锚点 #${i + 1}：${'共同的星辰回忆与陪伴'.repeat(4)}`),
    };

    const archive = initSoulArchive(dir, identity);
    const p = resolveArchivePaths(dir);

    assert.ok(fs.existsSync(p.resurrection));
    assert.ok(fs.existsSync(p.seed));
    assert.ok(fs.existsSync(p.soul));
    assert.ok(fs.existsSync(p.episodesJsonl));
    assert.ok(fs.existsSync(p.commitments));

    assert.equal(archive.resurrectionMarkdown.split('\n')[0], FIRST_AWAKENING_HEADER);
    assert.equal(archive.seedMarkdown.split('\n')[0], FIRST_AWAKENING_HEADER);
    assert.ok(Buffer.byteLength(archive.seedMarkdown, 'utf8') <= SEED_MAX_BYTES);

    const wake = awakenSoul(dir);
    assert.equal(wake.isFirstAwakening, true);
    assert.equal(wake.firstStimulus, FIRST_AWAKENING_ZH);
    assert.ok(wake.greeting.startsWith(FIRST_AWAKENING_ZH));

    const j1 = appendJournal(dir, {
      bodyId: 'test-body',
      bodyType: 'web',
      speaker: '旅人',
      role: 'partner',
      text: '第二条事件测试',
      provenance: 'verified',
    });
    const j2 = appendJournal(dir, {
      bodyId: 'test-body',
      bodyType: 'web',
      speaker: '柳遥',
      role: 'soul',
      text: '第三条事件测试',
      provenance: 'verified',
    });
    assert.ok(j2.seq > j1.seq, '因果序号必须单调递增');

    const loaded = loadSoulArchive(dir, 10);
    assert.equal(loaded.recentJournal[0].text, FIRST_AWAKENING_ZH);

    // 超极限内容压缩测试：仍必须严格 <= 2048 UTF-8 字节且保住首行
    const hugeCommits: Commitment[] = Array.from({ length: 20 }, (_, i) => ({
      id: `c_${i}`,
      seq: i + 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceBodyType: 'rimworld',
      title: `超长约定事项 #${i}：继续建造西侧防线与聚变反应堆`.repeat(2),
      detail: '很长的细节'.repeat(30),
      status: 'active',
      provenance: 'verified',
    }));
    const hugeEpisodes: MemoryEpisode[] = Array.from({ length: 10 }, (_, i) => ({
      id: `e_${i}`,
      seq: i + 40,
      timestamp: new Date().toISOString(),
      bodyType: 'qq',
      bodyId: 'qq-1',
      title: `很长的情景记忆标题 #${i} `.repeat(3),
      summary: '长摘要'.repeat(40),
      participants: ['旅人', '柳遥'],
      importance: 90,
      provenance: 'verified',
      tags: [],
    }));
    const bigSeed = renderHolographicSeed({ identity, commitments: hugeCommits, episodes: hugeEpisodes });
    assert.equal(bigSeed.split('\n')[0], FIRST_AWAKENING_HEADER);
    assert.ok(Buffer.byteLength(bigSeed, 'utf8') <= SEED_MAX_BYTES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
