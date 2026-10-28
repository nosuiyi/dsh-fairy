# dsh-skin-hdd-fairy

一套由 **DSH Skin Manager**（`@smalltailqwq/dsh-client-ui-skin-deep-whale-manager`）管理的皮肤：
HDD 启动动画、会呼吸并周期性"撕裂"的矢量徽记、按小时问候与回合提示音，外加深海军蓝的界面配色。

## 依赖关系：自包含，单包

| 包 | 作用 |
|---|---|
| `dsh-skin-hdd-fairy`（本包） | **全部**：`skin.json` + bundle 行 + 客户端（开屏、徽记、提示音、调色板）+ Host（素材清单、文件流、按小时选问候、提示音事件、导入/列目录/打开文件夹） |
| Skin Manager | 发现皮肤、互斥切换、渲染本皮肤声明的设置项、把值存进 localStorage |

**没有第二方依赖**。客户端调用的九个 `/hdd/*` 路由全部由本包自己提供：

| 路由 | 用途 |
|---|---|
| `/hdd/info` | 素材清单 |
| `/hdd/asset` | 视频/背景/音频流（支持 Range，可 seek） |
| `/hdd/greeting` | 按本地小时选问候 |
| `/hdd/cue` | 回合提示音事件 |
| `/hdd/report` | 客户端诊断日志 |
| `/hdd/import`、`/hdd/adopt` | 导入字节 / 把磁盘已有文件取用进来 |
| `/hdd/list` | 列目录里的媒体文件 |
| `/hdd/reveal` | 在文件管理器里打开素材目录 |

> 历史：这四条媒体路由原本在 `dsh-hdd-voice` 里，属于**未声明的隐式依赖**——只在 profile patch
> 恰好补了一行时才能用。现已合并进本包，`dsh-hdd-voice` 不再承担本皮肤的读取
> （该包后续会改造成**通用语音提示包**，见其 `DEPRECATED.md`）。

## 安装

```powershell
dsh plugin --profile desktop add <本仓库>/packages/dsh-skin-hdd-fairy
```

装完重启一次，然后在 **设置 → 皮肤管理** 里切换到「HDD Fairy」。皮肤是互斥的：启用本皮肤会自动禁用其他皮肤。

### 为什么不再需要手写 patch 行

皮肤管理器切换皮肤时会重写 `dsh.profile.bundles`，只保留 base + web-app + 当前皮肤。
以前 voice 包被挤掉时，四条媒体路由会一起消失（症状是"未检测到素材包"、没有动画和声音）。

现在这些路由在本包内，**只要皮肤是当前皮肤，路由就在**——不需要任何额外的 `insert` 行，
也不再受 bundles 重写影响。

另外 `dsh-hdd-visual` 与本皮肤**功能重叠**（都提供开屏与侧栏徽记），不要同时启用；
它的开屏会被本皮肤取代，两个一起开着只会更难排查。

## 管理器里的设置项

| key | 类型 | 作用 | 生效时机 |
|---|---|---|---|
| `splash` | boolean | 开机动画（视频 + 徽记 + 飞向侧栏的完整时间轴） | 下次启动 |
| `splashSource` | select | 开屏内容：**默认 `none`（不播开屏，直接进界面）** / `auto`（有动画播动画、没有就播背景图）/ `novideo`（跳过动画，背景图与高光板照常） | 下次启动 |
| `animEndS` | range 0–40 | 自定义动画播到第几秒结束；**0 = 播完整段** | 下次启动 |
| `voice` | boolean | 问候语音（需自备素材）：有开屏时在开屏里播，**无开屏时进界面约 0.9 秒后单独播一次** | 立即 |
| `cues` | boolean | 回合提示音（每回合一次；后台/子会话不发声） | 立即 |
| `markSize` | range 40–80 | 侧栏左下角徽记的边长（rail 态固定 30px） | 立即 |
| `markGlow` | boolean | 徽记的光晕、涟漪与周期性撕裂 | 立即 |

"立即"的项通过 `<body>` 上的 CSS 变量/属性生效，不需要重新注册或刷新；
"下次启动"的项只影响开屏时间轴，因为开屏只在文档加载时挂载一次。

设置值由管理器按 `skinId`（`hdd-fairy`）持久化；本包只实现 `apply(state)`，不写存储。
`apply(null)` 时会释放本皮肤拥有的一切（CSS、`<body>` 属性、定时器、开屏节点）。

## 启用时会把外观切成深色

