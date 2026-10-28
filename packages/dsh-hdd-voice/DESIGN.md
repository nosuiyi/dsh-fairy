# 设计草稿：把 `dsh-hdd-voice` 改造成通用语音提示包

> 状态：**草稿，未实现**。目的不是马上动手，而是先把边界定死，避免它长成"第二个媒体层"。
> 现状（2026-10-28）：媒体路由已整体移交 `dsh-skin-hdd-fairy`，本包只保留代码与测试，
> 不再为皮肤提供任何路由。

## 一、为什么要改造，而不是删掉

皮肤已经自包含，本包剩下的东西只有两类：

| 资产 | 是否值得留 | 理由 |
|---|---|---|
| `lib/asset-store.js`（素材约定：路径、媒体类型、时段分档、挑选） | **不值得** | 那是 HDD 皮肤自己的约定（六档问候、boot.mp4），别人用不上 |
| `index.js` 里的 cue 逻辑（回合开始/结束的提示音、去重、节流） | **值得** | 这是**跨插件通用需求**：任何插件都想"开工时叮一声、结束时叮一声"，而 `session/event` 的时序细节（`turn/start`、`turn/end` 的 `reason.kind`）没人愿意重学一遍 |

所以改造目标只有一句：**把"回合事件 → 播放一小段音频"这件事，做成别人能直接调用的服务**，
而不是给某套皮肤定制的媒体层。

## 二、边界（先说不要做什么）

1. **不提供素材**。任何音频都由使用者自备；包里只有代码。
2. **不再占用 `/hdd/*`**。那些路径归 `dsh-skin-hdd-fairy`，重复注册会打 warn 并让皮肤的路由被跳过。
3. **不做 TTS**。只播放现成文件；合成是另一件事（本机已有 GPT-SoVITS 环境，与本包无关）。
4. **不复制皮肤的素材约定**。不认 `dawn/morning/...` 分档、不认 `boot.mp4`——通用包只认"一套提示音"。
5. **不接管皮肤的播放**。皮肤愿不愿意改用它，是皮肤的决定。

## 三、接口形状（Host 半边）

以 **Cordis 服务**为主，HTTP 只作为"把字节送到浏览器"的传输：

```ts
// ctx.voiceCues —— 由本包提供
interface VoiceCues {
  /** 注册一套提示音；返回 disposer。同名重复注册以先注册者为准并打 warn。 */
  register(set: CueSet): () => void
  /** 列出当前可用的套（供设置页展示）。 */
  list(): CueSetInfo[]
  /** 手动触发一次（调试/外部事件用）。 */
  play(kind: CueKind, options?: { set?: string; force?: boolean }): void
}

interface CueSet {
  id: string                 // 例如 'hdd-fairy'、'build-watch'
  label: string
  /** 素材目录；文件名为 <kind>.<ext>，扩展名走白名单（m4a/mp3/ogg/opus/wav）。 */
  dir: string
  kinds?: CueKind[]          // 缺省全部三种
  /** 同回合去重窗口，默认 800ms。 */
  throttleMs?: number
  /** 后台/子会话是否发声，默认 false。 */
  background?: boolean
}

type CueKind = 'thinking' | 'done' | 'failed'
```

传输（唯一一条路由，命名空间与皮肤区分开）：

```
GET /voice-cue/clip?set=<id>&kind=<kind>     → 音频字节（支持 Range）
GET /voice-cue/feed?since=<seq>              → { seq, cues: [...] }，客户端轮询
```

事件来源：`ctx.on('session/event')` 里只认两个信号，其余忽略。

| 事件 | 映射 |
|---|---|
| `turn/start` | `thinking` |
| `turn/end` + `reason.kind === 'completed'` | `done` |
| `turn/end` + 其它 | `failed` |

> 这些判定的细节（字段名、`reason.kind` 的取值）应该只存在于本包，消费方不需要知道。

## 四、播放放在客户端（硬约束）

Host 没有音频设备控制权，播放必须在渲染进程。所以本包还需要**一个极小的客户端半边**：

- 订阅 `/voice-cue/feed`（400–1500ms 轮询，页面不可见时暂停）；
- 用**共享 AudioContext** 播放，同一时刻只播一条（新 cue 覆盖旧的或直接丢弃，可配）；
- 首次 `play()` 被拒时降级为 `<audio>`，再失败就静默——**任何情况下不抛错、不阻塞界面**。

我们踩过的两条经验，直接写进实现约束：

1. **不要给全屏层做 `opacity` 动画**（本机会整层白屏），提示音与视觉层无关，别顺手加淡入；
2. **`<video>`/`<audio>` 不进入可见 DOM**（同上），提示音用 `Audio`/`AudioContext` 即可。

## 五、和皮肤的关系（互斥还是协作）

三种可能，草稿里推荐 **B**：

| 方案 | 行为 | 评价 |
|---|---|---|
| A. 皮肤继续自己播 | 通用包只服务别人 | 最简单，但两套实现并存 |
| **B. 皮肤优先用服务** | 皮肤 `ctx.get('voiceCues')` 存在就用它注册自己的 set；不存在就用自带逻辑 | 一套实现，且不影响皮肤单独安装 |
| C. 服务接管所有播放 | 皮肤必须依赖本包 | 回到"隐式依赖"，不要 |

B 的判定顺序写死成：

```js
const cues = ctx.get('voiceCues')
if (cues !== undefined) { cues.register({ id: 'hdd-fairy', dir: join(root, 'cue') }); return }
/* 否则：皮肤现有的自带 cue 逻辑 */
```

## 六、分阶段（每阶段可独立回滚）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 把 cue 的"去重 / 节流 / 后台静音 / 事件映射"抽成一个纯模块，带单测 | `node --test` 覆盖：同回合两次 `turn/start` 只播一次、后台会话不播、`reason` 非 completed 走 failed |
| **P1** | Host 服务 `register/list/play` + `/voice-cue/clip`（Range）+ `/voice-cue/feed` | `curl` 能取到字节、feed 能返回 seq |
| **P2** | 客户端半边（订阅 + 播放 + 降级） | 手动 `play()` 能听到；页面隐藏时不轮询 |
| **P3** | 皮肤改为"有服务就用服务"，`/hdd/cue` 保留一个版本做兼容 | 皮肤在"有/无服务"两种环境下都能响 |
| **P4** | 发布件：`engines.dsh`、README、`NOTICE`、明确"包内无音频" | 市场条目可安装，装完无声音（符合预期） |

## 七、需要先定的四件事

1. **素材目录归属**：通用包用 `~/.dsh/voice-cue/<set>/`，还是**由调用方传 `dir`**（本草稿推荐后者，包不假设布局）？
2. **并发策略**：多个 set 同时要发声时——优先级？打断？还是"同一时刻只播一条，后来的丢弃"？
3. **是否需要"文本 → 提示"的映射**（例如按事件类型选不同音），还是固定三档 `thinking/done/failed` 就够？
4. **兼容期长度**：`/hdd/cue` 保留到什么时候？我建议"皮肤改用服务后的下一个小版本再删"。

## 八、不做的事（明确写出来，防止范围蔓延）

- 不做素材商店、不做下载器、不做在线音源；
- 不做音量混合器/Ducking（浏览器音量交给用户）；
- 不监听 `agent/assistant-stream` 之类的细粒度流（那会把提示音变成噪音）；
- 不处理"用户在别处静音"的情况（系统音量归用户）。
