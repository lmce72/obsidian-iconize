# deprecated

此目录保存按需加载功能的**早期参考实现**，已被 `src/lib/` 下的 TypeScript 版本取代。

这些文件**不参与构建**（rollup 只从 `src/main.ts` 打包），仅作历史留存。

| 文件 | 被取代者 |
|---|---|
| `icon-index-store.js` | `src/lib/icon-index-store.ts` |
| `icon-indexing.js` | `src/lib/icon-indexing.ts` |
| `icon-resolver.js` | `src/lib/icon-resolver.ts` |
| `inline-icon-loader.js` | `src/lib/inline-icon-loader.ts` |

## 为什么被取代

这些实现存在几个会直接导致图标读取失败的缺陷，TS 版本参照
[glyphit](https://github.com/jmarasch/glyphit) 重写后修复：

1. **索引保存裸文件名** —— 归档内的条目实际是嵌套路径（如 `icons/home.svg`），
   按裸文件名去取会全部落空。TS 版本改为保存完整条目路径。
2. **`extraPath` 被拼接两次** —— 索引期与读取期各拼一次，产生双重前缀路径。
   TS 版本只在索引期用它过滤。
3. **固定版本路径不匹配** —— 预定义包固定了带版本号的路径
   （如 `fontawesome-free-7.2.0-web/svgs/solid/`），用户装的往往是别的版本，
   导致索引为 0。TS 版本加入宽松路径匹配与同名解压目录回退。
4. **无保留目录过滤** —— 会把 `.cache` / `.index` 当成图标包。
