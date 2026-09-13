# Iconize Enhanced — 按需加载改造说明

在原版 Iconize (2.14.7) 基础上加入按需加载（lazy loading）层，并修复了此前一次
未生效的尝试。架构参考 [glyphit](https://github.com/jmarasch/glyphit)。

## 问题回顾

此前 `main.js` 被手工补丁，用 `require('./icon-index-store.js')` 等 4 个相对路径模块
挂上按需加载，并新增 `initIconPacksLazy` / `loadUsedIconsLazy`。

Obsidian 插件的运行时 `require` 是 Obsidian 内部的模块系统，**无法解析相对文件系统路径**
（模块内部的 `require('jszip')` 同样无法解析）。每个 `require` 都抛错、被 `try/catch`
吞掉并返回 `null`，于是代码静默回退到 legacy 全量加载 —— 按需加载从未生效。

**修复方式**：把增强改造为 TypeScript 源码，用 ES import 引入，由 rollup 连同 `jszip`
一起打包进 `main.js`，彻底消除运行时 `require`。

## 架构

### 数据模型：索引与图标分离

- **`IconEntry`** —— 只有元数据：图标存在、叫什么、字节在哪里。构建它不需要解压任何内容，
  因此上万个图标的包索引起来很廉价。
- **`Icon`** —— 已解析的图标，携带真正的 SVG 标记，只在需要时才产生。

图标包始终保持压缩，插件持有全部图标的索引，但只解压仓库真正用到的那些。

### 源抽象（`src/lib/icon-sources.ts`）

| 类 | 用途 |
|---|---|
| `ZipSource` | 从 `.zip` 读取，永不落盘解压 |
| `FolderSource` | 递归遍历 `.svg` 目录（用户自建包 / 旧版本解压出的图标） |

`ZipSource` 的关键点：**索引里保存的是归档内的完整条目路径**，`readEntry` 按该路径精确读取；
`extraPath` 只在索引阶段用于过滤，绝不在读取时再次拼接。

预定义包固定了带版本号的路径（如 `fontawesome-free-7.2.0-web/svgs/solid/`），
用户装的往往是别的版本。精确路径匹配不到时，退一步用去掉版本段后的路径
（`svgs/solid/`）匹配，图标包即可跨版本继续工作。

### 三层缓存（`src/lib/icon-resolver.ts`）

```
Layer 1 内存     该会话已解析，同步返回（渲染路径依赖这一层）
Layer 2 磁盘缓存 上次会话解析过，一次小文件读取
Layer 3 图标包   首次使用，读取该条目并写入缓存
```

### 生成状态位置（`src/lib/icon-layout.ts`）

```
.obsidian/plugins/obsidian-icon-folder/.iconize/
  index/feather-icons.json     图标包内容索引
  cache/LiHome.json            首次使用时提取的图标
```

**不放在 `iconPacksPath` 下**：legacy 的 `IconPackManager` 会把图标包目录下的每个文件夹
都当成图标包，放在那里既产生噪声，也会让 background check 误删缓存文件。

## 与原版行为的差异

### 按需加载

- `IconPackManager.loadAll()` 改为 no-op（原实现会把所有图标包全量解压进内存，约 2 秒）。
  索引在 `init()` 阶段建立，图标由 `IconResolver` 按需解析。
- `IconPack` 改为索引驱动：`getIcon()` / `getIcons()` 返回元数据（`svgElement` 为空）。
  需要标记的调用方走按需解析。
- `icon.getIconByName()` 在只拿到元数据时返回 `null`，让调用方回退到按需路径，
  而不是注入空内容。
- `dom.setIconForNode()` 成为同步渲染路径的统一入口，内存未命中时异步按需解析后再填充，
  文件浏览器 / 标签页 / 标题 / 图标拾取器因此共用同一套按需逻辑。

### 图标配置保护（取代原先的硬编码文件名防护）

原实现在 `removeFolderIcon()` 里硬编码保护单个文件名（该文件是启动时的活动文件）。
真正的缺陷在 frontmatter 同步逻辑：

1. 布局就绪时把**活动文件**记入 `frontmatterCache`，却不检查它是否真的用过 `icon` 属性；
2. frontmatter 解析时，只要路径在 `frontmatterCache` 中且当前没有 `icon` 属性，
   就判定为「图标已被移除」并删除 `data` 中该文件的图标配置。

于是任何作为活动文件打开、且恰好配置过图标、又没有 `icon` 属性的文件，
都会在 frontmatter 解析时被静默删掉图标。

修复：`frontmatterCache` 由 `Set<string>` 改为 `Map<string, string>`（记录路径 → 实际见过的
frontmatter 图标名），只在文件确实通过 frontmatter 提供过图标时才记录。
这样既堵住误删，又保留预期行为——用户清空 frontmatter 的 `icon` 属性时图标仍会被移除。

### 外部 SVG 清理

图标包保持压缩，不再解压出 `.obsidian/icons/<pack>/<name>.svg` 外部文件：

- `IconPackManager.extractIcon()` 改为只触发一次解析（解析即写入磁盘缓存），不再创建外部文件。
- `FileManager.createFile()` 增加守卫：仅允许写入 `isCustomPack()` 为真的图标包目录。
- `checkMissingIcons()` 原本以「外部 SVG 文件是否存在」判断图标缺失——该检查在此模型下恒为假，
  会让 background check 每次启动都误报「found missing icons」。改为以**能否解析**判断缺失。

## 标注约定

- 新增/移植代码：`// ===== PATCHED: <说明> =====` … `// ===== END PATCH =====`
- 被取代、日后可清除的旧代码：`// [LEGACY] <说明>`
  清除时执行 `grep -rn '\[LEGACY\]' src/`

## 实测结果

| 指标 | 结果 |
|---|---|
| 索引图标总数 | 9845 |
| 索引耗时 | ~115 ms |
| 已用图标预取 | 76 / 76 成功，0 失败 |
| 文件浏览器图标 | 21 / 21 带 SVG |
| 内联图标空节点 | 0 |
| 各包索引数 | 与 legacy 完全一致 |

> `deprecated/` 下的 `icon-*.js` / `inline-icon-loader.js` 是早先的参考实现，已被
> `src/lib/` 下的 TypeScript 版本取代，仅作历史留存，不参与构建。
