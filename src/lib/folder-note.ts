/**
 * Folder note 图标继承工具 / Folder note icon inheritance utilities.
 */

import IconizePlugin from '@app/main';
import icon from './icon';

// ===== PATCHED: Folder note 图标继承 / Folder note icon inheritance =====
// 已知支持 folder note 的插件及其 data.json 字段映射（开发者维护）
export const FOLDER_NOTE_PLUGIN_MAP: Record<
  string,
  { label: string; field: string }
> = {
  'folder-notes': { label: 'Folder Notes', field: 'folderNoteName' },
  'make-md': { label: 'Make.md', field: 'folderNoteName' },
  'notebook-navigator': {
    label: 'Notebook Navigator',
    field: 'folderNoteName',
  },
};

/**
 * 解析文件夹对应的 folder note 期望路径（不含 .md 扩展名）。
 */
export function resolveFolderNotePath(
  plugin: IconizePlugin,
  folderPath: string,
): string {
  const folderName = folderPath.substring(folderPath.lastIndexOf('/') + 1);
  const template = plugin.getSettings().folderNoteName;
  let name =
    template === '' || template == null
      ? folderName
      : template.replace(/\{\{folder_name\}\}/g, folderName);
  if (name.endsWith('.md')) {
    name = name.slice(0, -3);
  }
  return `${folderPath}/${name}`;
}

/**
 * 若 filePath 是某文件夹的 folder note，返回父文件夹图标名，否则返回 undefined。
 */
export function getFolderNoteInheritedIcon(
  plugin: IconizePlugin,
  filePath: string,
): string | undefined {
  if (!plugin.getSettings().inheritFolderNoteIconEnabled) {
    return undefined;
  }
  const parentFolderPath = getFolderNoteParent(plugin, filePath);
  if (!parentFolderPath) {
    return undefined;
  }

  return icon.getByPath(plugin, parentFolderPath);
}

/**
 * 若 filePath 是某文件夹的 folder note，返回该文件夹路径，否则返回 undefined。
 * Returns the folder path when `filePath` is that folder's note, otherwise undefined.
 *
 * 图标继承与颜色继承共用这段判断，避免两处各写一份路径推导。
 * Shared by icon and color inheritance so the path derivation exists once.
 */
export function getFolderNoteParent(
  plugin: IconizePlugin,
  filePath: string,
): string | undefined {
  if (!plugin.getSettings().inheritFolderNoteIconEnabled) {
    return undefined;
  }

  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) {
    return undefined;
  }

  const parentFolderPath = filePath.substring(0, lastSlash);
  const expectedBase = resolveFolderNotePath(plugin, parentFolderPath);
  if (filePath !== expectedBase && filePath !== `${expectedBase}.md`) {
    return undefined;
  }

  return parentFolderPath;
}
// ===== END PATCH =====
