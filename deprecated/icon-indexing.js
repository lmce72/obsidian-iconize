/**
 * Icon Indexing Utilities - 图标索引构建工具
 * Utilities for building lightweight icon pack indexes
 *
 * 构建轻量级索引，仅包含元数据，不解析 SVG 内容
 * Builds lightweight indexes containing only metadata, without parsing SVG
 */

'use strict';

const JSZip = require('jszip');

/**
 * 构建图标包索引
 * Build icon pack index from source
 *
 * @param {Object} plugin - Iconize plugin instance
 * @param {string} packName - Icon pack name
 * @param {string} sourcePath - Path to ZIP file or folder
 * @param {string} prefix - Icon prefix (e.g., "Li" for Lucide)
 * @param {string} extraPath - Extra path inside ZIP (optional)
 * @returns {Promise<Object>} Index object
 */
async function buildIconPackIndex(
  plugin,
  packName,
  sourcePath,
  prefix,
  extraPath = '',
) {
  const adapter = plugin.app.vault.adapter;

  try {
    // 判断源类型 / Determine source type
    const isZip = sourcePath.endsWith('.zip');

    let entries = [];
    let fingerprint = '';

    if (isZip) {
      // 从 ZIP 构建索引 / Build index from ZIP
      const result = await buildIndexFromZip(
        adapter,
        sourcePath,
        prefix,
        extraPath,
      );
      entries = result.entries;
      fingerprint = result.fingerprint;
    } else {
      // 从文件夹构建索引 / Build index from folder
      const result = await buildIndexFromFolder(adapter, sourcePath, prefix);
      entries = result.entries;
      fingerprint = result.fingerprint;
    }

    return {
      name: packName,
      prefix: prefix,
      fingerprint: fingerprint,
      entries: entries,
      indexedAt: Date.now(),
      version: 1, // Index format version
    };
  } catch (error) {
    console.error(
      `[IconIndexing] Failed to build index for ${packName}:`,
      error,
    );
    throw error;
  }
}

/**
 * 从 ZIP 文件构建索引
 * Build index from ZIP file
 */
async function buildIndexFromZip(adapter, zipPath, prefix, extraPath) {
  const entries = [];

  try {
    // 读取 ZIP 文件 / Read ZIP file
    const zipContent = await adapter.readBinary(zipPath);
    const zip = await JSZip.loadAsync(zipContent);

    // 计算指纹（使用文件大小作为简单指纹）/ Calculate fingerprint
    const fingerprint = `zip-${zipContent.byteLength}`;

    // 遍历 ZIP 中的 SVG 文件 / Iterate SVG files in ZIP
    zip.forEach((relativePath, file) => {
      // 跳过目录和非 SVG 文件 / Skip directories and non-SVG files
      if (file.dir || !relativePath.toLowerCase().endsWith('.svg')) {
        return;
      }

      // 检查是否在指定的 extraPath 下 / Check if under extraPath
      if (extraPath && !relativePath.startsWith(extraPath)) {
        return;
      }

      // 提取文件名 / Extract filename
      const filename = relativePath.split('/').pop();
      const nameWithoutExt = filename.replace('.svg', '');

      // 生成规范化名称和 ID / Generate normalized name and ID
      const normalizedName = getNormalizedName(nameWithoutExt);
      const iconId = `${prefix}${normalizedName}`;

      entries.push({
        id: iconId,
        name: normalizedName,
        filename: extraPath ? relativePath : filename,
        prefix: prefix,
      });
    });

    console.log(
      `[IconIndexing] Indexed ${entries.length} icons from ZIP: ${zipPath}`,
    );
    return { entries, fingerprint };
  } catch (error) {
    console.error(`[IconIndexing] Failed to read ZIP: ${zipPath}`, error);
    throw error;
  }
}

/**
 * 从文件夹构建索引
 * Build index from folder
 */
