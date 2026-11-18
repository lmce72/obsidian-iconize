# 本地源码与部署

`~/obsidian-iconize-enhanced` 是唯一维护源码。所有改动放在 `src/`，Rollup 从
`src/main.ts` 打包为单个 `main.js`。部署目标是
`~/AstroScope/.obsidian/plugins/obsidian-icon-folder`，插件 ID 保持不变。

2026-10-15 对账时，两处 `main.js` 的 SHA-256 都是
`76504628906499b95bc7b25560cf39da22c0e03e6cc04d303e1611e04c70c072`。
部署目录的四个独立模块与 `deprecated/` 中对应文件经格式统一后完全一致。
它们已由 `src/lib/` 的 TypeScript 实现取代，当前打包文件没有相对模块依赖。
部署目录并不存在一份需要额外合入的新版业务逻辑。

```sh
pnpm exec vitest run
pnpm run typecheck
pnpm run build
```

构建只输出项目根目录的 `main.js` 及 `dist/` 中的三个运行文件，不自动改动仓库。
无需 `env.js` 即可构建。部署前把 `env.example.js` 复制为 `env.js`，设置
`obsidianExportPath`，然后运行：

```sh
pnpm run deploy:obsidian
# 或明确指定目标：
pnpm run deploy:obsidian /path/to/vault/.obsidian/plugins/obsidian-icon-folder
```

也可通过 `ICONIZE_PLUGIN_DIR` 指定目标；命令行参数优先于环境变量和 `env.js`。
脚本会重新构建，校验插件 ID、JavaScript 语法及无零散模块依赖，备份原运行文件，
暂存后替换，再核对三个部署文件的 SHA-256。

旧模块、旧 JSZip 补丁脚本、历史报告和旧 bundle 备份仅按明确名单移至项目的
`.local-backups/<部署标识>/legacy/`，不使用通配清理。`data.json`、`.iconize/`、
图标包、`.git/` 和未知文件都保留。部署记录写在目标的 `.iconize-deployment.json`，
含源码目录、部署标识、校验值及回退备份路径。

重新加载 **Iconize 插件** 后生效，不必重启整个 Obsidian。旧版脚本和历史报告只作
归档参考，不再直接修改部署目录的 `main.js`。

配置保存、删除保护与历史恢复见 [图标配置与恢复](../good-to-know/sync-config.md)。

## 本次验证

2026-10-15：205 项测试通过，13 项沿用原项目跳过状态；类型检查、ESLint 和生产
构建通过。部署后 67 个已有文件夹图标均找到对应 SVG。手动保存命令已注册并执行，
无待保存改动时不重写配置。主配置、其 `.bak` 和默认 `data.json` 的内容及修改时间
保持不变。23 个旧文件已按名单归档，部署的三个运行文件与构建产物逐一校验一致。

当前 Iconize 由 Better Plugins Manager 加载，不在 Obsidian 标准启用列表中。标准
`plugin:reload` 因此拒绝重载；本次仅调用现有插件管理对象的 `unloadPlugin` /
`loadPlugin` 重载 Iconize，保持原启用列表和管理器设置。

合并策略已更新为 item 并集与逐条最新版本。新增 10 项纯合并测试，覆盖独立 item、
同 item 时间冲突、原子图标与规则、删除与重新设置、时钟回拨和合并顺序一致性。
还使用实际加载的 bundle、隔离的内存适配器验证了取并集、较新 item 胜出、主动删除
及旧配置无法复活已删除项；没有向真实配置写入测试记录。重载后的 67 个文件夹
图标均正常，手动无变化保存未改动主配置或备份。

## 保存失败的后续修正

2026-10-15 15:09（Asia/Shanghai）复现保存失败：`EEXIST`，`syscall: copyfile`，
目标是已存在的 `Components/Configs/iconize.json.bak`。`DataAdapter.copy` 不允许
覆盖，而此前测试替身错误允许覆盖。检查运行时实现也确认 `rename` 不允许替换已有
目标，因此旧的暂存后改名流程存在第二个同类问题。

修正为写入备份快照，再用 `DataAdapter.process` 校验旧内容并提交；没有删除主配置
来腾出目标路径。测试替身现严格拒绝 copy / rename 覆盖，并新增连续保存、提交前
竞争和新配置创建的回归测试。失败恢复文件新增 `failure`，记录阶段、时间和原异常。

已保全旧主配置、备份、暂存、恢复文件和重载前内存快照。重载时携带当前会话的待存
配置，随后真实保存成功：112 条图标记录全部写入，包含此前未落盘的 3 条新增记录，
没有缺少或改变任何待存图标。另用真实 Obsidian 适配器在独立临时目录连续保存两次，
确认已有备份正常更新，备份等于上个版本；验证后删除了本次生成的测试目录。
