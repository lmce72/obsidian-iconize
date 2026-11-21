# 2.15.0：多标准图标包导入与单次嵌入格式

日期：2026-11-21（Asia/Shanghai）。本轮在插件源码仓库完成，运行期仍是「归档保持压缩、索引只读名称」的按需加载模型。

## 目标

- 图标包打包标准差异很大（Iconize ZIP、通用 SVG 仓库、Iconify JSON、SVG sprite、npm tarball、字体 + CSS），导入前无法要求用户先手工整理。
- 导入器先用象征性文件识别标准，再只提取有用的图标部分；文档截图、测试素材、构建产物与重复 sprite 容器丢弃。
- 图标名保持原始名称，跨包区分完全依赖 Iconize 的包前缀。
- 文档嵌入格式支持单次选择：`<svg>` 标签、Base64 自包含图片、文件引用。Base64 为运行时字符编码，README 已按审查要求披露用途。

## 识别规则

| 输入 | 标志性内容 | 结果格式 |
|---|---|---|
| ZIP / tar.gz 内的 `.svg` | 无字体 + 图标数量 ≥ 3，或只有 SVG | SVG 归档 / Iconize ZIP |
| ZIP / tar.gz 内的 `icons/`、`svg/`、`svgs/`、`src/` 等目录 | 优先目录计数最高者 | 只保留该目录下的 SVG |
| ZIP / tar.gz 内的 `.js/.mjs/.cjs` | `createElement("path", { d: … })` | JS 图标模块 |
| 单个 `.json` | `prefix` + `icons` 对象 | Iconify JSON |
| 单个 `.svg` | `<symbol>` | SVG Sprite |
| 单个 `.svg` | 无 symbol | 单图标 |
| `.tar.gz` / `.tgz` | `package/package.json` 或 `package/` 前缀 | 按内容继续识别 |
| 字体 + `.css` | `.ttf/.otf/.woff`（`.woff2` 拒绝） | 字体图标 |

通用 SVG 仓库的根目录选择顺序：

1. 标志性目录（`icons` → `icon` → `svgs` → `svg` → `glyphs` → `src` → `assets` → `dist`），按图标数量取最多者。
2. 没有标志性目录时，取覆盖至少 95% 图标的最深目录；这样单一包装目录会被剥掉，而 `src/24/outline` 这类风格目录不会盖过它的父目录。
3. `docs`、`.github`、`test`、`fixtures`、`node_modules` 等噪声目录在计数前排除。
4. `sprites/solid.svg` 一类合并容器在存在独立 SVG 时丢弃；归档内发现真实 sprite 时按 `<symbol>` 拆分。

## 归一化

每个图标都经过同一个清理入口：

- `DOMParser` 解析，移除 `script`、`foreignObject`、`style`、`image`、外部 `use`、`on*` 事件属性、外部 `href` 与非 `#` 的 `url(…)`。
- 保留根节点的 `fill` / `stroke` / `stroke-width`（轮廓图标依赖它们）。
- 名称经 `sanitizeIconName`：点、斜杠、标点转为连字符；Unicode 字母数字保留；不以 ASCII 字母或数字开头的名称加 `Icon-` 前缀，保证索引的前缀切分成立。
- 归档内保留相对目录，重名文件的消解交给现有索引；归一化器只处理最终路径的完全重复（`-2`、`-3`）。
- 最终 ZIP 固定键顺序，并写入根级 `iconize-pack.json`（格式、数量、跳过数、警告）。同一输入生成字节一致的归档。

`ZipSource` 看到 `iconize-pack.json` 后不再套用按包名硬编码的 `extraPath`。否则一个名为 `font-awesome-solid` 的自定义导入包会在下次启动时被预定义路径过滤成空包。

## 格式细节

- **Iconify JSON**：支持 `width/height/left/top`、`aliases` 的 `parent`、`hFlip`、`vFlip`、`rotate`，别名链最多 8 层；无法解析父图标的名称计入跳过。
- **SVG Sprite**：拆出每个 `<symbol>`，保留 `id`、`viewBox` 和 symbol 上的表现属性。
- **JS 图标模块**：只读源码文本，不执行；按「目录 + 名称」去重，因此 `16/solid`、`20/solid`、`24/solid`、`24/outline` 四套风格都会保留；ESM 与非 ESM 双构建按路径去重。
- **字体**：opentype.js 2.0 解析 TTF/OTF/WOFF。优先使用 CSS 的类名 → 码位映射（`content:"\f007"` 与 Font Awesome 7 的 `--fa:"\f007"` 都支持），缺少 CSS 时退回字形名。WOFF2 会在输入前按魔数拒绝，并提示改用 TTF/OTF/WOFF 或 SVG 包。多个字体文件按 TTF → OTF → WOFF 顺序尝试，单个字体解析失败不会连累同包其它字体。

