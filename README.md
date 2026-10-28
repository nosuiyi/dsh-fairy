# hdd-fairy

给 DSH 桌面端的一套「HDD 风格开屏 + 常驻徽记 + 静态语音」插件。

- **不打包任何第三方素材。** 开屏背景、问候语音、提示音全部由**用户自己放入**一个目录，
  所以每个人可以用自己的音频与开场画面，仓库里也不含任何游戏素材。
- **不依赖外部运行时。** 没有 Python、没有 TTS 服务、没有子进程；语音是提前录好/生成好的
  文件，运行时只是读文件并播放。
- **槽位用法。** 主体走 `sidebar.footer.action`（`list` 槽）与 `settings.section`（`list` 槽）；
  左上角品牌位用 CSS 原位替换（`sidebar.brand.mark` / `.name` 是 `single` 槽且已被壳占用，
  同优先级注册占不到），新会话页的 `conversation.hero.brand.mark` 是空座，直接注册。
  所有注册都在 `ctx.effect` 里，停用皮肤即归还。
- **不改主题令牌。** 自己的表面自己画；`--dsw-*` 令牌仍归 `ui-theme` 所有（仅在启用时把外观偏好设为深色，可逆）。

## 文档地图

| 文件 | 是什么 | 什么时候看 |
|---|---|---|
| `docs/asset-convention.md` | 素材约定（视频/背景/问候/提示音的文件名与格式） | 准备放入素材时 |
| `docs/voice-lines.final.md`、`docs/voice-lines.final.json` | **台词定稿**（6 档 × 3 条问候 + 3 条提示音） | 改文案、重新生成语音时；JSON 是权威版，MD 由它渲染 |
| `docs/voice-render-report.md` | Edge-TTS 那版的生成报告（逐条时长与偏差） | 只想快速试听、不装 GPT-SoVITS 时 |
| `docs/tts-setup.md` | 本机 GPT-SoVITS v2 安装记录（路径、版本、坑、实测） | 重装环境或换机器时 |
| `docs/fairy-persona.md` | Fairy 角色卡（写作版，不含第三方原文） | 自己写台词或交给模型写时 |
| `docs/prompt-for-gemini.md` | 给模型的写作包（任务/硬约束/输出格式/自检） | 同上，配套使用 |
| `docs/findings-2026-10-27-static-audio-probe.md` | 探测：静态音频在桌面端能否播放（autoplay / Range / .m4a） | 怀疑音频路线时 |
| `docs/findings-2026-10-28-white-splash.md` | 排障：开屏播视频时整窗白屏（探针矩阵 + 复现清单） | 动开屏可视层之前，**必读** |
| `docs/findings-2026-10-28-narrow-window.md` | 排障：开屏后期界面变窄、点不动 | 同上 |
| `docs/findings-2026-10-28-cue-signals.md` | 排障：提示音"处理完毕"连响；一次消息 = 多个 turn；两个状态事件的分工 | 改提示音触发逻辑之前，**必读** |
| `AGENTS.md`（仓库根 + 两个包内各一份） | 多 agent 并行的边界：谁改哪个包、三条跨包禁令、共享事实的唯一来源、验证顺序 | **接活之前先读** |
| `packages/dsh-skin-hdd-fairy/README.md` | 皮肤包说明：设置项、素材两种布局、面板类名解析、voice 的挂法 | 动皮肤之前先看 |
| `docs/bundles-watch.log` | 一次性诊断日志（监听到 profile 被改写） | 只在查 `dsh.profile.bundles` 被谁改写时用 |
| `lab/` | **一次性排查工具，可删**：白屏排查时的探针（`probe-client.js`）、窗口定时截图与带 CDP 重启的脚本、早期 `dsh-lab-audio` 实验包、以及当时的 `client.js` 快照 | 只在复现那两次事故时需要；不参与构建、不参与运行 |

历史版本：`docs/voice-lines.json`（我的初版）、`voice-lines.gemini.json` / `gemini2.json`（模型两轮稿）、
`voice-lines.md`（初版渲染）。保留作对比，**不要拿它们生成音频**。

