import { DataAdapter, FileSystemAdapter, Platform } from 'obsidian';
import type { ZipReader } from './zip-directory';
import { logger } from './logger';

export class ZipSourceChangedError extends Error {
  constructor() {
    super('ZIP source changed during reading');
    this.name = 'ZipSourceChangedError';
  }
}

/**
 * 桌面端仅从真实 Vault 文件系统按范围读取；移动端不加载任何 Node 模块。
 * Read ranges only from a verified desktop vault; mobile never loads Node modules.
 */
export async function createDesktopZipReader(
  adapter: DataAdapter,
  vaultPath: string,
  loadDesktopModule: NodeJS.Require | null = typeof require === 'function'
    ? require
    : null,
): Promise<ZipReader | null> {
  if (!Platform.isDesktop || !(adapter instanceof FileSystemAdapter))
    return null;
  if (!loadDesktopModule) return null;
  // Electron 渲染进程的 import() 使用 Chromium 加载器，必须用宿主提供的 CJS 加载器。
  // The renderer's import() uses Chromium resolution; use the host's CJS loader after the platform guard.
  let fs: typeof import('fs');
  let path: typeof import('path');
  try {
    fs = loadDesktopModule('fs') as typeof import('fs');
    path = loadDesktopModule('path') as typeof import('path');
  } catch (error) {
    // 桌面范围读取是可选优化；宿主没有 Node 模块时仍用适配器读取。
    // Range reads are optional; retain adapter reads when host modules are unavailable.
    logger.warn(
      'Desktop ZIP modules unavailable; using the vault adapter',
      undefined,
      error,
    );
    return null;
  }
  if (
    typeof fs?.promises?.realpath !== 'function' ||
    typeof fs?.promises?.stat !== 'function' ||
    typeof fs?.promises?.open !== 'function' ||
    typeof path?.isAbsolute !== 'function' ||
    typeof path?.resolve !== 'function' ||
    typeof path?.relative !== 'function' ||
    typeof path?.sep !== 'string'
  ) {
    logger.warn('Desktop ZIP module APIs unavailable; using the vault adapter');
    return null;
  }
  if (
    path.isAbsolute(vaultPath) ||
    vaultPath.split(/[\\/]/).some((segment) => segment === '..')
  )
    throw new Error('ZIP path must remain inside the vault');
  const root = await fs.promises.realpath(adapter.getBasePath());
  const filename = await fs.promises.realpath(path.resolve(root, vaultPath));
  const relative = path.relative(root, filename);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('ZIP path must remain inside the vault');
  const initial = await fs.promises.stat(filename);
  if (!initial.isFile()) throw new Error('ZIP source is not a regular file');
  return {
    size: initial.size,
    residentBytes: 0,
    read: async (offset, length) => {
      const handle = await fs.promises.open(filename, 'r');
      try {
        const current = await handle.stat();
        if (
          current.size !== initial.size ||
          current.mtimeMs !== initial.mtimeMs
        )
          throw new ZipSourceChangedError();
        const bytes = new Uint8Array(length);
        let total = 0;
        while (total < length) {
          const { bytesRead } = await handle.read(
            bytes,
            total,
            length - total,
            offset + total,
          );
          if (!bytesRead) throw new Error('Truncated ZIP data');
          total += bytesRead;
        }
        return bytes;
      } finally {
        await handle.close();
      }
    },
  };
}
