import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloneConfig,
  equalConfig,
  mergeConfig,
  stampConfigChanges,
  parseConfig,
  rebaseConfig,
} from './lib/config-merge';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { IconCache } from './lib/icon-cache';
import { isHexadecimal, stringToHex } from './util';

// Exercise the actual class methods with an isolated adapter; never load a vault
// or replace Obsidian's runtime. AST extraction excludes unrelated UI dependencies.
const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');
const ast = ts.createSourceFile(
  'main.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const declaration = ast.statements.find(ts.isClassDeclaration)!;
const methods = [
  'getConfigurationStatus',
  'getConfigurationBackups',
  'readConfigurationBackup',
  'previewConfigurationBackup',
  'restoreConfiguration',
  'retryConfiguration',
  'withConfigurationMaintenance',
  'getConfigPath',
  'getSettings',
  'removeFolderIcon',
  'setConfigPath',
  'loadIconFolderData',
  'saveIconFolderData',
  'scheduleConfigSave',
  'readCurrentConfig',
  'flushConfigSave',
  'writeConfigSnapshot',
  'saveConfigurationNow',
  'registerIconPathEvents',
  'renameFolder',
  'getFrontmatterIcon',
  'refreshFrontmatterIcon',
  'getIconColor',
  'recordIconRemoval',
  'stampLocalConfigChanges',
  'finishConfigInitialization',
  'getConfigCheckpointKey',
  'preserveConfigHistory',
  'updateConfigCheckpoint',
  'initializeConfigSafety',
  'ensureConfigDirectory',
  'scheduleConfigRefresh',
  'refreshExternalConfig',
  'onExternalSettingsChange',
];
const code = ts.transpile(
  `class Probe {${declaration.members
    .filter((m) => m.name && methods.includes(m.name.getText(ast)))
    .map((m) => m.getText(ast))
    .join('\n')}}`,
  { target: ts.ScriptTarget.ES2022 },
);
const Notice = vi.fn();
const checkpointStorage = new Map<string, string>();
class TFile {
  constructor(public path: string) {}
}
const defaults = { fontSize: 16, debugMode: false };
const Probe = new Function(
  'cloneConfig',
  'equalConfig',
  'mergeConfig',
  'stampConfigChanges',
  'parseConfig',
  'rebaseConfig',
  'DEFAULT_SETTINGS',
  'Notice',
  'stateRoot',
  'window',
  'emoji',
  'logger',
  'removeIconFromIconPack',
  'TFile',
  'IconCache',
  'isHexadecimal',
  'stringToHex',
  'getAllOpenedFiles',
  'dom',
  `${code}; return Probe;`,
)(
  cloneConfig,
  equalConfig,
  mergeConfig,
  stampConfigChanges,
  parseConfig,
  rebaseConfig,
  defaults,
  Notice,
  () => '.plugin/.iconize',
  {
    setTimeout: (callback: () => void, delay: number) =>
      window.setTimeout(callback, delay),
    localStorage: {
      getItem: (key: string) => checkpointStorage.get(key) ?? null,
      setItem: (key: string, value: string) =>
        checkpointStorage.set(key, value),
    },
  },
  { isEmoji: () => true },
  { warn: vi.fn() },
  vi.fn(),
  TFile,
  IconCache,
  isHexadecimal,
  stringToHex,
  () => [],
  { createIconNode: vi.fn() },
);

async function fixture() {
  const baseline: Record<string, any> = {
    settings: { fontSize: 16, debugMode: false },
    'old.md': 'LiHome',
    'deleted.md': 'LiBook',
  };
  const path = 'Configs/iconize.json';
  const files = new Map<string, string>([
    [path, JSON.stringify(baseline, null, 2)],
  ]);
  const dirs = new Set(['Configs']);
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  const adapter = {
    list: vi.fn(async (dir: string) => ({
      files: [...files.keys()].filter(
        (path) =>
          path.startsWith(`${dir}/`) &&
          !path.slice(dir.length + 1).includes('/'),
      ),
      folders: [],
    })),
    exists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
    read: vi.fn(async (p: string) => files.get(p)!),
    mkdir: vi.fn(async (p: string) => {
      dirs.add(p);
    }),
    write: vi.fn(async (p: string, value: string) => {
      files.set(p, value);
    }),
    copy: vi.fn(async (from: string, to: string) => {
      if (files.has(to)) throw new Error('EEXIST: copy destination exists');
      files.set(to, files.get(from)!);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (files.has(to)) throw new Error('Destination file already exists!');
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    process: vi.fn(async (path: string, update: (raw: string) => string) => {
      if (!files.has(path)) throw new Error('ENOENT: process source missing');
      const next = update(files.get(path)!);
      files.set(path, next);
      return next;
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  const plugin = Object.assign(new Probe(), {
    configPath: path,
    configSessionId: 'test',
    configLoadState: 'missing',
    initializing: true,
    configBaseline: {},
    _lastSavedConfig: null,
    _savePending: false,
    _saveDebounceTimer: null,
    configRefreshTimer: null,
    saveWaiters: [],
    app: {
      vault: {
        adapter,
        getName: () => 'TestVault',
        on: (event: string, handler: (...args: any[]) => void) => {
          (handlers[event] ??= []).push(handler);
          return {};
        },
      },
    },
    registerEvent: vi.fn(),
    _refreshFileExplorerIcon: vi.fn(),
    refreshConfiguredIcons: vi.fn(),
    handleChangeLayout: vi.fn(),
  });
  await plugin.loadIconFolderData();
  const ready = () => {
    plugin.finishConfigInitialization();
  };
  const disk = () => JSON.parse(files.get(path)!);
  const remote = (data: unknown) =>
    files.set(path, JSON.stringify(data, null, 2));
  const flush = async () => {
    const promise = plugin.saveIconFolderData();
    await vi.advanceTimersByTimeAsync(800);
    await promise;
  };
  const emit = (event: string, ...args: any[]) =>
    handlers[event]?.forEach((handler) => handler(...args));
  return {
    plugin,
    baseline,
    path,
    files,
    adapter,
    ready,
    disk,
    remote,
    flush,
    emit,
  };
}

beforeEach(() => {
  checkpointStorage.clear();
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mtime-sensitive config persistence', () => {
  it('discards a delayed external refresh that started before manual recovery', async () => {
    const f = await fixture();
    f.ready();
    const stale = JSON.stringify({ settings: {}, remote: 'LiStar' });
    f.files.set(f.path, stale);
    f.files.set(`${f.path}.bak`, JSON.stringify(f.baseline));
    let release!: (raw: string) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalRead = f.adapter.read.getMockImplementation()!;
    let first = true;
    f.adapter.read.mockImplementation(async (path) => {
      if (path === f.path && first) {
        first = false;
        started();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      }
      return originalRead(path);
    });
    const refresh = f.plugin.refreshExternalConfig();
    await waiting;
    await f.plugin.restoreConfiguration(`${f.path}.bak`);
    release(stale);
    await refresh;
    expect(f.plugin.data.remote).toBeUndefined();
    expect(f.plugin.data['old.md']).toBe('LiHome');
  });
  it('restores a valid backup after corruption and retains the original bytes and pending local edits', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.data.unsaved = 'LiHeart';
    const pending = f.plugin.saveIconFolderData();
    f.files.set(`${f.path}.bak`, JSON.stringify(f.baseline));
    f.files.set(f.path, '{broken JSON');
    expect(
      await f.plugin.previewConfigurationBackup(`${f.path}.bak`),
    ).toContain('2 条');
    await f.plugin.restoreConfiguration(`${f.path}.bak`);
    await pending;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.disk()['old.md']).toBe('LiHome');
    expect(f.disk().unsaved).toBeUndefined();
    expect(
      [...f.files].some(
        ([path, raw]) => path.endsWith('.original') && raw === '{broken JSON',
      ),
    ).toBe(true);
    expect(
      [...f.files.values()].some(
        (raw) =>
          raw.includes('before-manual-restore') && raw.includes('unsaved'),
      ),
    ).toBe(true);
    expect(f.plugin.getConfigurationStatus()).toContain('配置读取正常');
  });

  it('refuses to overwrite a new synchronized config arriving during recovery', async () => {
    const f = await fixture();
    f.ready();
    f.files.set(`${f.path}.bak`, JSON.stringify(f.baseline));
    const originalProcess = f.adapter.process.getMockImplementation()!;
    f.adapter.process.mockImplementation(async (path, update) => {
      f.files.set(path, JSON.stringify({ settings: {}, remote: 'LiStar' }));
      return originalProcess(path, update);
    });
    await expect(
      f.plugin.restoreConfiguration(`${f.path}.bak`),
    ).rejects.toThrow('配置已变化');
    expect(f.disk().remote).toBe('LiStar');
    expect(f.plugin.configMaintenance).toBe(false);
  });

  it('restores a missing config and rejects a history snapshot for another config path', async () => {
    const f = await fixture();
    f.ready();
    f.files.set(`${f.path}.bak`, JSON.stringify(f.baseline));
    f.files.delete(f.path);
    await f.plugin.restoreConfiguration(`${f.path}.bak`);
    expect(f.disk()['old.md']).toBe('LiHome');
    const history =
      '.plugin/.iconize/config-history/other-1790000000000-1.json';
    await f.adapter.mkdir('.plugin/.iconize/config-history');
    f.files.set(
      history,
      JSON.stringify({ configPath: 'Other.json', config: f.baseline }),
    );
    await expect(f.plugin.previewConfigurationBackup(history)).rejects.toThrow(
      '配置路径不同',
    );
  });

  it('exposes the actual invalid setting and retries successfully once repaired', async () => {
    const f = await fixture();
    f.ready();
    f.files.set(f.path, JSON.stringify({ settings: { iconPacksPath: [] } }));
    await f.plugin.loadIconFolderData();
    expect(f.plugin.getConfigurationStatus()).toContain(
      'Invalid setting: iconPacksPath',
    );
    const broken = f.files.get(f.path);
    await f.plugin.saveIconFolderData();
    expect(f.files.get(f.path)).toBe(broken);
    f.files.set(f.path, JSON.stringify(f.baseline));
    await f.plugin.retryConfiguration();
    expect(f.plugin.getConfigurationStatus()).toContain('配置读取正常');
    expect(f.plugin.data['old.md']).toBe('LiHome');
  });

  it('overwrites existing config and backup through supported APIs on successive saves', async () => {
    const f = await fixture();
    f.ready();
    f.files.set(`${f.path}.bak`, 'an older backup already exists');
    f.plugin.data.first = 'LiStar';
    await f.flush();
    expect(JSON.parse(f.files.get(`${f.path}.bak`)!)['old.md']).toBe('LiHome');
    const first = f.files.get(f.path);
    f.plugin.data.second = 'LiBook';
    await f.flush();
    expect(f.files.get(`${f.path}.bak`)).toBe(first);
    expect(f.disk()).toMatchObject({ first: 'LiStar', second: 'LiBook' });
    expect(f.adapter.copy).not.toHaveBeenCalled();
    expect(f.adapter.rename).not.toHaveBeenCalled();
    expect(f.adapter.process).toHaveBeenCalledTimes(2);
    expect(f.files.has('.plugin/.iconize/config-pending-test.json')).toBe(
      false,
    );
    expect(f.plugin.configLastSaveError).toBeNull();
  });

  it('rejects a change arriving immediately before process commits and records the real cause', async () => {
    const f = await fixture();
    f.ready();
    const process = f.adapter.process.getMockImplementation()!;
    const remote = { ...f.baseline, remote: 'LiStar' };
    f.adapter.process.mockImplementation(async (path, update) => {
      f.remote(remote);
      return process(path, update);
    });
    f.plugin.data.local = 'LiBug';
    await f.flush();
    expect(f.disk()).toEqual(remote);
    expect(f.plugin.configSaveSucceeded).toBe(false);
    const recovery = JSON.parse(
      f.files.get('.plugin/.iconize/config-local-recovery-test.json')!,
    );
    expect(recovery.local.local).toBe('LiBug');
    expect(recovery.failure).toMatchObject({
      stage: '提交配置',
      message: expect.stringContaining('changed before commit'),
    });
    expect(Notice).toHaveBeenLastCalledWith(
      expect.stringContaining('changed before commit'),
      0,
    );
  });

  it('creates a genuinely new config with write and uses process only for later replacements', async () => {
    const f = await fixture();
    f.files.delete(f.path);
    await f.plugin.loadIconFolderData();
    f.ready();
    f.plugin.data.Folder = 'LiFolder';
    await f.flush();
    expect(f.disk().Folder).toBe('LiFolder');
    expect(f.adapter.process).not.toHaveBeenCalled();
    expect(f.files.has(`${f.path}.bak`)).toBe(false);
    f.plugin.data.Other = 'LiBook';
    await f.flush();
    expect(f.adapter.process).toHaveBeenCalledTimes(1);
    expect(f.disk()).toMatchObject({ Folder: 'LiFolder', Other: 'LiBook' });
  });

  it('unions an incomplete external config and automatically writes back missing icons', async () => {
    const f = await fixture();
    f.ready();
    const remote = cloneConfig(f.baseline);
    delete remote['old.md'];
    remote['remote.md'] = 'LiStar';
    f.remote(remote);
    await f.plugin.refreshExternalConfig();
    expect(f.plugin.data['old.md']).toBe('LiHome');
    expect(f.plugin.data['remote.md']).toBe('LiStar');
    await vi.advanceTimersByTimeAsync(800);
    expect(f.disk()['old.md']).toBe('LiHome');
    expect(f.disk()['remote.md']).toBe('LiStar');
    expect(f.adapter.process).toHaveBeenCalledTimes(1);
    const writes = f.adapter.process.mock.calls.length;
    await f.plugin.refreshExternalConfig();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.adapter.process).toHaveBeenCalledTimes(writes);
  });

  it('records explicit icon removal so another device can accept it safely', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.removeFolderIcon('old.md');
    await vi.advanceTimersByTimeAsync(800);
    expect(f.disk()['old.md']).toBeUndefined();
    expect(f.disk().settings.configRemovals['old.md']).toBe('LiHome');
    expect(f.disk().settings.configItemVersions['icon:old.md'].deleted).toBe(
      true,
    );
  });

  it('recovers icons after an offline external overwrite using the device-local checkpoint pointer', async () => {
    const f = await fixture();
    await f.plugin.initializeConfigSafety();
    const remote = cloneConfig(f.baseline);
    delete remote['old.md'];
    remote.remote = 'LiStar';
    f.remote(remote);
    const restarted = Object.assign(new Probe(), f.plugin, {
      configSessionId: 'restarted',
      configHistorySequence: 0,
      initializing: true,
      configRecoveryPending: false,
      configBaseline: {},
      data: undefined,
    });
    await restarted.loadIconFolderData();
    await restarted.initializeConfigSafety();
    expect(restarted.data['old.md']).toBe('LiHome');
    expect(restarted.data.remote).toBe('LiStar');
    expect(f.disk()['old.md']).toBeUndefined();
    expect(restarted.configRecoveryPending).toBe(true);
    restarted.finishConfigInitialization();
    await vi.advanceTimersByTimeAsync(800);
    expect(f.disk()['old.md']).toBe('LiHome');
    expect(f.disk().remote).toBe('LiStar');
  });

  it('does not restore an explicitly removed icon on restart or write an unchanged startup checkpoint', async () => {
    const f = await fixture();
    await f.plugin.initializeConfigSafety();
    const before = f.adapter.write.mock.calls.length;
    await f.plugin.initializeConfigSafety();
    expect(f.adapter.write.mock.calls).toHaveLength(before);
    const remote = cloneConfig(f.baseline);
    delete remote['old.md'];
    remote.settings.configRemovals = { 'old.md': 'LiHome' };
    f.remote(remote);
    await f.plugin.loadIconFolderData();
    await f.plugin.initializeConfigSafety();
    expect(f.plugin.data['old.md']).toBeUndefined();
    expect(f.plugin.configRecoveryPending).not.toBe(true);
  });

  it('keeps immutable history versions through repeated saves instead of rotating them away', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.data.first = 'LiBug';
    await f.plugin.saveConfigurationNow();
    const previous = new Map(
      [...f.files].filter(([path]) => path.includes('/config-history/')),
    );
    f.plugin.data.second = 'LiStar';
    await f.plugin.saveConfigurationNow();
    expect(previous.size).toBeGreaterThan(0);
    for (const [path, raw] of previous) expect(f.files.get(path)).toBe(raw);
    expect(
      [...f.files.keys()].filter((path) => path.includes('/config-history/'))
        .length,
    ).toBeGreaterThan(previous.size);
  });

  it('manual save immediately flushes a pending edit and cancels its debounce', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.data.Folder = 'LiFolder';
    const queued = f.plugin.saveIconFolderData();
    await f.plugin.saveConfigurationNow();
    await queued;
    expect(f.disk().Folder).toBe('LiFolder');
    expect(f.adapter.process).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.adapter.process).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenLastCalledWith(
      expect.stringContaining('已保存到'),
    );
  });

  it('manual save does not touch unchanged config or report a failed save as success', async () => {
    const f = await fixture();
    f.ready();
    await f.plugin.saveConfigurationNow();
    expect(f.adapter.write).not.toHaveBeenCalled();
    f.plugin.data['old.md'] = 'LiBug';
    f.adapter.process.mockRejectedValueOnce(new Error('storage unavailable'));
    Notice.mockClear();
    await f.plugin.saveConfigurationNow();
    expect(f.disk()['old.md']).toBe('LiHome');
    expect(Notice).not.toHaveBeenCalledWith(
      expect.stringContaining('已保存到'),
    );
    expect(f.plugin.configSaveSucceeded).toBe(false);
  });

  it('manual save waits for an in-flight write and immediately saves the next edit', async () => {
    const f = await fixture();
    f.ready();
    const write = f.adapter.write.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.adapter.write.mockImplementationOnce(async (path, value) => {
      await blocked;
      await write(path, value);
    });
    f.plugin.data.first = 'LiBug';
    const first = f.plugin.flushConfigSave();
    // Let staging begin before changing the second icon.
    await vi.waitFor(() => expect(f.adapter.write).toHaveBeenCalled(), {
      interval: 1,
    });
    f.plugin.data.second = 'LiStar';
    const second = f.plugin.saveIconFolderData();
    const manual = f.plugin.saveConfigurationNow();
    release();
    await Promise.all([first, second, manual]);
    expect(f.disk().first).toBe('LiBug');
    expect(f.disk().second).toBe('LiStar');
    expect(f.adapter.process).toHaveBeenCalledTimes(2);
  });

  it('moves every child icon on folder rename without pruning temporarily absent paths', async () => {
    const f = await fixture();
    f.ready();
    Object.assign(f.plugin.data, {
      'Parent/Child': { iconName: 'LiFolder', iconColor: 'red' },
      'Parent/Child/note.md': 'LiBook',
      'Parent2/Other': 'LiStar',
      TemporarilyMissing: 'LiHeart',
    });
    f.plugin.app.vault.getAbstractFileByPath = () => null;
    f.plugin.registerIconPathEvents();
    f.emit('rename', { path: 'Moved' }, 'Parent');
    await f.plugin.saveConfigurationNow();
    expect(f.disk()['Moved/Child']).toEqual({
      iconName: 'LiFolder',
      iconColor: 'red',
    });
    expect(f.disk()['Moved/Child/note.md']).toBe('LiBook');
    expect(f.disk()['Parent/Child']).toBeUndefined();
    expect(f.disk()['Parent2/Other']).toBe('LiStar');
    expect(f.disk().TemporarilyMissing).toBe('LiHeart');
  });

  it('retains folder assignments through delete/create file replacement events', async () => {
    const f = await fixture();
    f.plugin.data.Folder = 'LiFolder';
    f.plugin.data['Folder/note.md'] = 'LiBook';
    f.ready();
    f.plugin.registerIconPathEvents();
    f.emit('delete', { path: 'Folder' });
    f.emit('create', { path: 'Folder' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.plugin.data.Folder).toBe('LiFolder');
    expect(f.plugin.data['Folder/note.md']).toBe('LiBook');
    expect(f.adapter.write).not.toHaveBeenCalled();
    expect(f.plugin._refreshFileExplorerIcon).toHaveBeenCalledWith('Folder');
  });

  it('frontmatter overrides and removal never erase a folder icon or enter later config saves', async () => {
    const f = await fixture();
    const note = new TFile('Folder/Folder.md');
    let frontmatter: Record<string, unknown> | undefined = {
      icon: 'LiStar',
      iconColor: 'ff0000',
    };
    f.plugin.app.vault.getAbstractFileByPath = (path: string) =>
      path === note.path ? note : null;
    f.plugin.app.metadataCache = { getFileCache: () => ({ frontmatter }) };
    Object.assign(f.plugin.data.settings, {
      iconInFrontmatterEnabled: true,
      iconInFrontmatterFieldName: 'icon',
      iconColorInFrontmatterFieldName: 'iconColor',
      inheritFolderNoteIconEnabled: true,
      bidirectionalFolderNoteIconSyncEnabled: true,
    });
    f.plugin.data.Folder = 'LiFolder';
    f.plugin.data[note.path] = 'LiBook';
    f.ready();
    f.plugin.refreshFrontmatterIcon(note);
    expect(f.plugin.getFrontmatterIcon(note.path)).toEqual({
      iconName: 'LiStar',
      iconColor: '#ff0000',
    });
    expect(f.plugin.getIconColor(note.path)).toBe('#ff0000');
    await f.plugin.saveConfigurationNow();
    expect(f.adapter.write).not.toHaveBeenCalled();
    frontmatter = undefined;
    f.plugin.refreshFrontmatterIcon(note);
    expect(f.plugin.getFrontmatterIcon(note.path)).toBeUndefined();
    expect(f.plugin.data.Folder).toBe('LiFolder');
    expect(f.plugin.data[note.path]).toBe('LiBook');
    f.plugin.data.unrelated = 'LiBug';
    await f.plugin.saveConfigurationNow();
    expect(f.disk().Folder).toBe('LiFolder');
    expect(f.disk()[note.path]).toBe('LiBook');
  });

  it('uses ordinary file notifications to refresh only the configured file without writing it', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.registerIconPathEvents();
    f.remote({ ...f.baseline, remote: 'LiStar' });
    f.emit('modify', { path: 'unrelated.md' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.plugin.data.remote).toBeUndefined();
    f.emit('modify', { path: f.path });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.plugin.data.remote).toBe('LiStar');
    expect(
      f.adapter.write.mock.calls.every(([path]) =>
        path.includes('/config-history/'),
      ),
    ).toBe(true);
    expect(f.adapter.rename).not.toHaveBeenCalled();
  });

  it('startup normalization and unchanged saves perform no writes or additional reads', async () => {
    const f = await fixture();
    f.plugin.data.settings.fontSize = 18;
    await f.plugin.saveIconFolderData();
    f.ready();
    await f.flush();
    expect(f.adapter.read).toHaveBeenCalledTimes(1);
    expect(f.adapter.write).not.toHaveBeenCalled();
    expect(f.adapter.copy).not.toHaveBeenCalled();
    expect(f.adapter.rename).not.toHaveBeenCalled();
    expect(f.disk()).toEqual(f.baseline);
  });

  it('coalesces a burst into one config replacement and one backup', async () => {
    const f = await fixture();
    f.ready();
    const promises = [];
    for (let i = 0; i < 20; i++) {
      f.plugin.data['local.md'] = `LiIcon${i}`;
      promises.push(f.plugin.saveIconFolderData());
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(f.adapter.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    await Promise.all(promises);
    expect(f.disk()['local.md']).toBe('LiIcon19');
    expect(f.adapter.process).toHaveBeenCalledTimes(1);
    expect(
      f.adapter.write.mock.calls.filter(([path]) => path === `${f.path}.bak`),
    ).toHaveLength(1);
    await f.flush();
    expect(f.adapter.process).toHaveBeenCalledTimes(1);
  });

  it('preserves remote additions, deletions, edits and settings alongside local changes', async () => {
    const f = await fixture();
    f.ready();
    const remote = cloneConfig(f.baseline);
    remote['remote.md'] = 'LiStar';
    remote['old.md'] = 'LiHeart';
    delete remote['deleted.md'];
    remote.settings.configRemovals = { 'deleted.md': f.baseline['deleted.md'] };
    remote.settings.fontSize = 24;
    f.remote(remote);
    f.plugin.data['local.md'] = 'LiBug';
    await f.flush();
    expect(f.disk()).toMatchObject({ ...remote, 'local.md': 'LiBug' });
    expect(f.disk()['deleted.md']).toBeUndefined();
    expect(f.plugin.data).toEqual(f.disk());
  });

  it('refreshes external changes without touching mtime or echoing them back', async () => {
    const f = await fixture();
    f.ready();
    f.remote({ ...f.baseline, 'remote.md': 'LiStar' });
    await f.plugin.refreshExternalConfig();
    await f.flush();
    expect(f.plugin.data['remote.md']).toBe('LiStar');
    expect(
      f.adapter.write.mock.calls.every(([path]) =>
        path.includes('/config-history/'),
      ),
    ).toBe(true);
    expect(f.adapter.rename).not.toHaveBeenCalled();
  });

  it('selects the newer item and retains both versions in immutable history', async () => {
    const f = await fixture();
    f.ready();
    const remote = stampConfigChanges(
      f.baseline,
      { ...f.baseline, 'old.md': 'LiHeart' },
      'remote',
      Date.now() + 10000,
    );
    f.remote(remote);
    f.plugin.data['old.md'] = 'LiBug';
    await f.flush();
    expect(f.disk()['old.md']).toBe('LiHeart');
    expect(f.plugin.data['old.md']).toBe('LiHeart');
    const history = [...f.files]
      .filter(([path]) => path.includes('/config-history/'))
      .map(([, raw]) => JSON.parse(raw));
    expect(
      history.some(
        (snapshot) =>
          snapshot.local['old.md'] === 'LiBug' &&
          snapshot.incoming?.['old.md'] === 'LiHeart',
      ),
    ).toBe(true);
  });

  it.each(['partial', 'missing'])(
    'refuses an externally %s config instead of recreating or overwriting it',
    async (mode) => {
      const f = await fixture();
      f.ready();
      if (mode === 'partial') f.files.set(f.path, '{"settings":');
      else f.files.delete(f.path);
      f.plugin.data['local.md'] = 'LiBug';
      await f.flush();
      expect(f.adapter.rename).not.toHaveBeenCalled();
      expect(f.files.get(f.path)).toBe(
        mode === 'partial' ? '{"settings":' : undefined,
      );
      expect(
        f.files.has('.plugin/.iconize/config-local-recovery-test.json'),
      ).toBe(true);
    },
  );

  it('detects an external write during staging and retains both versions', async () => {
    const f = await fixture();
    f.ready();
    const write = f.adapter.write.getMockImplementation()!;
    f.adapter.write.mockImplementation(async (path, data) => {
      await write(path, data);
      if (path.endsWith('config-pending-test.json'))
        f.remote({ ...f.baseline, 'remote.md': 'LiStar' });
    });
    f.plugin.data['local.md'] = 'LiBug';
    await f.flush();
    expect(f.disk()['remote.md']).toBe('LiStar');
    expect(f.adapter.rename).not.toHaveBeenCalled();
    expect(
      f.files.has('.plugin/.iconize/config-local-recovery-test.json'),
    ).toBe(true);
  });

  it('does not mark a failed replacement as saved, so the next attempt retries', async () => {
    const f = await fixture();
    f.ready();
    f.adapter.process.mockRejectedValueOnce(new Error('storage unavailable'));
    f.plugin.data['local.md'] = 'LiBug';
    await f.flush();
    expect(f.disk()['local.md']).toBeUndefined();
    await f.flush();
    expect(f.disk()['local.md']).toBe('LiBug');
    expect(f.adapter.process).toHaveBeenCalledTimes(2);
  });

  it('preserves edits arriving during a save and serializes the follow-up batch', async () => {
    const f = await fixture();
    f.ready();
    let second: Promise<void> | undefined;
    const write = f.adapter.write.getMockImplementation()!;
    f.adapter.write.mockImplementation(async (path, data) => {
      await write(path, data);
      if (path.endsWith('config-pending-test.json') && !second) {
        f.plugin.data['second.md'] = 'LiCheck';
        second = f.plugin.saveIconFolderData();
      }
    });
    f.plugin.data['first.md'] = 'LiBug';
    await f.flush();
    expect(f.plugin.data['second.md']).toBe('LiCheck');
    await vi.advanceTimersByTimeAsync(800);
    await second;
    expect(f.disk()['second.md']).toBe('LiCheck');
    expect(f.adapter.process).toHaveBeenCalledTimes(2);
  });
  it('ignores formatting-only remote changes and does not refresh mtime', async () => {
    const f = await fixture();
    f.ready();
    f.files.set(f.path, JSON.stringify(f.baseline));
    await f.plugin.refreshExternalConfig();
    await f.flush();
    expect(f.adapter.write).not.toHaveBeenCalled();
    expect(f.adapter.rename).not.toHaveBeenCalled();
  });

  it('preserves a new local edit to a remotely changed icon while saving', async () => {
    const f = await fixture();
    f.ready();
    f.remote({ ...f.baseline, 'old.md': 'LiHeart' });
    const write = f.adapter.write.getMockImplementation()!;
    let next: Promise<void> | undefined;
    f.adapter.write.mockImplementation(async (path, data) => {
      await write(path, data);
      if (path.endsWith('config-pending-test.json') && !next) {
        f.plugin.data['old.md'] = 'LiBug';
        next = f.plugin.saveIconFolderData();
      }
    });
    f.plugin.data['local.md'] = 'LiStar';
    await f.flush();
    expect(f.plugin.data['old.md']).toBe('LiBug');
    expect(f.disk()['old.md']).toBe('LiHeart');
    await vi.advanceTimersByTimeAsync(800);
    await next;
    expect(f.disk()['old.md']).toBe('LiBug');
    expect(f.disk()['local.md']).toBe('LiStar');
  });

  it('keeps a path when it is absent without a deletion tombstone', () => {
    const base = { settings: {}, 'note.md': 'LiHome' };
    expect(
      mergeConfig(base, { settings: {} }, { ...base, 'note.md': 'LiHeart' })[
        'note.md'
      ],
    ).toBe('LiHeart');
  });

  it('detects an external write during backup before replacing the config', async () => {
    const f = await fixture();
    f.ready();
    const write = f.adapter.write.getMockImplementation()!;
    f.adapter.write.mockImplementation(async (path, value) => {
      await write(path, value);
      if (path === `${f.path}.bak`)
        f.remote({ ...f.baseline, 'remote.md': 'LiStar' });
    });
    f.plugin.data['local.md'] = 'LiBug';
    await f.flush();
    expect(f.disk()['remote.md']).toBe('LiStar');
    expect(f.adapter.rename).not.toHaveBeenCalled();
  });
  it('keeps both independent icon edits while the newer recent-history item wins', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.configBaseline.settings.recentlyUsedIcons = ['LiHome'];
    f.plugin.configBaseline.settings.recentlyUsedIconsSize = 2;
    f.plugin.data.settings.recentlyUsedIcons = ['LiBug', 'LiHome'];
    f.plugin.data.settings.recentlyUsedIconsSize = 2;
    f.plugin.data['local.md'] = 'LiBug';
    f.remote({
      ...f.baseline,
      'remote.md': 'LiStar',
      settings: {
        ...f.baseline.settings,
        recentlyUsedIcons: ['LiStar', 'LiHome'],
        recentlyUsedIconsSize: 2,
      },
    });
    await f.flush();
    expect(f.disk()['local.md']).toBe('LiBug');
    expect(f.disk()['remote.md']).toBe('LiStar');
    expect(f.disk().settings.recentlyUsedIcons).toEqual(['LiBug', 'LiHome']);
  });
  it('metadata-derived icon removal does not save shared configuration', async () => {
    const f = await fixture();
    f.ready();
    f.plugin.removeFolderIcon('old.md', false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.plugin.data['old.md']).toBeUndefined();
    expect(f.disk()['old.md']).toBe('LiHome');
    expect(f.adapter.write).not.toHaveBeenCalled();
    expect(f.plugin.saveWaiters).toHaveLength(0);
  });
});
