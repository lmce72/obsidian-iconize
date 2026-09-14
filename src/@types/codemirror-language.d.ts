/**
 * Obsidian 在运行时提供的 `@codemirror/language` 是它自己的 fork
 * （`lishid/cm-language`），该 fork 导出了 `tokenClassNodeProp`；而 `package.json`
 * 声明的 git 依赖无法安装，本项目改用 npm 上的同版本包，其中没有这个导出。
 *
 * 运行时没有任何问题——rollup 把 `@codemirror/language` 列为 external，实际加载的是
 * Obsidian 提供的那份。缺的只是构建期的类型，这里补上以对齐运行时。
 *
 * At runtime Obsidian supplies its own fork of `@codemirror/language`
 * (`lishid/cm-language`), which exports `tokenClassNodeProp`. The git dependency declared
 * in `package.json` cannot be installed, so this project resolves the same module from
 * npm instead, which lacks that export. Nothing is wrong at runtime — rollup keeps the
 * module external and Obsidian provides it. Only the build-time type is missing.
 */

import type { NodeProp } from '@lezer/common';

declare module '@codemirror/language' {
  /**
   * 语法节点上承载 token 类名的属性 / Node property carrying space-separated token classes.
   */
  export const tokenClassNodeProp: NodeProp<string>;
}

// 顶层 import 已使本文件成为模块，从而上面的 `declare module` 是「增强」而非「声明」——
// 后者会覆盖真实模块的导出。此处的 export 仅用于明确这一点。
export {};
