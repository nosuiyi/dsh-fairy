# 给 agent 的工作说明（仓库级）

这个仓库可以被**多个 agent 并行维护**，前提是各自只在自己的包目录里动手。这份文件说明边界、
共享事实的单一来源，以及跨包的禁区。

## 包的所有权

| 包 | 职责 | 现状 | 谁可以改 |
|---|---|---|---|
| `packages/dsh-skin-hdd-fairy` | **皮肤本体**：开屏、徽记、提示音、调色板、面板纹理、九个 `/hdd/*` 路由（媒体读取 + 素材导入） | 主力，自包含 | 只改这个包的人 |
| `packages/dsh-hdd-voice` | 媒体层已移交；方向是改造成**通用语音提示包**（`DESIGN.md`） | 无运行时职责 | 只改这个包的人 |
| `packages/dsh-hdd-visual` | 早期独立插件版，已被皮肤取代 | 归档 | 除删除外不要动 |

**一个包一个 agent。** 每个包目录里都有 `AGENTS.md` 写明能改什么、不能改什么、改完跑什么。

## 三条跨包禁令

1. **不许互相 import**。两个包各自带一份 `asset-store.js`：皮肤那份是活的，voice 那份已冻结。
   不要"为了保持一致"去同步——它们的用途不同。
2. **不许抢路由命名空间**。`/hdd/*` 归皮肤；通用语音包用 `/voice-cue/*`。
   DSH 的 `webServer.register` 对重复 `(kind, path)` 会抛错，抢到的代价是对方静默失效。
3. **不许改用户的 profile 配置**（`%USERPROFILE%\.dsh\profiles\**`）。需要时先列出来问用户。

## 共享事实的单一来源

| 事实 | 唯一来源 | 不要做的事 |
|---|---|---|
| 白屏 / 窄列 / 视频合成三个事故的结论 | `docs/findings-2026-10-28-white-splash.md`、`...-narrow-window.md` | 不要凭记忆"修一下"，也不要改写既有结论 |
| 素材约定（文件名、两种问候布局、媒体类型） | `docs/asset-convention.md` + 皮肤的 `lib/asset-store.js` | 不要在两个包里各写一套 |
| 台词与语音生成流程 | `docs/voice-lines.final.json`（权威）+ `tools/render-voice.mjs` | 不要手改渲染出来的 `.md` |
| 皮肤管理器的契约（`skin.json`、行 id、`bodyAttr`） | 皮肤的 `README.md`「皮肤契约要点」 | 不要手写 `dsh-skin managed` 段 |
| 本机 TTS 环境（GPT-SoVITS） | `docs/tts-setup.md` | 不要把它写进任何包 |

## 本仓库的素材纪律

**仓库里不放任何音视频/图片素材**，两个例外：

1. `lab/` 里那个 8KB 测试音 —— 属排查残留，可删；
2. **文档用截图** —— `docs/assets/` 下允许放 README 用的效果图（当前只有 `screenshot.png`）。
   条件：**自己截的**；**不得含用户自备的游戏素材**（开屏动画帧、立绘、音乐一律不许入镜）；
   皮肤自己的徽记可以入镜，但必须保留 `NOTICE` 的署名与 README 的「非官方作品」声明；
   随皮肤改版就更新；它不参与构建、不进 npm 包（`files` 白名单里没有 `docs/`）。

开屏动画、背景图、问候、提示音全部由用户自备，放进 `~/.dsh/hdd-fairy/assets`。
新增代码时不要打印、内联或打包任何第三方媒体。

## 通用验证顺序

```sh
# 1. 语法
node --check packages/*/lib/*.js packages/*/index.js

# 2. 皮肤：单测 + apply/释放
node --test packages/dsh-skin-hdd-fairy/test/asset-store.test.js
node packages/dsh-skin-hdd-fairy/tools/smoke.mjs

# 3. voice：冻结副本回归
node --test packages/dsh-hdd-voice/test/asset-store.test.js

# 4. 台词表若改过
node tools/check-lines.mjs docs/voice-lines.final.json
```

全绿才算改完。跑不过先回退，不要"顺手再改点别的"。

## 提交前自检

- [ ] 只改了自己包的目录；
- [ ] 没有新增跨包 import；
- [ ] 没有把素材文件加进仓库（`docs/assets/` 里的 README 截图除外）；
- [ ] 改到开屏/可视层时，读过两份 findings 并遵守那五条硬约束；
- [ ] 改完的验证命令贴进了汇报里（四类各自的结果）。