## 真实图标包实测

测试素材位于 `/home/corevortex/iconize-pack-tests/packs`（不入库）。每个包都执行「归一化 → 用真实索引算法建立索引」，检查图标数、重复 id、非法首字符与归档大小。

| 包 | 识别 | 图标 | 索引 | 跳过 | ZIP |
|---|---|---|---|---|---|
| Lucide 仓库 | SVG 归档 | 2098 | 2098 | 549（docs/lab） | 0.65 MiB |
| Bootstrap Icons 仓库 | SVG 归档 | 2078 | 2078 | 2 | 0.86 MiB |
| Remix Icon 仓库 | SVG 归档 | 3229 | 3229 | 8 | 1.41 MiB |
| Heroicons 仓库 | SVG 归档（`src/`） | 1288 | 1288 | 1292（`optimized/` 重复） | 0.71 MiB |
| Tabler 仓库 | SVG 归档 | 6545 | 6545 | 234 | 2.27 MiB |
| Iconify MDI | Iconify JSON | 14001 | 14001 | 0 | 4.70 MiB |
| Iconify Tabler | Iconify JSON | 6788 | 6788 | 0 | 2.13 MiB |
| Iconify Phosphor | Iconify JSON | 9198 | 9198 | 0 | 3.48 MiB |
| Disarto sprite | SVG Sprite | 752 | 752 | 0 | 0.29 MiB |
| Font Awesome sprite | SVG Sprite | 1422 | 1422 | 0 | 0.60 MiB |
| MDI 单文件 | 单图标 | 1 | 1 | 0 | < 0.01 MiB |
| lucide-static npm | SVG 归档（`package/icons`） | 2410 | 2410 | 3 | 0.80 MiB |
| Tabler npm | SVG 归档（`package/icons`） | 6545 | 6545 | 5491（`categories/` 重复） | 2.62 MiB |
| Heroicons React npm | JS 图标模块 | 1288 | 1288 | 1288（ESM 副本） | 0.48 MiB |
| Font Awesome TTF | 字体（字形名） | 1401 | 1401 | 1 | 0.67 MiB |
| Font Awesome TTF + all.css | 字体（CSS 映射） | 1932 | 1932 | 633（字体不含 brands/regular） | 0.92 MiB |
| Material Symbols TTF | 字体（字形名） | 6649 | 6649 | 3 | 2.99 MiB |
| Bootstrap Icons WOFF + CSS | 字体（CSS 映射） | 2078 | 2078 | 0 | 1.08 MiB |

字体图标使用「em 盒 ∪ 全部选中字形包围盒」的公共 viewBox。Font Awesome 有 38% 的 CSS 匹配图标超出 512 单位的 em 宽度（最宽 640），只用 em 盒会裁边；Bootstrap 的 descender 为 0，部分字形低于基线。公共视野同时保留字体相对尺寸与基线。

归一化耗时（隔离 Linux 机器）：Tabler 仓库约 1.6–1.8 s，Iconify MDI 约 1.3–1.5 s，其余大多数在 0.2–1.2 s。最大的单包归档为 MDI 的 4.70 MiB（含 6363 个别名）。

## 对抗性审查后的修正

四个独立审查者分别检查字体、JS 模块、sprite 与核心归档/Iconify，发现的缺陷已修正：