`lab/` 里的东西不属于运行时：三个 `.ps1` 是当时用来定时截图、以及带 `--remote-debugging-port`
重启应用的小工具；`probe-client.js` 是只能在排查时临时顶替 `client.js` 的问答式探针；
`backups/` 是当时几份 `client.js` 快照。**整个目录删掉不影响插件。**

## 组成

| 包 | 半边 | 职责 | 状态 |
|---|---|---|---|
| `packages/dsh-skin-hdd-fairy` | Client + Host | **皮肤本体，自包含单包**：开屏时间轴、徽记、问候与提示音播放、调色板、面板纹理、素材清单/文件流/导入/打开目录、设置项 | **当前主力**，由皮肤管理器互斥切换 |
| `packages/dsh-hdd-voice` | Host | 曾提供素材清单、文件流、按小时选问候、提示音事件 | **媒体层已并入皮肤包**，不要再为皮肤启用它；后续计划改造成**通用语音提示包**（见其 `DEPRECATED.md`） |
| `packages/dsh-hdd-visual` | Client（Host 半为空） | 早期独立插件版：开屏 + 徽记 + 播报 | **已被皮肤取代**，与皮肤功能重叠，不要同时启用 |

依赖关系：**只剩一个包**。客户端调用的九个 `/hdd/*` 路由（清单、流、选问候、提示音、诊断、
导入、取用、列目录、打开目录）全部由皮肤包自己提供，因此不再有"隐式依赖 + 本机补丁"的问题。

> 历史坑（已解决）：皮肤管理器切换皮肤时会重写 `dsh.profile.bundles`，以前 voice 会被一起挤出去，
> 导致四条媒体路由消失（表现为"未检测到素材包"、没有动画与声音）。合并后路由随皮肤走，
> 不需要任何额外 `insert` 行。

## 下载与安装

| 渠道 | 地址 |
|---|---|
| GitHub Releases（推荐） | <https://github.com/nosuiyi/dsh-fairy/releases> — 下载 `dsh-skin-hdd-fairy-<版本>.tgz` |

```powershell
# 先完全退出 DSH 桌面版
dsh plugin --profile desktop add <路径>/dsh-skin-hdd-fairy-0.2.0.tgz
# 再启动 DSH → 设置 → 皮肤管理 → 切到 HDD Fairy
```

发布件只有代码、契约、文档与许可（10 个文件，约 61 KB），**不含任何音视频素材**：
素材放进 `%USERPROFILE%\.dsh\hdd-fairy\assets`，或直接在「设置 → HDD Fairy 素材」里导入。
默认不播开屏、直接进界面；左下角徽记、左上角品牌位与深色配色即装即生效。

## 从源码安装（开发期）

```powershell
# 先完全退出 DSH 桌面版
dsh plugin --profile desktop add <本仓库>/packages/dsh-skin-hdd-fairy
# 再启动 DSH，然后在「设置 → 皮肤管理」里切到 HDD Fairy
```

一个包就够：媒体路由、素材导入、提示音都在里面，**不需要**再补 profile patch 行。
（若旧环境里还留着 `dsh-hdd-voice` 的 `insert` 行或依赖，删掉即可；素材目录 `~/.dsh/hdd-fairy/assets` 不受影响。）

> 副作用提醒：`dsh plugin add/remove` 会重写 profile 的 `dsh.profile.bundles`，
> 且实测会把**其他第三方 bundle 一起从列表里丢掉**。操作前请备份
> `$DSH_HOME/profiles/<name>/package.json`。

## 已知问题与踩坑

开屏播放 `boot.mp4` 时"整窗白屏、有声音没画面"的问题已定位并修复，原因、探针矩阵与复现清单见
[`docs/findings-2026-10-28-white-splash.md`](docs/findings-2026-10-28-white-splash.md)。三条硬约束：

1. **`<video>` 元素绝不能进入 DOM**（哪怕 2×2、`opacity: 0.01`）——否则整窗被一张白色平面盖住；
2. **开屏层不能做 `opacity` 淡入/淡出**——含视频帧 canvas 的全屏层会整层失效；
3. **开屏内部不能用 `filter`**（徽记外发光因此移除）。