皮肤的调色板是按深色配的，若壳子还停在浅色偏好，本皮肤没覆盖到的部分会显得突兀。所以 `apply` 时：

1. 读 `ctx.theme.getTheme().preference`，**不是 `dark`** 就调 `ctx.theme.setTheme('dark')`——
   这是外观偏好的唯一写入入口，会真实写进「通用设置 → 外观」，界面上就是「深色」；
2. **只做一次**：之后用户手动改回浅色/跟随系统，皮肤不会再抢回来；
3. **可逆**：皮肤被停用（`apply(null)`）时，只有当偏好仍是我们设的 `dark` 才恢复成原值，
   所以"切走皮肤"不会覆盖用户后来自己的选择。

日志里有 `theme-forced` / `theme-restored` 两条记录，可以确认到底有没有发生切换。

## 素材：发布版不带任何音视频，由用户自己放

发布包里**没有**动画、背景图或语音。（启动时会自动建好六个空档位目录——**空目录是正常的**，
不代表导入失败；判断"有没有素材"请看设置页的条数统计或日志里的 `assets` 事件。）用户把文件丢进 `$DSH_HOME/hdd-fairy/assets`（默认
`%USERPROFILE%\.dsh\hdd-fairy\assets`）即可；设置里有一页 **「HDD Fairy 素材」**，会显示这个目录、
检测到的文件与「重新扫描」按钮。

```
assets/
  boot.mp4            开屏动画（.mp4 / .webm，可选）
  boot.png            开屏背景图（.png/.jpg/.jpeg/.webp，可选）
  field.png           高光板（可选）
  greeting/           ← 六个档位文件夹，往里丢就是，**不用改名**
    dawn/             深夜 0–5
    morning/          早上 5–11
    noon/             中午 11–14
    afternoon/        下午 14–18
    evening/          晚上 18–22
    night/            深夜 22–24
  cue/                thinking.m4a / done.m4a / failed.m4a
```

### 问候语音怎么分辨"早上"和"中午"

**看它在哪个文件夹里**——文件夹名就是档位，文件名随便起：

```
greeting/morning/早安.m4a        → 早上
greeting/morning/第二个.mp3      → 早上（同一档位可以多放）
greeting/noon/吃饭啦.m4a         → 中午
```

| 档位文件夹 | 本地小时（左闭右开） |
|---|---|
| `dawn` | 0–5 |
| `morning` | 5–11 |
| `noon` | 11–14 |
| `afternoon` | 14–18 |
| `evening` | 18–22 |
| `night` | 22–24 |

**兼容老布局**：仍然认 `greeting/` 根目录下的前缀命名（`morning-1.m4a`、`noon.m4a`），
两种方式的结果会合并。但新放素材请直接用子文件夹，不必再操心命名。

旧规则（仅用于根目录下的平铺文件）：文件名去掉扩展名后等于档位 id、或以 `<档位>-` 开头。
`你好.m4a` 这种平铺文件不属于任何档位，**不会被播放**。

设置页里导入时会让你先选档位，文件会**保留原文件名**放进 `greeting/<档位>/`，天然合规。
页面上也会显示各档位的条数（如 `早上 2 · 中午 1`），「打开文件夹」按当前选中的档位打开对应子文件夹。

播放时的两个行为：同一档位有多条 → **随机**选一条，并尽量避免与上次重复；当前档位一条都没有 →
从**任意**档位里随机兜底（只录了早上，中午也会响，但响的是早上那条）。

### 在设置页里直接导入（每个类型记住自己的文件夹）

`设置 → HDD Fairy 素材` 每行都有「选择… / 导入…」按钮：

1. **第一次点**：打开桌面端的**原生文件夹选择器**（不是文件对话框），选中的目录按类型记住（`localStorage`；
   问候语音是按**档位**分别记忆，早上和中午可以是两个不同的目录）；
2. **之后点**：直接列出那个目录里的可用文件，点文件名即导入；
3. 想换目录：列表里的「换个文件夹…」；想换到上级：「上一级」；
4. 每行的 **「打开文件夹」**：在系统文件管理器里打开该类型的素材目录——单文件类型（动画/背景图/高光板）
   若已有文件，会直接在资源管理器里**选中它**；问候语音按当前选中的档位打开 `greeting/<档位>/`，
   提示音打开 `cue/`。

