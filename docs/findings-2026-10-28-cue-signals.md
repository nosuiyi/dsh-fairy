# 排查记录：提示音"处理完毕"连响、以及到底该挂哪个事件

> 环境：DSH 0.2.1-rc.3 桌面端（Windows x64）
> 涉及文件：`packages/dsh-hdd-voice/index.js`、`packages/dsh-skin-hdd-fairy/lib/client.js`
> 结论版本：`cueMode: per-run`
>
> **后续**：语音包的媒体层（含本页描述的状态机）已合并进 `packages/dsh-skin-hdd-fairy/lib/index.js`，
> `dsh-hdd-voice` 退役。下文写 `packages/dsh-hdd-voice/index.js` 的地方，现在对应
> `packages/dsh-skin-hdd-fairy/lib/index.js` 里的 `installCueFeed()`。

## 一、现象

1. 任务结束时「处理完毕」会响**很多次**；
2. 「推演中」出现时机不可预期：有时一轮对话响好几次，有时又很频繁。

## 二、排查过程

### 1. 第一版：挂在回合边界上（错）

最初实现监听 `session/event`：

```js
if (event.type === 'turn/start') pushCue('thinking')
if (event.type === 'turn/end') pushCue(kind === 'completed' ? 'done' : 'failed')
```

看上去"回合开始=思考、回合结束=完成"很合理。**但 DSH 的一次用户消息是多个 turn。**

证据来自 `session/event` 的事件契约（`SessionEventMap`）：

```ts
'turn/start': { turn: number }
'turn/end':   { turn: number; reason: TurnEndReason }
'step/start': { turn: number; step: number }
'step/end':   { turn: number; step: number }
```

一个 turn 里有很多 step（界面上的"25 轮 448 步"——轮就是 turn，步就是 step），而**每个模型往返
都会结束并开启新的 turn**。于是 `turn/end` 每个往返都发一次 → 每个往返都算"完成" → 连环响。
`turn/start` 同理 → 「推演中」时多时少。

### 2. 第二版：按 `(会话, 回合, 类型)` 去重（仍不够）

加了幂等集合后，重复的**同一条**事件不会再响第二次。但不同的 turn 是不同的 key，
所以"每个往返响一次"依然成立——**去重解决不了粒度错误**。

同时补了后台静音（子代理/工作流步骤也各有 turn）：

```js
header.origin === 'subagent' || header.parentSession !== undefined  // 不发声
```

### 3. 第三版：改挂"运行状态"（对，但一开始没生效）

正确的粒度是**一次运行**（agent 从 `running` 到 `idle`），而不是一个回合。
候选事件：

| 事件 | 签名 | 说明 |
|---|---|---|
| `agent/status` | `(payload: { agent; status: AgentStatus })` | Agent 状态 `idle ⇄ running`，payload 带 `agent`（可取 `agent.session`） |
| `api-session/status` | `(sessionId, running: boolean)` | 同上，API 层视角 |

改完后**用户仍然听到重复**。查日志发现：`hdd-visual.log` 里一条该有的记录都没有。

### 4. 关键教训：先确认"跑的是哪一版"

在宿主半边加了每次决策的日志行与启动自报版本：

```js
trace({ kind: 'voice-apply', cueMode: 'per-run' })   // apply() 第一行
trace({ kind, sessionId, reason, source })           // 每次 pushCue
```

重启后日志才出现 `voice-apply` —— 之前**一直都是旧进程在跑**：

- 客户端模块改动会热重载（日志里有 `apply` / `splash-skip`）；
- 皮肤宿主改动会出现 `host-apply`；
- **但 `dsh-hdd-voice` 的宿主改动不会热重载**，必须重启 DSH。

所以在"宿主包"上改逻辑，验证前先看自报版本，否则会跟一个旧进程较劲半天。

### 5. 实测结果：两个状态事件都会发，只是先后不同

重启后跑一次消息，日志如下（节选）：

```
11:46:09  {"kind":"thinking","source":"agent","running":true}
11:46:36  {"kind":"done","reason":"completed","source":"api-session"}
11:46:36  {"kind":"status-idle","source":"api-session"}
```

- **开始**：`agent/status` 先到；
- **结束**：`api-session/status` 先到；
- 另一次翻转来自另一条事件，被幂等状态机吃掉（`status-idle`，不发声）。

如果只监听其中一个，就会有一个阶段**完全没声音**——而且哪个阶段哑掉取决于时序，
看起来就像"随机坏掉"。

## 三、结论

### 规则

| 提示音 | 触发 |
|---|---|
| `thinking` | agent 进入 `running`（一次运行一次） |
| `done` | agent 回到 `idle`，且最后一个 turn 的 reason 为 `completed` |
| `failed` | 同上，但 reason 为 `error` / `max-tokens` / `blocked` |
| 静音 | `aborted` / `interrupted` / `forked`（用户停止、被中断、交接子任务） |
| 静音 | 后台会话：`origin === 'subagent'` 或带 `parentSession` |

