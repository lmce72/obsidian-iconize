// 可重复的独立进程索引基准；不启动 Obsidian，也不读取 Vault。
// Reproducible isolated-process index benchmark; no Obsidian or vault access.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import ts from 'typescript';

async function benchmark(CompactIconIndex) {
  globalThis.window = globalThis;
  const count = Number(process.argv[2]);
  const mode = process.argv[3];
  const memory = () => {
    const m = process.memoryUsage();
    return { heap: m.heapUsed, arrayBuffers: m.arrayBuffers, rss: m.rss };
  };
  function* entries() {
    for (let row = 0; row < count; row++) {
      const name = 'Icon' + row;
      yield {
        id: 'Sy' + name,
        name,
        displayName: 'icon-' + row,
        folder: 'icons',
        path: 'icons/icon-' + row + '.svg',
      };
    }
  }
  globalThis.gc();
  const initial = memory();
  let beats = 0,
    maximumGap = 0,
    previous = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    beats++;
    maximumGap = Math.max(maximumGap, now - previous);
    previous = now;
  }, 1);
  const start = performance.now();
  let compact, rows, byKey, lookup;
  if (mode === 'compact')
    compact = await CompactIconIndex.fromEntries(entries());
  else {
    rows = Array.from(entries());
    byKey = new Map();
    lookup = new Map();
    let deadline = performance.now() + 8,
      visited = 0;
    const source = {};
    for (const row of rows) {
      byKey.set(row.id.toLowerCase(), row);
      const name = row.name.toLowerCase();
      if (!byKey.has(name)) byKey.set(name, row);
      if (++visited % 256 === 0 && performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        deadline = performance.now() + 8;
      }
    }
    for (const row of rows) {
      const located = {
        packName: 'synthetic',
        prefix: 'Sy',
        entry: row,
        source,
      };
      lookup.set(row.id.toLowerCase(), located);
      const name = row.name.toLowerCase();
      if (!lookup.has(name)) lookup.set(name, located);
      if (++visited % 256 === 0 && performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        deadline = performance.now() + 8;
      }
    }
  }
  const buildMs = performance.now() - start;
  await new Promise((resolve) => setTimeout(resolve, 2));
  globalThis.gc();
  const retained = memory();
  const searches = [];
  for (const query of [
    'no-such-icon-zzzz',
    String(count - 1),
    'icon-42',
    'icon',
  ]) {
    let found = 0;
    const began = performance.now();
    if (compact)
      await compact.forEachMatch(
        [query],
        'synthetic',
        () => ++found < 100,
        () => false,
      );
    else {
      let deadline = performance.now() + 8,
        visited = 0;
      for (const row of rows) {
        if (
          (row.id + ' ' + row.displayName + ' synthetic')
            .toLowerCase()
            .includes(query) &&
          ++found >= 100
        )
          break;
        if (++visited % 256 === 0 && performance.now() >= deadline) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          deadline = performance.now() + 8;
        }
      }
    }
    searches.push({ query, matches: found, ms: performance.now() - began });
  }
  const exactStart = performance.now();
  let exactFound = 0;
  for (let row = 0; row < 10000; row++) {
    const query = 'syicon' + ((row * 997) % count);
    if (
      compact ? compact.getEntry(query) : byKey.get(query) && lookup.get(query)
    )
      exactFound++;
  }
  const exact10000Ms = performance.now() - exactStart;
  clearInterval(heartbeat);
  console.log(
    JSON.stringify({
      mode,
      count,
      buildMs,
      retainedDelta: {
        heap: retained.heap - initial.heap,
        arrayBuffers: retained.arrayBuffers - initial.arrayBuffers,
        rss: retained.rss - initial.rss,
      },
      storage: compact?.getStorageStats(),
      exactFound,
      exact10000Ms,
      heartbeat: beats,
      maximumHeartbeatGapMs: maximumGap,
      searches,
    }),
  );
}

const count = Number(process.argv[2] ?? 1_000_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 5_000_000)
  throw new Error('Use an icon count from 1 to 5000000');
const temporary = await mkdtemp(join(tmpdir(), 'iconize-index-bench-'));
try {
  const entry = join(temporary, 'entry.mjs');
  const output = join(temporary, 'benchmark.mjs');
  const source = fileURLToPath(
    new URL('../src/lib/compact-icon-index.ts', import.meta.url),
  );
  await writeFile(
    entry,
    `import { CompactIconIndex } from ${JSON.stringify(source)};\n(${benchmark.toString()})(CompactIconIndex);`,
  );
  const bundle = await rollup({
    input: entry,
    plugins: [
      nodeResolve({ extensions: ['.js', '.mjs', '.ts'] }),
      {
        name: 'benchmark-typescript',
        transform(code, id) {
          return id.endsWith('.ts')
            ? ts.transpileModule(code, {
                compilerOptions: {
                  module: ts.ModuleKind.ESNext,
                  target: ts.ScriptTarget.ES2020,
                },
              }).outputText
            : null;
        },
      },
    ],
  });
  await bundle.write({ file: output, format: 'es' });
  await bundle.close();
  console.log(
    JSON.stringify({
      runtime: process.version,
      platform: process.platform,
      count,
      note: 'Synthetic Node index-only benchmark; not Windows Chromium or whole Obsidian memory.',
    }),
  );
  for (const mode of ['legacy', 'compact'])
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--expose-gc', output, String(count), mode],
        {
          stdio: 'inherit',
          timeout:
            count <= 1_000_000
              ? 5000
              : (Math.ceil((count / 1_000_000) * 3) + 3) * 1000,
        },
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Benchmark ${mode} failed (${code})`)),
      );
    });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
