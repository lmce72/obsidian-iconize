import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployPlugin } from './deploy.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'iconize-deploy-'));
  roots.push(root);
  const source = join(root, 'dist');
  const target = join(root, 'plugins', 'obsidian-icon-folder');
  const backup = join(root, 'backups');
  await mkdir(source, { recursive: true });
  await mkdir(join(target, '.iconize'), { recursive: true });
  const manifest = JSON.stringify({
    id: 'obsidian-icon-folder',
    version: 'test',
  });
  for (const dir of [source, target]) {
    await writeFile(join(dir, 'manifest.json'), manifest);
    await writeFile(join(dir, 'styles.css'), dir === source ? 'new' : 'old');
    await writeFile(
      join(dir, 'main.js'),
      dir === source ? 'module.exports = class Iconize {};' : 'old bundle',
    );
  }
  await writeFile(
    join(target, 'data.json'),
    '{"settings":{},"Folder":"LiFolder"}',
  );
  await writeFile(join(target, '.iconize', 'icons.json'), 'cache');
  return {
    source,
    target,
    backup,
    options: { sourceDirectory: source, backupDirectory: backup },
  };
}

describe('safe Obsidian deployment', () => {
  it('replaces only managed artifacts and archives known legacy files without touching user data', async () => {
    const f = await fixture();
    await writeFile(join(f.target, 'icon-resolver.js'), 'legacy resolver');
    await writeFile(join(f.target, 'unknown-custom-module.js'), 'user module');
    const before = await stat(join(f.target, 'data.json'));
    const result = await deployPlugin(f.target, f.options);
    expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe(
      'module.exports = class Iconize {};',
    );
    expect(await readFile(join(result.backup, 'main.js'), 'utf8')).toBe(
      'old bundle',
    );
    expect(
      await readFile(join(result.backup, 'legacy', 'icon-resolver.js'), 'utf8'),
    ).toBe('legacy resolver');
    await expect(
      stat(join(f.target, 'icon-resolver.js')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await readFile(join(f.target, 'unknown-custom-module.js'), 'utf8'),
    ).toBe('user module');
    expect(
      await readFile(join(f.target, '.iconize', 'icons.json'), 'utf8'),
    ).toBe('cache');
    expect((await stat(join(f.target, 'data.json'))).mtimeMs).toBe(
      before.mtimeMs,
    );
    expect(
      JSON.parse(await readFile(join(f.target, 'data.json'), 'utf8')).Folder,
    ).toBe('LiFolder');
  });

  it.each(['wrong-plugin', 'sidecar', 'invalid-js'])(
    'rejects %s before changing the target',
    async (mode) => {
      const f = await fixture();
      if (mode === 'wrong-plugin')
        await writeFile(
          join(f.target, 'manifest.json'),
          '{"id":"another-plugin"}',
        );
      if (mode === 'sidecar')
        await writeFile(
          join(f.source, 'main.js'),
          'require("./icon-resolver.js");',
        );
      if (mode === 'invalid-js')
        await writeFile(join(f.source, 'main.js'), 'class {');
      await expect(deployPlugin(f.target, f.options)).rejects.toThrow();
      expect(await readFile(join(f.target, 'main.js'), 'utf8')).toBe(
        'old bundle',
      );
      await expect(stat(f.backup)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