- 字体 viewBox 裁边（上述公共视野）；单个损坏字形只跳过自身；CSS 文件有 16 MiB 上限并在文件间让出；`.woff2` 扩展名与魔数不一致时仍给出 WOFF2 提示；多字体按 TTF → OTF → WOFF 逐个尝试。
- JS 模块支持 `rect/circle/ellipse/line/polyline/polygon`（找回 Heroicons 的 `StopIcon`）、根节点 `strokeLinecap/strokeLinejoin`、`createElement as h` 别名；对象提取限制在 16 KiB 窗口与 256 KiB 对象内，避免平方级扫描；多风格目录按「目录 + 名称」保留（1288 而非 323）。
- sprite 拆分复制被引用的 `<defs>`（渐变、遮罩、共享路径）并继承根节点绘制属性；孤立 `<symbol>` 不再触发 `ownerSVGElement` 空引用；无效 viewBox 回退到 sprite 根节点；重复 symbol id 交给归一化器编号而不是静默丢弃。
- 归档不再按文件名含 `symbol` 猜 sprite：`usb-symbol.svg`、`math-symbols.svg` 等正常图标恢复；sprite 只在内容含 SVG symbol 时拆分，与独立图标重名时跳过。
- Iconify 支持单图标 `width/height/left/top`；`rotate` 按四分之一圈（1 = 90°）解释，旋转先于镜像，并使用 `left/top` 计算镜像平移。
- 索引数字后缀会持续递增到全局唯一，修复 `device-game-pad` / `device-gamepad` / `device-gamepad-2` 的 id 重复。
- opentype.js 的 `browser` 字段指向含 `require('fs')` 的 CJS 构建；Obsidian 渲染进程没有 Node 集成，顶层 require 会使整个插件加载失败。rollup 别名改用无 Node 依赖的 ESM 构建。

## 顺带修复的索引缺陷

真实 Iconify 包暴露了既有的命名冲突：`device-game-pad` 与 `device-gamepad` 归一化后同为 `DeviceGamepad`，第二项得到数字后缀 `2`，正好撞上真实存在的 `device-gamepad-2`。`resolveEntryIds` 与 `resolveEntryIdsCompact` 现在会持续递增后缀直到全局唯一；两种实现保持一致，并新增了回归测试。

## 嵌入格式

设置页的默认格式仍为 Base64。转换器窗口新增单次格式下拉（SVG 标签 / Base64 图片 / SVG 文件引用），不影响全局设置。README 已披露 Base64 的运行时用途；它只用于把图标写进 Markdown，不承载代码或凭据。

## 验证

- `pnpm exec vitest run`：461 项通过、13 项沿用原项目跳过；另跑了 18 项真实图标包集成检查（临时文件，不入库，素材在 `/home/corevortex/iconize-pack-tests/packs`）。
- `pnpm run typecheck`、变更源码 ESLint（零警告）、Prettier、`pnpm run build` 通过。
- 生产构建因 opentype.js 从约 1.37 MiB 增至约 2.8 MiB（含内联 sourcemap）。字体是 P3 优先级；若认为包体不可接受，可移除 opentype.js 并放弃字体导入，其余格式不受影响。
- 运行期隔离验证（Obsidian 1.15.0，Linux，独立空 Vault `/tmp/iconize-import-runtime/vault`，CDP 端口 19371，连接前核对 Vault 绝对路径）：
  - `lucide.zip` → 2098 图标（337 ms）；Iconify Phosphor JSON → 9198（607 ms）；Disarto sprite → 752（85 ms）；Font Awesome TTF → 1401（192 ms）；TTF + CSS → 1932（206 ms）。全部生成 ZIP、登记解析器并成功解析样本 SVG。
  - 文档转换器三种格式实测：`<svg>` 标签、`data:image/svg+xml;base64,...` 图片、`![LuBirdhouse](<Iconize SVG/LuBirdhouse.svg>)` 文件引用。
  - 禁用并重新启用插件后，6 个图标包全部重新发现，样本图标仍可解析。
  - Obsidian 1.15 把「启用社区插件」状态保存在 `localStorage['enable-plugin-<appId>']`；全新的隔离 profile 只写 `community-plugins.json` 仍会被视为受限模式，测试时需调用 `app.plugins.setEnable(true)`。这是测试环境行为，不影响插件本身。
- Windows、移动端真机与社区 source review 尚未执行。

## 已知限制

- WOFF2 不支持；WOFF2 字体请改用 TTF/OTF/WOFF 版本或 SVG 包。
- OTF/CFF 字体由 opentype.js 解析；若库解析失败会给出清晰错误，而不是静默产出空包。
- 从字体渲染的图标使用字体级公共 viewBox，个别字体仍可能需要按设计微调。
- 通用仓库的根目录启发式无法覆盖所有自定义布局；导入通知会显示识别的标准与图标数量，便于用户判断是否选错目录。