另一个坑：开屏后期界面变成"中间一条、两边深色、点不动"，原因是**属性选择器 `[data-hdd-splash]` 连 `<html>` 一起匹配了**
（开屏标记属性写在 `documentElement` 上），于是文档根被 `position: fixed` + `display: grid` + `pointer-events: none` 接管，
`body` 收缩成内容宽度。详见 [`docs/findings-2026-10-28-narrow-window.md`](docs/findings-2026-10-28-narrow-window.md)。两条硬约束：

4. **给 `<html>` 加标记属性时，样式选择器必须限定元素类型**（写 `div[data-…]`，别写 `[data-…]`）；
5. **绝不要把 `pointer-events: none` 写进可能命中 `html`/`body` 的规则**（整页会失去交互，看起来像卡死）。

### 三条通用教训（上面两个 bug 同源）

这两个事故的形态完全一样：**一个全局副作用没有限定作用域**。所以记三条：

1. **全局副作用必须限作用域。** 选择器带元素类型（`div[data-…]`）；不要用 `<html>`/`<body>` 上的属性当全局开关；
   `pointer-events`、`position`、`display`、`overflow` 这类会影响整页的声明，绝不能出现在宽匹配规则里。
   一个属性 toggle 就能把应用压成 461px 宽的窄列并吞掉所有点击——代价与影响面完全不成比例。
2. **排查布局问题先量数值，别先看截图。** 一次采样就能分辨「缩放 / DPI / 窗口真窄 / 被谁挤窄」：
   `innerWidth`、`devicePixelRatio`、`visualViewport.scale`、`<html>` 的 `display` 与 `position`、
   `body` 的 `getBoundingClientRect()`。本次就是靠 `body={w:461,h:5093}`、`sidebar:0` 一眼定性的；
   而宽度随内容变化（461→468→477→757）直接指向「`body` 变成了收缩到内容的盒子」。
3. **客户端半边可以热重载，一行改动就能在活着的页面里做实验。** 本次最终定位靠的就是
   「热重载 + 一个属性开关 + 两次测量」，全程没重启应用。两个附属注意：热重载后**旧模块的 `setTimeout` 仍会触发**
   （排查时曾因此"自己"重放了一次开屏，很容易误判）；同时 `__hddVisualApplied` 会拦住开屏重放，
   要看完整开屏必须重启应用。

### 徽记只在侧栏展开时出现（有意为之）

`sidebar.footer.action` 只在展开的列里渲染；收起后这一列变成 compact control rail，页脚整排不渲染，
徽记随之消失。收起态"仍然存在"的两个单座都已被壳占用：

| 座位 | 用途 | 后果 |
|---|---|---|
| `sidebar.brand.mark` | 展开的 brand 行**与收起 rail** 的品牌标 | 注册会替换掉 DeepSeek 品牌标（`shadows-shipped-ui`） |
| `sidebar.toggle.badge` | 收起态展开按钮里的通知角标 | 注册会替换掉通知角标（`shadows-shipped-ui`） |

两者都会被壳的既有内容替换，所以**不做**。`Mark` 仍然读取插槽给的 `wide`（`false` = 56px rail），
把尺寸切成 60px / 30px 两档；本 build 里后者用不到，留作换 build 或换皮肤时的保险。

尺寸、光晕/涟漪/撕裂的开关、以及"视觉放大但布局不变"等可选调优，连同验证清单一起记在
[`docs/pending-mark-tweaks.md`](docs/pending-mark-tweaks.md)（当前为暂不实施）。

## 素材

见 [`docs/asset-convention.md`](docs/asset-convention.md)。默认目录：

```
%USERPROFILE%\.dsh\hdd-fairy\assets\
```

## 自检

```sh
node --test packages/dsh-skin-hdd-fairy/test/asset-store.test.js
node packages/dsh-hdd-visual/tools/smoke.mjs
```

`smoke.mjs` 会在 Node 里真跑一遍客户端半边（含完整开屏时间轴），能抓到语法检查抓不到的
运行时错误——这类错误曾经让一整套皮肤加载失败而界面全没。

## 许可

计划按 Apache-2.0 发布；`LICENSE`、`NOTICE`、`TRADEMARKS.md`、`RELEASE-CHECKLIST.md`
等发布件在 C 步补齐（本仓库当前只含源码与自检）。素材不在本仓库内，其版权归提供者。
