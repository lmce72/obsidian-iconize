# 2.15.1：配置缺失、损坏与恢复路径

日期：2026-11-21（Asia/Shanghai）。本轮修复配置诊断中的死胡同与卡死问题。

## 现象

- 新装或搬家后的插件没有 `data.json` 时，诊断页把“配置文件尚未创建”当成异常，只提供“重试”；用户既不能留空恢复默认，也不会自动创建配置。
- 从别的库复制插件后，`settings.configFilePath` 指向旧路径；目标不存在时插件永久停止保存，重试也无法清除指针。
- 一条无效图标记录或一个无效设置会让整份 JSON 被拒绝，用户之前设置的其它图标和规则一起失效，且不允许保存修复。
- 点击“重试”后渲染进程持续 100% CPU，弹窗和整个 Obsidian 无响应。
- `.iconize` 目录包含本机索引、缓存和恢复历史，缺少可直接复制的同步排除规则。

## 新的配置策略

| 状态 | 判定 | 行为 |
|---|---|---|
| `missing` | 配置文件不存在 | 使用默认设置；保存时自动创建；诊断页提供“保存配置” |
| `recovered` | 内容损坏（JSON 语法或字段无效） | 先备份原文为 `data.json.corrupt-<时间>`；逐条保留可用图标记录与设置，无效项重置；保存写入修复后的新文件 |
| `failed` | 暂时读不到（I/O、权限、同步占用） | 停止写回，原文件不动；重试只重新读取 |
| 自定义路径不存在 | `configFilePath` 指向的目标缺失 | 保留当前设置并在保存时创建目标；提供“改用默认配置路径”，旧文件不删除 |

`parseConfig` 仍用于严格校验历史备份；运行期读取使用 `parseConfigLenient`：过滤无效记录、逐项重置设置、把原因写入状态文本。JSON 配置只是数据，不作为可执行内容处理。

## 恢复动作与重载

- 诊断页增加“立即创建/保存配置”和“改用默认配置路径”。
- 所有恢复动作**先关闭弹窗**，再在后台执行 I/O，用 Notice 报告结果；不再在弹窗内异步更新 DOM。此前“重试”在弹窗内完成异步操作后继续更新状态，渲染进程出现持续 100% CPU；关闭弹窗后执行可以避免这类界面生命周期问题。
- 缺失/损坏/暂时不可读的重试不再进入历史快照和维护队列，只重新读取；`withConfigurationMaintenance` 等待进行中保存时也加了 5 秒上限。
- 配置路径和部分设置无法在插件内部热替换。重置路径或恢复备份后会打开“需要重新加载 Obsidian”弹窗：提供 Obsidian 自己的 `app:reload` 按钮（重新加载界面与插件）和“稍后”选项，并提示先保存未保存的编辑。

## 同步排除

诊断页新增可复制的同步排除代码块：

```text
# Syncthing (.stignore)
(?d).obsidian/plugins/obsidian-icon-folder/.iconize

# Git (.gitignore)
.obsidian/plugins/obsidian-icon-folder/.iconize/

# Obsidian Sync（排除的文件夹 / Excluded folders）
.obsidian/plugins/obsidian-icon-folder/.iconize

# Remotely Save（排除模式，每行一条 / exclude patterns）
.obsidian/plugins/obsidian-icon-folder/.iconize/**
```

`data.json` 仍应同步；只排除 `.iconize`，不要排除整个插件目录。

## 验证与未完成项

- 单元测试覆盖：无效设置恢复、损坏 JSON 备份与修复、缺失配置创建、缺失配置重试不写历史、路径重置、同步规则文案。
- `vitest` 467 项通过、13 项沿用原项目跳过；`typecheck`、ESLint、Prettier、生产构建通过。
- 运行期验证在隔离实例中确认了新状态文案、备份文件、缺失配置的重试仍会让该测试实例的渲染进程进入 100% CPU，因此改为“关闭弹窗后执行”的结构；该结构尚未在真实窗口中完成最终复测。请在一篇测试笔记/测试库上验证：缺失配置点重试应无卡死，重置后出现重载弹窗，`.iconize` 规则可复制。
- Windows、移动端真机与社区 source review 尚未执行。