async function buildIndexFromFolder(adapter, folderPath, prefix) {
  const entries = [];

  try {
    // 列出文件夹内容 / List folder contents
    const listing = await adapter.list(folderPath);

    // 递归收集所有 SVG 文件 / Recursively collect all SVG files
    const svgFiles = await collectSvgFiles(adapter, folderPath, listing);

    // 计算指纹（使用文件数量和最后修改时间）/ Calculate fingerprint
    const fingerprint = `folder-${svgFiles.length}-${Date.now()}`;

    for (const filePath of svgFiles) {
      const filename = filePath.split('/').pop();
      const nameWithoutExt = filename.replace('.svg', '');
      const normalizedName = getNormalizedName(nameWithoutExt);
      const iconId = `${prefix}${normalizedName}`;

      entries.push({
        id: iconId,
        name: normalizedName,
        filename: filename,
        prefix: prefix,
        path: filePath, // 保存完整路径用于文件夹模式 / Save full path for folder mode
      });
    }

    console.log(
      `[IconIndexing] Indexed ${entries.length} icons from folder: ${folderPath}`,
    );
    return { entries, fingerprint };
  } catch (error) {
    console.error(`[IconIndexing] Failed to read folder: ${folderPath}`, error);
    throw error;
  }
}

/**
 * 递归收集文件夹中的所有 SVG 文件
 * Recursively collect all SVG files in folder
 */
async function collectSvgFiles(adapter, basePath, listing) {
  const svgFiles = [];

  // 添加当前层级的 SVG 文件 / Add SVG files at current level
  for (const file of listing.files) {
    if (file.toLowerCase().endsWith('.svg')) {
      svgFiles.push(file);
    }
  }

  // 递归处理子文件夹 / Recursively process subfolders
  for (const folder of listing.folders) {
    try {
      const subListing = await adapter.list(folder);
      const subFiles = await collectSvgFiles(adapter, folder, subListing);
      svgFiles.push(...subFiles);
    } catch (error) {
      console.warn(`[IconIndexing] Failed to read subfolder: ${folder}`, error);
    }
  }

  return svgFiles;
}

/**
 * 规范化图标名称（移除特殊字符，转换为 PascalCase）
 * Normalize icon name (remove special chars, convert to PascalCase)
 *
 * @param {string} name - Original icon name
 * @returns {string} Normalized name
 */
function getNormalizedName(name) {
  return name
    .split(/[-_\s]+/)
    .map((part) => capitalize(part))
    .join('');
}

/**
 * 首字母大写
 * Capitalize first letter
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * 创建图标包前缀
 * Create icon pack prefix from name
 *
 * @param {string} name - Icon pack name
 * @returns {string} Prefix (e.g., "font-awesome-solid" -> "Fas")
 */
function createIconPackPrefix(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
    .substring(0, 3); // Limit to 3 characters
}

/**
 * 获取 ZIP 文件指纹（用于检测变更）
 * Get ZIP file fingerprint (for change detection)
 *
 * @param {Object} plugin - Iconize plugin instance
 * @param {string} zipPath - Path to ZIP file
 * @returns {Promise<string>} Fingerprint string
 */
async function getZipFingerprint(plugin, zipPath) {
  try {
    const stat = await plugin.app.vault.adapter.stat(zipPath);
    if (stat) {
      // 使用文件大小和修改时间作为指纹 / Use size and mtime as fingerprint
      return `${stat.size}-${stat.mtime}`;
    }
  } catch (error) {
    console.warn(
      `[IconIndexing] Failed to get fingerprint for ${zipPath}:`,
      error,
    );
  }

  // 回退到读取文件大小 / Fallback to file size
  try {
    const content = await plugin.app.vault.adapter.readBinary(zipPath);
    return `zip-${content.byteLength}`;
  } catch (error) {
    console.error(`[IconIndexing] Failed to read ${zipPath}:`, error);
    return `unknown-${Date.now()}`;
  }
}

/**
 * 获取文件夹指纹
 * Get folder fingerprint
 *
 * @param {Object} adapter - Vault adapter
 * @param {string} folderPath - Path to folder
 * @returns {Promise<string>} Fingerprint string
 */
async function getFolderFingerprint(adapter, folderPath) {
  try {
    const listing = await adapter.list(folderPath);
    const fileCount = listing.files.length;
    return `folder-${fileCount}-${Date.now()}`;
  } catch (error) {
    console.error(`[IconIndexing] Failed to get folder fingerprint:`, error);
    return `unknown-${Date.now()}`;
  }
}

module.exports = {
  buildIconPackIndex,
  buildIndexFromZip,
  buildIndexFromFolder,
  getNormalizedName,
  createIconPackPrefix,
  getZipFingerprint,
  getFolderFingerprint,
};
