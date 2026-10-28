# 给 agent 的边界说明：`dsh-skin-hdd-fairy`

> 你（agent）被指派维护**这个包**时，这份文件就是你的工作边界。读完再动手。

## 你能改的

只有 `packages/dsh-skin-hdd-fairy/` 目录内的文件：

```
lib/client.js        客户端：开屏时间轴、徽记、提示音播放、调色板、设置项
lib/index.js         宿主：九个 /hdd/* 路由（媒体读取 + 素材导入/管理）
lib/asset-store.js   素材约定（**活的那一份**，见下）
skin.json + cordis.patch.yml   皮肤管理器契约
test/                node --test
tools/smoke.mjs      真跑一遍 apply / 释放
tools/scan-skin-classes.mjs    重新解析壳子的哈希类名
```

## 你不能改的

| 不要动 | 原因 |
|---|---|
| `packages/dsh-hdd-voice/` | 已把媒体层移交本包，正在等待改造成**通用语音提示包**（见其 `DESIGN.md`）。要改那边请另开一个任务。 |
| `packages/dsh-hdd-visual/` | 早期插件版，功能被本包取代。除删除外不要"顺手修"。 |
| `%USERPROFILE%\.dsh\profiles\**` | 用户运行时配置。需要改时**先列出来问用户**，不要自己动 `dsh.profile.bundles`。 |
| `docs/findings-*.md` | 事故记录，是历史证据。要补充就新开一节，不要改写既有结论。 |

## 两条"看起来可以、其实不行"的事

1. **不要从 `dsh-hdd-voice` import 任何东西**，也不要让它 import 你。两个包各自带一份 `asset-store.js`：
   - 本包 `lib/asset-store.js` 是**活的**，改它就改这里，测试也测这一份；
   - voice 那份已冻结，**不要为了"保持一致"去同步**——它的用途将来会变。
2. **不要直接改 `dsh.profile.bundles`**。皮肤管理器会重写它；要"让某个包常驻"，用 profile patch 的 `insert` 行（本包现在不需要，媒体层已内置）。

## 本包对外的契约（改之前先确认不破坏）

| 契约 | 约束 |
|---|---|
| 九个路由 `/hdd/{report,import,list,adopt,reveal,info,asset,greeting,cue}` | 全部用 `serveRoute()` 注册（它吞掉重复注册的异常）。新增路由沿用同一包名空间，不要用 `/voice-cue/*`。 |
| `/hdd/asset` | 必须支持 **Range**（视频要 seek）。 |
| 素材布局 | 固定文件 `boot.mp4` / `boot.png` / `boot-field.png` / `cue/<kind>.<ext>`；问候两种布局并存（`greeting/<bucket>/*` 与 `greeting/<bucket>-*.ext`），合并、排序、随机、跨档兜底。 |
| 皮肤管理器契约 | `skin.json#bodyAttr` 必须匹配 `^data-[a-z0-9_.:-]+$`；`wiring.id` 等于 bundle 行 id；`dshCompatibility` 形如 `0.2.1rc3`；**不要手写** `dsh-skin managed` 段。 |
| `apply(null)` | 必须把这套皮肤拥有的一切释放干净：CSS、`<body>` 属性、定时器、开屏节点、主题偏好（仅当仍是自己设的值）。 |

## 三条硬约束（违反就整窗白 / 整页点不动）

1. **`<video>` 元素绝不进入 DOM**（哪怕 2×2、`opacity: 0.01`）——本机上它会变成一个窗口大小的白色平面，音频照放、画面全白；
2. **开屏层不做 `opacity` 淡入淡出**，内部也不要用 `filter`——含视频帧 canvas 的全屏层会整层失效；
3. **样式选择器必须限定元素类型**（`div[data-hdd-splash]`，不是 `[data-hdd-splash]`）——裸属性选择器会连 `<html>` 一起匹配，把应用压成窄列且吞掉所有点击。

完整证据在 `docs/findings-2026-10-28-white-splash.md` 与 `...-narrow-window.md`，改可视层之前**必须**读。

## 面板纹理与哈希类名

壳子的列用 CSS Modules 类名（`an3WzG_root`、`mP3x-q_frame`），前缀是构建哈希、后缀稳定。本包在 `apply` 时解析前缀（DOM → styleSheets → `<style>` → 常量兜底），解析结果写日志 `skin-classes`。

DSH 升级后若纹理消失：

```sh
node tools/scan-skin-classes.mjs     # 打印新前缀 + 可粘贴的 FALLBACK_PREFIXES
node --check lib/client.js
```

## 改完必须跑

```sh
node --check lib/client.js
node --check lib/index.js
node --test test/asset-store.test.js     # 9 项
node tools/smoke.mjs                     # apply + 释放路径
```

四项全绿才算改完。跑不过就先回退，不要"顺手再改点别的"。

## 需要用户点头才能做的事

- 改 `%USERPROFILE%\.dsh\profiles\**`（尤其 `package.json`、`cordis.patch.yml`）；
- 跑 `dsh plugin add/remove`（会重写 bundles 并可能丢掉其他 bundle）；
- 删除任何素材文件（用户自备的音频/视频）。