为什么不用浏览器自带的文件对话框：**网页无法指定文件对话框的起始目录**，Chromium 只按 profile 记住
"上次用过的文件夹"，所以视频和音频永远会落到同一个地方。用原生目录选择 + 自己列文件，才能做到
"视频一个目录、音频另一个目录"。浏览器 build 里没有 `window.__DSH_DIRECTORY_PICKER__` 时会退回普通
文件选择框（那种情况下仍然是 profile 级记忆，这是 Web 的边界）。

| 项 | 语义 | 允许的扩展名 | 上限 |
|---|---|---|---|
| 开屏动画 | **替换**（只删同 stem 的**视频**兄弟，背景图不受影响） | `.mp4` `.webm` | 96 MB |
| 开屏背景图 | **替换** | `.png` `.jpg` `.jpeg` `.webp` | 16 MB |
| 高光板 | **替换** | 同上 | 16 MB |
| 问候语音 | **添加**（保留原文件名，落进 `greeting/<档位>/`；重名自动加 `-2`） | `.m4a` `.mp3` `.ogg` `.opus` `.wav` | 8 MB |
| 回合提示音 | **覆盖同名** | 同上 | 4 MB |

Host 侧三个路由：

| 路由 | 作用 | 安全边界 |
|---|---|---|
| `POST /hdd/import` | 接收浏览器上传的字节 | 目标名由 `kind` + 白名单扩展名生成，请求里的路径不参与拼接 |
| `GET /hdd/list?dir=` | 列出一个目录里的媒体文件（名字 + 大小） | 只返回白名单扩展名的文件，从不返回内容 |
| `POST /hdd/adopt?dir=&name=` | 把磁盘上已有的文件复制进素材目录 | `name` 必须是裸文件名（不得含分隔符），扩展名仍需在白名单内；源文件已经在目标目录里时直接拒绝（否则会悄悄生成 `x-2.m4a`） |
| `POST /hdd/reveal?kind=&bucket=` | 在系统文件管理器里打开该类型的素材目录 | 目标目录只由 `kind`（+ 问候的 `bucket`）决定，请求里没有任何路径参数；进程用 `detached` + `stdio: ignore` 拉起，不归 Host 管 |

超限返回 413，未知 kind / 扩展名 / 档位 / 不可读目录返回 400，打不开文件管理器返回 500。

> 注意：`boot` 这个 stem 同时用于视频与背景图，所以"替换视频"只清理**同一扩展名白名单内**的兄弟文件——
> 早期实现没做这个限制，换视频会把 `boot.png` 一起删掉。

### 开屏的行为矩阵

固定不变的部分是**徽记的运动**：居中淡入 → 停留（有语音就等语音说完）→ 飞向左下角并入座。素材只决定它前面播什么：

| 素材情况 | 开屏顺序 |
|---|---|
| 有动画（`auto`） | **先播动画**（到 `animEndS` 或片尾）→ 徽记居中 → 停留 → 飞向左下角 |
| 只有背景图（`auto`） | 背景图作画布 → 高光板（若有）→ 徽记居中 → 停留 → 飞向左下角 |
| 什么都没有（`auto`） | 深色底 → 徽记居中 → 停留 → 飞向左下角（不显示任何"文件缺失"提示） |
| `splashSource = novideo` | **跳过动画**，其余照旧：背景图作画布、高光板照常、徽记照常飞 |
| **`splashSource = none`（默认）** | **完全不播开屏**，连徽记动画都省掉，直接进界面（等价于关闭「开机动画」） |

> 旧值 `mark` 会按 `novideo` 处理，已存的设置不会失效。

**默认为什么是不播开屏**：发布包不含任何素材，强制播一段"深色底 + 徽记"对第一次接触的人反而是等待。
默认直接进界面，想要开屏的人放好 `boot.mp4` / `boot.png` 再把「开屏内容」改成 `auto` 即可。

开屏、左下角徽记、问候语音是**三条独立的路**：不播开屏时，侧栏徽记、左上角品牌位、配色、面板纹理全部照常，
**问候语音仍会在界面出现约 0.9 秒后单独播一次**（走的是同一套 `/hdd/greeting` → 预载 → 播放，
只是没有时间轴托着它）。日志里记作 `greeting-standalone`。

所以"加了动画会不会被默认影响"的答案是：不会。动画只是接在徽记运动**前面**多播一段，后面完全一致；
`animEndS` 只截断用户自己的片段，0 表示播完。

## 提示音什么时候响

**挂在“一次运行”上，不是挂在“一个回合”上。** 一次用户消息在 DSH 里是多个 turn（每个模型往返一个），
早期按 `turn/start` / `turn/end` 触发，结果每个往返都响一遍——这就是"处理完毕"连环响的根因。