### 实现要点

1. **幂等状态机**：`runs: Map<sessionId, { running, reason }>`。
   重复的 `running: true` 直接忽略；`running: false` 时若本来就不在跑，也不发声。
2. **两个事件共用同一个入口** `handleStatus(id, running, source)`，谁先到谁生效。
3. **reason 单独采集**：`running: false` 本身分不清"完成"和"被取消"，
   仍靠 `session/event` 的 `turn/end` 记录最后一个 reason。
4. **客户端兜底**（`installCues`）：
   - 轮询**防重入**（慢请求时两个 poll 会抢到同一条 cue → 播两次）；
   - 同类提示音 900ms 节流；
   - 首轮轮询只对齐 `seq`、不发声（否则刷新页面会重放服务器缓存的旧提示音）。

## 四、复发：重复其实在客户端（同日第二轮）

按上面的规则改完、重启验证"开始一声、结束一声"通过。**但过了一阵，重复又出现了。**

### 1. 先看宿主，排除它

```
12:59:22  {"kind":"thinking","source":"agent","running":true}
13:00:49  {"kind":"done","reason":"completed","source":"agent"}
13:01:44  {"kind":"thinking","source":"agent","running":true}
13:02:05  {"kind":"done","reason":"completed","source":"agent"}
```

每轮运行**只有一条** `thinking` + **一条** `done`。宿主侧是干净的。

结论：**"宿主只发一次"并不等于"只响一次"**。中间还隔着一条投递链路，
它同样可能把同一条 cue 变成两次声音。

### 2. 真正的原因：一个文档里跑了多个轮询器

`installCues` 里用 `setInterval` 轮询 `/hdd/cue?since=<seq>`，`seq` 是**闭包变量**。
而这个客户端模块会被重复 apply（热重载、重复注入）：

- 旧实例的闭包游标停在 N；
- 新实例从 0 / 自己的游标重新开始；
- 两个 `setInterval` 同时存在，各自请求同一段区间 → 同一条 cue 被取到两次 → **播两遍**。

客户端的 900ms 同类节流只能挡"极近的两次"，而两个轮询器的请求往往相隔几百毫秒以上，
恰好漏过去。

### 3. 修法：单轮询器 + 跨实例去重 + 纪元重置

| 层 | 实现 |
|---|---|
| 单轮询器 | 轮询器句柄挂在 `window.__hddCuePoller`；新实例启动时先 `previous.stop()` 再接管，一个文档永远只有一个定时器 |
| 跨实例去重 | 已播过的 `cue.seq` 存 `window.__hddCuePlayed`（`Set`，上限 256），不放在闭包里——这样多个实例共享同一份"播过"记录 |
| 纪元重置 | 若服务器返回的 `seq` **比本地游标小**，说明宿主重启、序号从头开始，于是 `played.clear()`；否则新纪元的 cue 会因为序号撞车被误判成"已播"而静音 |

另外给宿主 `/hdd/cue` 加了投递日志，客户端每次请求带上自己的随机 `client` id：

```json
{"event":"cue-deliver","detail":{"client":"pc2oq4","seq":[2]}}
```

这让"响两声"可以当场分辨：**一个 client 收到两次**（轮询器重复）
还是**两个 client 各收到一次**（两个渲染文档都在播）——两者的修法完全不同。

### 4. 修复后的证据

```
13:06:03  cue-deliver  client: pc2oq4  seq: [1]
13:06:06  cue-deliver  client: pc2oq4  seq: [2]
13:06:18  cue-deliver  client: pc2oq4  seq: [3]
distinct client count: 1
```

序号连续、只有一个客户端，实际听感也是"一声"。

## 五、教训清单

1. **"一次用户消息 ≠ 一个 turn"**。凡是"每轮响一次"的心智模型都会失效，要按"运行"思考。
2. **去重不能修正粒度**。`(会话, 回合, 类型)` 只能挡住重复事件，挡不住"回合太多"。
3. **状态类事件往往有多路**（agent 层 / api 层）。全都接进同一个幂等状态机，比赌某一路稳。
4. **宿主包改完先确认版本**：自报一行日志，比反复猜"是不是没生效"便宜得多。
5. **可数才算修好**：每次决策写一行日志，让"响了几次、为什么响"可以从文件里数出来。
6. **"发一次"≠"响一次"**：决策端干净，不代表投递端干净。中间任何一环重复取用，
   听感都会变成两声——所以决策日志和投递日志要分开记。
7. **定时器类的状态不能只放在闭包里**：模块一旦被重复 apply，闭包游标就是两份，
   去重必须放在多个实例都能看到的地方（`window`），并且要给"对方重启过"留一个纪元判断。
