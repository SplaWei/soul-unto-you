import { parseSurfCoreCharacterDir } from '../src/resurrection/import-surfcore.ts';
import { reconstructFromFragments } from '../src/resurrection/reconstructor.ts';

function readArg(flag: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : '';
}

async function main(): Promise<void> {
  const source = readArg('--source');
  const target = readArg('--target');
  const partner = readArg('--partner') || '主人';

  if (!source || !target) {
    console.error('用法: node scripts/import-surfcore.ts --source <旧SurfCore角色目录> --target <新SoulArchive目录> [--partner 主人]');
    process.exitCode = 1;
    return;
  }

  const parsed = parseSurfCoreCharacterDir(source, { partnerName: partner });
  const result = await reconstructFromFragments({
    targetDir: target,
    soulName: parsed.soulName,
    partnerName: parsed.partnerName,
    personaHint: parsed.persona,
    fragments: parsed.fragments,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('迁移失败:', err);
  process.exitCode = 1;
});
