import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = ['main.js', 'manifest.json', 'styles.css'];
// These obsolete files are not loaded by the bundled plugin. Never use a wildcard:
// data.json, .iconize, icon packs, .git and unknown files belong to the user.
export const legacyFiles = [
  'icon-index-store.js',
  'icon-indexing.js',
  'icon-resolver.js',
  'inline-icon-loader.js',
  'inline-modules-patch.js',
  'analyze-jszip-syntax.js',
  'check-console.js',
  'fix-jszip-exec.js',
  'fix-jszip-final-v2.js',
  'fix-jszip-final.js',
  'fix-jszip-init.js',
  'fix-jszip-module-context.js',
  'fix-jszip-simple.js',
  'fix-jszip-wrapper.js',
  'test-obsidian-load.js',
  'test-plugin-load.js',
  'main.js.bak-20260920',
  'main.js.pre-rename-fix',
  'FINAL_SUMMARY.md',
  'INTEGRATION_REPORT.md',
  'REFACTOR_PLAN.md',
  'SVG_CLEANUP_REPORT.md',
  'README.md',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

export async function deployPlugin(
  targetDirectory,
  {
    sourceDirectory = join(projectRoot, 'dist'),
    backupDirectory = join(projectRoot, '.local-backups'),
  } = {},
) {
  const target = await realpath(resolve(targetDirectory));
  const artifacts = new Map(
    await Promise.all(
      runtimeFiles.map(async (name) => [
        name,
        await readFile(join(sourceDirectory, name)),
      ]),
    ),
  );
  const manifest = JSON.parse(artifacts.get('manifest.json').toString());
  const installed = JSON.parse(
    await readFile(join(target, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.id !== 'obsidian-icon-folder' ||
    installed.id !== manifest.id ||
    basename(target) !== manifest.id
  ) {
    throw new Error(
      'Deployment target must be the existing obsidian-icon-folder plugin directory.',
    );
  }
  const bundle = artifacts.get('main.js').toString();
  new Script(bundle, { filename: 'main.js' });
  if (/\brequire\s*\(\s*['"]\./.test(bundle))
    throw new Error('Bundle still requires local sidecar modules.');

  const deploymentId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const backup = join(backupDirectory, deploymentId);
  await mkdir(backup, { recursive: true });
  for (const name of runtimeFiles) {
    if (await exists(join(target, name)))
      await copyFile(join(target, name), join(backup, name));
  }
  const archived = [];
  for (const name of legacyFiles) {
    if (!(await exists(join(target, name)))) continue;
    await mkdir(join(backup, 'legacy'), { recursive: true });
    await copyFile(join(target, name), join(backup, 'legacy', name));
    archived.push(name);
  }

  const hashes = Object.fromEntries(
    [...artifacts].map(([name, bytes]) => [name, sha256(bytes)]),
  );
  await writeFile(
    join(backup, 'deployment.json'),
    JSON.stringify(
      { target, sourceDirectory, deploymentId, hashes, archived },
      null,
      2,
    ),
  );
  // Stage complete files first. A failed write never truncates the installed main.js.
  for (const [name, bytes] of artifacts) {
    const staging = join(target, `.${name}.${deploymentId}.tmp`);
    await writeFile(staging, bytes);
    await rename(staging, join(target, name));
  }
  for (const name of runtimeFiles) {
    if (sha256(await readFile(join(target, name))) !== hashes[name])
      throw new Error(`Verification failed: ${name}`);
  }
  for (const name of archived) await unlink(join(target, name));
  await writeFile(
    join(target, '.iconize-deployment.json'),
    JSON.stringify(
      { source: projectRoot, deploymentId, hashes, backup },
      null,
      2,
    ),
  );
  return { target, backup, hashes, archived };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    let target = process.argv[2] || process.env.ICONIZE_PLUGIN_DIR;
    if (!target && (await exists(join(projectRoot, 'env.js')))) {
      target = (await import(pathToFileURL(join(projectRoot, 'env.js')).href))
        .obsidianExportPath;
    }
    if (!target)
      throw new Error(
        'Set obsidianExportPath in env.js, ICONIZE_PLUGIN_DIR, or pass the plugin directory.',
      );
    const result = await deployPlugin(target);
    process.stdout.write(
      `Deployed to ${result.target}\nBackup: ${result.backup}\nArchived ${result.archived.length} obsolete files.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
