# 排查记录：开屏播放动画时整窗白屏

> 环境：`@deepseek-ai/dsh-desktop` 0.2.1-rc.3 · Electron 44.7.0 · Chromium 152 · Windows x64 ·
> RTX 3060 Laptop（驱动 32.0.16.1692）· 1080p
> 涉及包：`packages/dsh-hdd-visual`（Client 半边）
> 结论版本：`0.1.0`（2026-10-28）

## 一、现象

启动 DSH 时开屏动画一播放，**整个窗口变成纯白**：

- 侧栏、输入框、标题栏都看不见；
- **声音正常**（问候语照常播放）；
- 鼠标能动，但点什么都没有反馈；
- 白屏持续到开屏结束才恢复；如果开屏实例被中途替换（热重载），白屏会一直持续到重启应用；
- **只放 `boot.png`（不放开屏视频）时一切正常**，一旦放 `boot.mp4` 就白。

## 二、先排除的假象（都验证过，都不是原因）

| 怀疑对象 | 实测结果 |
|---|---|
| 视频素材本身是白的 | 抽帧看过：H.264 8bit、1920×1080，深蓝 HDD 动画，颜色正常 |
| DOM 层是白的 / CSS 没生效 | 日志里 `canvas-sample` 的 computed style 为 `background: rgb(5,8,14)`、`opacity: 1`、`z-index: 2147483000`，画布尺寸正确 |
| 解码失败 | `video.readyState = 4`、`videoWidth/Height = 1920×1080`、`currentTime` 正常推进、`ended` 正常触发 |
| 时间轴卡死 | `splash-start → video-start → video-end → splash-end` 每次都完整走完 |
| 渲染进程崩溃 | 崩溃就不会有 `splash-end`；日志显示整条时间轴都在跑 |
| 画布拿不到画面 | `canvas-sample` 取到过 `rgb(23,50,71)`（深蓝），说明 `drawImage` 真的把视频帧画进了 canvas |
| 点不动 = 页面死了 | 页面一直活着（JS、音频、定时器都正常），只是**画面被整窗盖住** |

## 三、探针矩阵（关键证据）

用热重载注入一个问答式探针，一段一段单独测（每段结束由用户点「白屏 / 正常显示」，答案写进
`~/.dsh/hdd-visual.log` 的 `probe2-answer` 事件）：

| 阶段 | 内容 | 结果 |
|---|---|---|
| P1 | 纯深色全屏遮罩，无视频、无 canvas | **正常** |
| P2 | 视频在播（元素**不进 DOM**），**无 canvas** | **白屏** |
| P3 | 只有 canvas 画渐变，无视频 | **正常** |
| P4 | 视频在播（不进 DOM）+ canvas 每帧 `drawImage` | **正常** |
| P5 | 真正的开屏时间轴（视频 2×2 进 DOM + canvas + 淡入层 + 发光滤镜） | **白屏** |

对比 P4 / P5 的差异只有三处：开屏层的 `opacity` 淡入动画、徽记的 `filter: drop-shadow`、
以及视频元素是否进入 DOM。

## 四、结论

**这不是素材、解码或时间轴的问题，而是这一版 Electron/Chromium 在这台机器上的合成（compositing）
表现问题。** 有两条独立的触发条件，任意一条成立，整窗就会被一张白色平面盖住：

1. **播放中的 `<video>` 只要在文档里拥有一个合成四边形（compositing quad），哪怕它只有 2×2 像素、
   `opacity: 0.01`**，它的帧就会被提升成一张**窗口大小**的白色平面。视频确实在解码、声音也在放，
   但画面永远不出现——这就是"有声音没画面"的来源。
2. **一个带 `opacity` 动画的全屏层，内部包含一个由视频帧绘制出来的 canvas**，同样会整层失效成白。
   P4（同样的 canvas，但没有淡入层）正常，P5（加了淡入层）白屏，把差异锁定在这里。

之前那版"把 video 缩成 2×2 并隐藏 + 画到 canvas"的绕法只解决了第 1 条的"视觉面积"，但只要元素仍在
文档里、仍在播放，白平面照样出现；再叠加第 2 条的淡入层，就完全没救。