| 提示音 | 触发 | 说明 |
|---|---|---|
| `thinking`（推演中） | Agent 进入 `running` | 你发出消息、模型开始工作；一次运行**一次** |
| `done`（处理完毕） | Agent 回到 `idle`，且最后一个 turn 的 reason 是 `completed` | 运行结束 |
| `failed`（失败） | 同上，但 reason 为 `error` / `max-tokens` / `blocked` | 真正的失败 |
| 不发声 | `aborted` / `interrupted` / `forked` | 你点了停止、被中断、或交接子任务 |

状态翻转同时挂在两个事件上（实测**两个都会发**，只是先后不同）：

- `agent/status`（payload 带 `agent`）——通常**开始**时先到；
- `api-session/status(sessionId, running)`——通常**结束**时先到。

两者都进同一个幂等状态机，所以"两边都到"只会响一次；只押其中一个会让某个阶段变成哑巴。实测记录：

```
thinking    source: agent        ← 开始
done        source: api-session  ← 结束
status-idle source: api-session  ← 另一条重复翻转被吃掉
```

另外五条规矩：

1. **后台会话静音**：`origin === 'subagent'` 或带 `parentSession` 的会话（子代理、工作流步骤）不发声；
2. **一个文档只有一个轮询器**：句柄挂在 `window.__hddCuePoller`，新实例启动先把旧的 `stop()` 掉——
   模块被重复 apply 时，两个 `setInterval` 会各自取到同一条 cue，听起来就是"响两声"；
3. **按 `seq` 跨实例去重**：播过的 cue 序号记在 `window.__hddCuePlayed`（不放在闭包里，否则每个实例各记一份）；
4. **纪元重置**：服务器返回的 `seq` 比本地游标小 → 宿主重启过，清空去重集合，否则新序号会撞车被静音；
5. **首轮只对齐不发声**：页面刷新时不会把服务器缓存的旧提示音重放一遍；同类另有 900ms 节流、轮询防重入。

另外 `/hdd/cue` 每次真的投出 cue 时记一行 `{"event":"cue-deliver","detail":{client, seq}}`，
所以"响两声"可以当场分辨是**一个客户端收到两次**还是**两个客户端各收到一次**。

每次决策都会往 `hdd-visual.log` 写一行 `{"event":"cue","detail":{kind, sessionId, reason, source}}`，
"响了几次、为什么响"可以直接查，不用凭耳朵记。

完整的排查过程与教训见
[`docs/findings-2026-10-28-cue-signals.md`](../../docs/findings-2026-10-28-cue-signals.md)。

## 皮肤契约要点（改这个包前先读）

- `skin.json` 必须能被 `require.resolve('<包名>/skin.json')` 找到 → `package.json#exports` 里要有 `./skin.json`；
- `package` 字段必须等于真实包名；`bodyAttr` 必须匹配 `^data-[a-z0-9_.:-]+$`（本包用 `data-dsh-hdd-fairy`，写在 `<body>` 上）；
- `dshCompatibility` 必须匹配 `^\d+\.\d+\.\d+rc\d+$`，本机 DSH 为 `0.2.1-rc.3` → 写 `0.2.1rc3`；
- bundle 行 id 必须等于 `wiring.id`（`ui-skin-hdd-fairy`）；**不要**手写管理器那个 `dsh-skin managed` 区段，它归管理器所有；
- 所有样式以 `body[data-dsh-hdd-fairy]` / `html:has(> body[data-dsh-hdd-fairy])` 开头。**绝不要**把属性选择器写成裸的 `[data-…]`——它会连 `<html>` 一起匹配，把整个应用压成窄列（见仓库 `docs/findings-2026-10-28-narrow-window.md`）。

## 面板纹理：类名是构建哈希，靠"解析"而不是"抄写"

壳子给各列挂的是 CSS Modules 类名：`an3WzG_root`、`mP3x-q_frame`…… **前缀是构建哈希，每次发版都可能变；后缀稳定**（来自模块路径）。所以本包不写死前缀，而是启动时按后缀解析：

1. 扫 DOM：找带 `<任意前缀>_<suffix>` 的元素；
2. 扫 `document.styleSheets` 的 `cssRules`（conversation 等 bundle 把 CSS 注进去）；
3. 扫 `<style>` 的 `textContent`；
4. 都没找到 → 落到 `FALLBACK_PREFIXES` 常量（当前是 0.2.1-rc.3 实测值）。

