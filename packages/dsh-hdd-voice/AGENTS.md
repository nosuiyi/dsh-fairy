# 给 agent 的边界说明：`dsh-hdd-voice`

> 你（agent）被指派维护**这个包**时，这份文件就是你的工作边界。读完再动手。
> 先说结论：**这个包现在没有运行时职责。** 它的媒体层已经移交给 `dsh-skin-hdd-fairy`。

## 现状

| 部分 | 状态 |
|---|---|
| 四条媒体路由（`/hdd/info`、`/hdd/asset`、`/hdd/greeting`、`/hdd/cue`） | **已移交皮肤包**，皮肤自己注册 |
| `lib/asset-store.js` | **冻结**：与皮肤那份曾是逐字节相同的副本，现在皮肤那份才是活的 |
| `index.js`（cue 事件 → 播放） | 仍可运行，但方向是"改造成通用语音提示包" |
| `test/asset-store.test.js` | 保留，用来证明冻结的这份没被改坏 |

## 你能改的

只有 `packages/dsh-hdd-voice/` 目录内的文件，并且**只朝着 `DESIGN.md` 的方向改**。

## 你不能改的

| 不要动 | 原因 |
|---|---|
| `packages/dsh-skin-hdd-fairy/` | 皮肤的媒体层已自包含，是另一个 agent 的地盘。它不 import 你，你也不要 import 它。 |
| 皮肤那份 `asset-store.js` | 活的副本在皮肤包里；不要为了"两边一致"去改它。 |
| **不要注册 `/hdd/*`** | 那些路径归皮肤。重复注册只会打一条 warn，然后皮肤的路由被跳过——等于你悄悄抢了皮肤的活。 |
| `%USERPROFILE%\.dsh\profiles\**` | 用户运行时配置。尤其不要为了"让本包生效"去加 `insert` 行：皮肤已不再需要本包。 |

## 改造方向（`DESIGN.md`）

一句话：把「回合事件 → 播放一小段音频」做成**别人能直接调用的服务**，而不是某套皮肤的媒体层。

```ts
ctx.voiceCues.register({ id, label, dir, throttleMs?, background? })
ctx.voiceCues.play('thinking' | 'done' | 'failed')
ctx.voiceCues.list()
```

传输用**独立命名空间**（`/voice-cue/clip`、`/voice-cue/feed`），绝不复用 `/hdd/*`。
播放必须落在客户端（Host 没有音频控制权），失败一律静默降级。

分阶段：P0 抽纯逻辑 + 单测 → P1 Host 服务与路由 → P2 客户端播放 → P3 皮肤改为"有服务就用服务" → P4 发布件。

**开工前先让用户定 `DESIGN.md` 第七节的四个问题**（素材目录归属、并发策略、事件粒度、兼容期长度）。

## 硬约束（从两个事故里学来的）

1. 播放器只在客户端；**任何异常都不许抛到界面上**，失败就静音。
2. 不要给全屏层做 `opacity` 动画、不要用 `filter`（本机会整层白屏）；
3. 不要往 DOM 里放可见的 `<video>`（同上，会变成白屏平面）；
4. 路由一律"命名空间 + 重复注册兜底"，不要假设自己是唯一注册者。

证据见仓库 `docs/findings-2026-10-28-white-splash.md`。

## 改完必须跑

```sh
node --check index.js
node --test test/asset-store.test.js    # 9 项，证明冻结副本未被破坏
```

如果你开始做 P1/P2，请**新增**自己的测试，不要改现有那份（它是给"冻结副本"用的回归保险）。

## 需要用户点头才能做的事

- 让本包重新进入某个 profile（`dsh plugin add` / 手写 patch 行）——皮肤已经不需要它；
- 改皮肤包或 profile 配置；
- 删除任何素材文件。
