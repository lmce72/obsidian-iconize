# 回滚指引 / Rollback guide

本仓库在 `main` 上叠加了若干提交。下面列出可用的回滚点与操作方式。

## 回滚点 / Rollback points

| 名称 | 指向 | 含义 |
|---|---|---|
| `pre-enhancement` (tag) | `09fb177` | 上游原版，**改造前**的干净基线 |
| `stable-lazy-loading` (branch) | `98fbe9b` | 早期按需加载可用状态（历史留存） |
| **`stable-v2`** (tag) | `85ef4d8` | **当前推荐**：按需加载完整可用、legacy 已清除、测试全绿 |
| `stable-lazy-loading-v2` (branch) | `85ef4d8` | 同上，分支形式，便于继续在其上工作 |

全部已推送到 `origin`（你的 fork）。

```
85ef4d8  fix(links): 链接无法解析时不再误报 WARN   ← stable-v2 / stable-lazy-loading-v2
33b737b  test: 修复测试套件（158 通过 / 0 失败）
a4531cf  refactor: 移除 legacy 加载路径
d23c80f  fix(cache): 磁盘缓存以条目 id 为键
476f69f  fix(cache): 释放归档、移除时作废缓存
3677900  fix(icon-packs): 第三方图标包导入后立即可用
28d29c8  docs: 回滚指引与回滚点
98fbe9b  fix(frontmatter): 不再误删已配置图标     ← stable-lazy-loading
eb212d0  fix(config): 目标缺失时保留当前路径
82b22f8  feat(lazy-loading): 索引驱动的按需加载
09fb177  上游基线                                ← pre-enhancement
```

## `stable-v2` 的验证记录 / Verification of `stable-v2`

验证日期 2026-09-14，方式为「构建 + lint + 单元测试」与「Obsidian CDP 远程调试」双重校验。

**静态**

| 检查 | 结果 |
|---|---|
| 构建 TS 报错 | 0 |
| ESLint | 通过 |
| 单元测试 | 158 通过 / 0 失败 / 13 skipped |

**运行时**（插件重载后实测）

| 检查 | 结果 |
|---|---|
| 配置路径 | `Components/Configs/iconize.json`（127 条） |
| 图标包索引 | 287 / 484 / 1390 / 284 / 1447 / 2860 / 3093 |
| 已用图标预取 | 76 / 76，0 未找到 |
| 文件浏览器图标 | 22 / 22 带 SVG，0 空节点 |
| 内联图标 | 0 空节点 |
| 链接图标 | 渲染正常，属性与颜色齐全 |
| 标题图标颜色 | 生效（`#82b1ff`） |
| 归档内存驻留 | 0（索引后已释放） |
| 报错 / 告警 | 0 / 0 |

> 回滚到 `stable-v2` 后需重新构建并安装：`pnpm build && cp main.js "<vault>/.obsidian/plugins/obsidian-icon-folder/main.js"`
> 插件目录中对应的已验证产物备份为 `main.js.backup-stable-v2`。

## 仓库回滚 / Repository

```bash
cd ~/obsidian-iconize-enhanced

# 1) 只看不动：确认基线内容
git diff pre-enhancement main --stat

# 2) 丢弃全部改造，回到上游原版（会改写历史，不可用于已推送的 main）
git reset --hard pre-enhancement

# 3) 保留历史、生成一个反向提交（更安全，适合已推送的分支）
git revert --no-commit pre-enhancement..main && git commit

# 4) 只回到「按需加载可用」的已验证状态
git reset --hard stable-lazy-loading
```

回滚后需要重新构建并安装：

```bash
pnpm build
cp main.js "<vault>/.obsidian/plugins/obsidian-icon-folder/main.js"
```

## 插件目录备份 / Plugin directory backups

位于 `<vault>/.obsidian/plugins/obsidian-icon-folder/`：

| 文件 | 内容 |
|---|---|
| `main.js.backup-pre-port` | 改造前的补丁版插件（按需加载未生效的那一版） |
| `main.js.backup-lazy-loading-v1` | 按需加载完成、已验证可用的版本 |
| `main.js.backup-before-inline` | 更早的历史版本 |
| `data.json.backup-configpointer` | 修复配置指针前的 data.json |

恢复某次构建：

```bash
cd "<vault>/.obsidian/plugins/obsidian-icon-folder"
cp main.js.backup-pre-port main.js     # 或 main.js.backup-lazy-loading-v1
```

## 生成状态 / Generated state

按需加载的生成状态位于 `<vault>/.obsidian/plugins/obsidian-icon-folder/.iconize/`，
包含 `index/`（索引）与 `cache/`（已解析图标）。二者都可安全删除，插件会在下次加载时重建：

```bash
rm -rf "<vault>/.obsidian/plugins/obsidian-icon-folder/.iconize"
```

## 配置文件 / Config file

本仓库的 `configFilePath` 默认值是标准路径。若 vault 使用了自定义配置文件位置，
该指向存放在 `<vault>/.obsidian/plugins/obsidian-icon-folder/data.json` 的
`settings.configFilePath` 中——它必须显式存在，插件不会凭空推断。