## 五、修法（已合入 `client.js`）

1. **视频元素永不进入 DOM**：只 `createElement('video')` + `play()`，帧靠 `drawImage` 取到 canvas；
2. **开屏层不再做 `opacity` 淡入/淡出**（`[data-hdd-splash]` 上不再有 `opacity` 与 transition，
   开屏硬切进出）；
3. **开屏内部不再用 `filter`**（徽记的蓝色外发光 `drop-shadow` 移除）。

对应位置：

- `CSS` 常量里的 `[data-hdd-splash]`（无 opacity 动画）与 `[data-hdd-holder]`（无 filter）；
- `mountSplash()` 的视频分支：不再 `root.insertBefore(video, …)`，只 `root.appendChild(canvas)`。

### 代价

- 开屏没有淡入淡出，是硬切；
- 徽记没有外发光。

两处都是纯装饰。若以后想加回来：

- 淡入：**不要动含 canvas 的那一层**，改成在 canvas 之上叠一个纯色 `div` 做 opacity 过渡；
- 发光：不要用 `filter`，改用一层预先画好的径向渐变背景（或 SVG 的 blur 副本）。

改完必须实机验证（见下）。

## 六、以后怎么快速验证

```powershell
# 1. 改完 client.js 后，DSH 会热重载客户端模块（没有重启应用也能生效）
# 2. 看时间轴与自检数据
Get-Content "$env:USERPROFILE\.dsh\hdd-visual.log" -Tail 40
```

日志里的关键事件：

| 事件 | 含义 |
|---|---|
| `apply` | 客户端模块被应用（热重载也会触发） |
| `splash-start` / `splash-end` | 开屏时间轴的起止 |
| `assets` | `/hdd/info` 返回的素材清单 |
| `video-start` / `video-state` / `video-end` | 解码与播放状态 |
| `canvas-sample` | 画布首帧取样（RGB + computed style） |

**注意**：模块热重载**不会**重放开屏（`__hddVisualApplied` 会拦截，日志记 `splash-skip`）。
要重新看开屏，必须重启应用，或临时把拦截去掉（本次排查就是这么做的）。

> 顺带一个坑：热重载后旧模块的 `setTimeout` 仍然会触发。排查过程中曾经因为残留定时器，
> 在没有任何改动的情况下"自己"重放了一次开屏，很容易误判。改 `mountSplash` 相关逻辑时
> 务必确认没有遗留定时器。

## 七、复现清单（回归测试用）

1. 素材目录里放 `boot.mp4`（用户自备）+ 一对问候语音；
2. 完全退出 DSH 再启动；
3. 期望：深色开屏 → 动画从第一帧播放到结束 → 徽记出现并飞入侧栏 → 进入界面；
4. 全程**不应出现整窗纯白**；侧栏与输入框不应被吞掉点击。

## 八、时间轴校正（同日追加）

实机观看后确认两处与原版不一致，已改：

1. **动画在 12.9 秒处截断**，不再播到 14.5 秒。
   原版也是播到 12.9 秒（"白屏结束、黑屏开始"之前，`blackdetect` 量得），
   我们这支片子在 13 秒后是全黑，继续播只是让徽记晚 1.6 秒出现。
   实现：`TIMING.videoEndS = 12.9`，`timeupdate` 里到点 `pause()` 并结束等待（`video-end` 的 reason 为 `cut`）。

2. **徽记改为「从小浮现」而不是「0.86 → 1 → 0.86 → 飞走」。**
   原来那版在放大到位后又缩回收拢尺寸，看起来像来回弹跳；
   现在 `[data-hdd-holder]` 初始 `scale(0.42)`，到 `data-on="true"` 时放大到 1（620ms），
   之后再收拢到 0.86（430ms）飞向侧栏（1400ms）——就是原版"浮现 → 收拢 → 滑行"的节奏。

素材方面：原包里的 `boot-field.png`（用户画的高亮背景）仍在，原版会在动画之后淡入它、
并把徽记放在图片高亮处。当前实现用动画的最后一帧黑屏代替，观感更连贯；若想回到原版做法，
把该图放进素材目录并在 `mountSplash` 的截断分支里挂一层背景即可。
