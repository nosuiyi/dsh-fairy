# 媒体层已移交（DEPRECATED for that role）

本包的媒体路由已**合并进 `dsh-skin-hdd-fairy`**，因此不要再为了「给皮肤提供素材」而启用它。

本包不会被删除：后续计划改造成**通用语音提示包**（任意插件都能调用的提示音/播报服务），
接口形状、边界与分阶段计划见 [`DESIGN.md`](DESIGN.md)。
在那之前，它与皮肤同时启用只会让四条 `/hdd/*` 路由被皮肤抢走、并打出一条 warn 日志。

## 发生了什么

`dsh-skin-hdd-fairy` 原先通过 HTTP 依赖本包提供的四条路由：

| 路由 | 用途 |
|---|---|
| `/hdd/info` | 素材清单 |
| `/hdd/asset` | 视频/背景/音频流（支持 Range） |
| `/hdd/greeting` | 按本地小时选问候 |
| `/hdd/cue` | 回合提示音事件 |

但皮肤的 `package.json` 里**没有任何依赖声明**——这个依赖是隐式的，只在 profile patch
恰好补了一行 `dsh-hdd-voice` 时才成立。bundles 列表被皮肤管理器重写时，这一行还常被挤掉，
症状就是"未检测到素材包"、没有动画与声音。

现在这四条路由、`lib/asset-store.js` 的解析逻辑、以及提示音的状态机都已搬进皮肤包，
皮肤成为**自包含单包**。本包只作为历史保留：

- 源码留在这里方便对照与回溯；
- 不要再把它写进 profile 的 `bundles` 或 patch；
- 如果本机还留着它的 patch 行或依赖，删掉即可（素材目录 `~/.dsh/hdd-fairy/assets` 不受影响）。

单测也已迁到 `packages/dsh-skin-hdd-fairy/test/asset-store.test.js`：

```sh
node --test packages/dsh-skin-hdd-fairy/test/asset-store.test.js
```