**解析会跑两次**：`apply` 时那一次几乎必然落到常量（这时壳子还没挂载、样式表还没注入），所以挂载后还会每 500ms 重试一次（最多 24 次），一旦拿到 `live` 且与常量不同，就**原地替换样式表内容**——这才是"换版本也能自适应"真正生效的地方。

选前缀时**先按"覆盖了多少个后缀"排序，再按出现次数**：`frame` 在这个 build 里有 5 个候选前缀，纯按频率会挑到别的模块的 `_root`，配对出来的规则永远匹配不上。

解析结果会写进日志，一条就能判断皮肤吃到了哪一层：

```json
{"event":"skin-classes","detail":{"source":"live","missing":[],
 "classes":{"frame":"mP3x-q_frame","root":"an3WzG_root", "...":"..."}}}
```

- `source: "live"` → 全部来自页面，最准；
- `source: "fallback"` + `missing: [...]` → 有后缀没解析到，看下一节。

### DSH 更新后类名又变了怎么办（两条命令）

```sh
# 1. 重新扫出前缀，并把打印出来的 FALLBACK_PREFIXES 覆盖到 lib/client.js
node tools/scan-skin-classes.mjs

# 2. 语法自检
node --check lib/client.js
```

扫描器会打印每个后缀命中的前缀、谁和谁同组，以及可以直接粘贴的常量块。退出码 1 表示有后缀没找到（壳子可能改名了，而不只是换哈希）。

**降级行为**：某个后缀没解析到时，只有依赖它的那条规则不生成——例如 `composerSeat` 缺失只影响输入框底板，配色、开屏、徽记都不受影响，也不会有半截样式。

## 已知限制

1. **没有美术资源**：参考皮肤的立绘走 `/skin-assets/<id>/<hash>.webp`，本包不打包任何第三方素材；开屏视频/背景图/语音都由用户自备，走本包自己的 `/hdd/asset`（支持 Range）。
2. ~~面板纹理没有移植~~ —— **已移植**。原版依赖的哈希类名在当前 build 里换了前缀（`Dc7zOa_*` → `an3WzG_*`、`BynINW_*` → `mP3x-q_*`），后缀并没有变。现在改为**运行时解析前缀**，见下节。
3. **composer 上方的白色小方块不是皮肤元素**：它间歇出现、在 DOM 里完全不存在（`elementFromPoint` 命中透明输入框、区域内没有任何 `svg` 或近白背景节点），连续 4 帧扫描也抓不到稳定实体。最可能是 **Windows 原生 tooltip / 输入法候选框**——由系统绘制，天然是浅色，不受页面样式影响。如果是原生窗口气泡，皮肤这边无需也无法处理。
4. **侧栏徽记只在展开态出现**：`sidebar.footer.action` 在收起（compact rail）时不渲染。左上角的品牌位（`sidebar.brand.mark` / `sidebar.brand.name`）在**当前 build 里占不到**（壳子占着 single 座），所以用 CSS 原位替换：藏掉壳子的内联 SVG，再画上本皮肤的矢量与文字。守卫条件 `:not(:has([data-hdd-brand-mark]))` 保证——哪天槽位能占了，这两条规则会自动让位，不会重复显示。

## 发布件包含什么

`npm pack` 只打运行时必需的文件（`files` 白名单，实测 **10 个、约 194 KB**，压缩后约 61 KB）：

| 打包 | 说明 |
|---|---|
| `package.json` / `skin.json` / `cordis.patch.yml` | 包清单、管理器契约、bundle 行 |
| `lib/index.js` / `lib/client.js` / `lib/asset-store.js` | Host 半边、Client 半边、素材约定 |
| `README.md` / `CHANGELOG.md` / `LICENSE` / `NOTICE` | 文档、变更记录与许可（徽记几何的第三方署名在 NOTICE） |

**不打包**：`test/`（单测）、`tools/`（`smoke.mjs` 自检、`scan-skin-classes.mjs` 类名扫描）、`AGENTS.md`（仓库内工作说明），以及任何音视频素材——素材由用户自备，仓库不放媒体。

## 许可

代码 Apache-2.0（见 `LICENSE`）。徽记的矢量几何取自 [Fairy-DSH](https://github.com/Chengzhibense/Fairy-DSH)（Apache-2.0）并重绘，署名与说明见 `NOTICE`；调色板与动效参数同样参考该皮肤。本包不包含任何游戏美术或字体（参考中的"印品鸿蒙体"为授权字体，未嵌入）。
