# 2.14.12：文档首次加载的图标回填

日期：2026-11-19（Asia/Shanghai）。用户报告 Windows 文档内出现白色方块，刷新后图标恢复。

## 原因与修改

`InlineIconLoader.flushPendingElements` 曾在 SVG 解析成功后检查 `element.isConnected`，并无条件移除等待记录。Markdown 章节或编辑器 widget 可以在挂载之前执行渲染，尚未连接页面的节点因此丢失了解析结果；之后挂载不会重新发起读取。刷新时缓存命中走同步渲染路径，所以能显示。

2.14.12 让仍登记等待的节点在挂载前即可接收 SVG，与同步缓存路径一致。显式 `releaseElement`、reset 和 dispose 继续取消旧任务。没有新增类、观察器、轮询或整篇笔记重绘，缓存预算及 I/O 并发保持原机制。

## 验证

仅使用独立空 Vault、独立 profile 和 19371 端口，chrome-devtools-mcp 在每次调用前核对 Vault 绝对路径。

- 原 2.14.11 隔离运行期：冷图标解析完成后，挂载前与挂载后均没有 SVG；刷新后的缓存路径显示正常。复现了相符的加载竞态，未在 Windows 真机复现白色像素表现。
- 新增两个回归：章节延后挂载仍显示图标；读取期间已显式释放的离线节点不再填充。定向 12 项通过；收敛测试范围前完整自动化检查已完成，360 项通过、13 项沿用原项目跳过。TypeScript、变更源码及测试 ESLint（零警告）和生产构建通过；ESLint 进程有已有 ignore 文件弃用提示。
- 最终构建初始化成功，测试 ZIP 的 4 个图标已建立索引。按用户补充要求分别使用不同的、此前未命中内存缓存的图标核验：`TeCircle` 首次赋给文件，标题最终含对应 circle SVG 和正确标记；`TeStar` 在阅读视图首次作为文档标签显示；`TeSquare` 在实时预览首次显示；`TeTriangle` 首次转换为 Base64 图片，图片成功解码为 16×16。
- 各入口无需刷新；最终 loader 状态为 pending=0、failed=0、inFlight=false。没有继续百万规模测试或其它界面场景测试。Windows 真机仍待用户更新后复核。

## 版本与部署

版本和发布 tag 为 `2.14.12`，最低 Obsidian 版本保持 `1.7.2`。发布附件为独立的 `main.js`、`manifest.json`、`styles.css`。部署通过 `scripts/deploy.mjs` 备份原运行文件并校验三个产物，保留配置、图标包和缓存；精确备份位置记录在已安装插件的 `.iconize-deployment.json`。个人库不用于功能测试或自动重载。
