/**
 * 图标包导入契约 / Icon pack import contracts.
 *
 * 所有格式先被归一化为一组独立 SVG，再打包成插件一直使用的 ZIP 字节流；
 * 运行期只看到普通图标包，不需要知道它来自 Iconify、sprite 还是字体。
 *
 * Every format is normalized into standalone SVGs and repacked into the ZIP
 * byte stream the plugin already understands. The runtime only sees an ordinary
 * icon pack and never has to know whether it came from Iconify, a sprite or a font.
 */

/** 写入归一化归档的清单文件名 / Manifest written into every normalized archive. */
export const PACK_MANIFEST_NAME = 'iconize-pack.json';

/** 导入器能识别的图标包标准 / Icon pack standards the importer recognizes. */
export type IconPackFormat =
  | 'iconize-zip'
  | 'svg-archive'
  | 'iconify-json'
  | 'svg-sprite'
  | 'svg-file'
  | 'npm-package'
  | 'font-package'
  | 'js-icon-module';

/** 用户选中的一个文件 / One file selected by the user. */
export interface PackInputFile {
  fileName: string;
  bytes: Uint8Array;
}

/** 转换过程可用的协作入口 / Cooperative hooks available to converters. */
export interface ImportContext {
  /** 中途取消 / Cancellation. */
  signal?: AbortSignal;
  /** 面向用户的进度文字 / Human-readable progress. */
  onProgress?: (message: string) => void;
  /** 让出主线程；测试可替换为空实现 / Yield to the main thread. */
  yieldToMain?: () => Promise<void>;
}

/**
 * 转换器产出的一个图标 / One icon produced by a converter.
 *
 * `name` 不含前缀与扩展名；前缀由图标包名统一推导，因此不同包的同名图标不会冲突。
 * `name` carries no prefix and no extension: the pack prefix is derived from the
 * pack name, so equal names in different packs never collide.
 */
export interface GeneratedIcon {
  name: string;
  /** 相对图标包根目录的目录，用于区分同名文件 / Folder used to keep equal names apart. */
  folder?: string;
  /** 独立可渲染的完整 SVG 标记 / Complete, standalone SVG markup. */
  svg: string;
}

/** 单个转换器的结果 / Result of one converter. */
export interface ConversionResult {
  format: IconPackFormat;
  /** 面向用户的标准名称 / Human-readable standard name. */
  label: string;
  icons: GeneratedIcon[];
  /** 被识别但不适合作为图标的条目数 / Entries recognized but not usable as icons. */
  skipped: number;
  /** 用户或日志需要知道的降级信息 / Degradations worth surfacing. */
  warnings: string[];
  /** 输入自带的可选包名（Iconify prefix、字体名等）。 */
  suggestedName?: string;
}

/** 最终交给图标包管理器的结果 / Final result handed to the icon pack manager. */
export interface NormalizedIconPack {
  format: IconPackFormat;
  label: string;
  /** 归一化后的 ZIP 字节 / Normalized ZIP bytes. */
  archive: Uint8Array;
  iconCount: number;
  skipped: number;
  warnings: string[];
  suggestedName?: string;
}

/** 已识别但尚未转换的格式 / A format identified before conversion. */
export interface DetectedFormat {
  format: IconPackFormat;
  label: string;
}
