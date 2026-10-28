# 探测结论：静态音频在 DSH 桌面端的可行性

> 环境：`@deepseek-ai/dsh-desktop` 0.2.1-rc.3 · Electron 44.7.0 · Chrome 152.0.7977.130 · Windows x64
> 探测包：`lab/dsh-lab-audio`（一次性探针，验证完即卸载）
> 原始日志：`~/.dsh/hdd-lab-audio.run1.log`（带手势）与 `~/.dsh/hdd-lab-audio.log`（冷启动）

## 一、要回答的三个问题

1. bundle 能否用 `ctx.webServer` 流式提供**静态音频**（`.m4a`，即包资源白名单之外的扩展名）？
2. 开屏那一刻**没有用户手势**时，`<audio>` 能否自动播放？
3. `AudioContext` 在无手势时是什么状态（决定要不要做"静音解锁"）？

## 二、实测结果

冷启动（`navigator.userActivation.hasBeenActive === false`，`visibilityState === 'visible'`）：

| 探测 | 结果 |
|---|---|
| `fetch('/lab-audio/file', {range:'bytes=0-99'})` | `206`，100 字节，`content-range: bytes 0-99/8727`，`content-type: audio/mp4` |
| `fetch('/lab-audio/file')` | `200`，8727 字节 |
| `<audio src="/lab-audio/file">.play()` | **resolve**，500ms 后 `currentTime = 0.47s`（播放头在走 = 真的有输出） |
| `new AudioContext().state`（模块体阶段） | `running`（无需 resume） |

对照：页面已被交互过的同一次会话里（`hasBeenActive === true`）同样全部通过，`AudioContext` 亦为 `running`。

## 三、结论

1. **静态音频走 `ctx.webServer.register({kind:'exact', path, handler})` + 手写 Range 是可行且正确的**。
   包资源路由（`./assets/*` → `require.asset()`）只支持 `.svg/.png/.webp/.jpg/.jpeg`
   （见 `packages/client/modules/src/assets.ts` 的 `PACKAGE_ASSET_MEDIA_TYPES`），**不能**用于音频。
2. **开屏可以直接出声**：Electron 44 默认放行自动播放，`<audio>` 与 `AudioContext` 都无需用户手势。
   因此 **不需要** Fairy 教程里那套"首次点击播静音解锁"的补丁。
3. 仍应保留降级：若 `play()` 返回 rejected（例如用户静音了系统音量、或未来升级改变策略），
   只记日志、不抛错、不阻塞开屏。

## 四、顺带确认的工程事实

- 安装走官方路径即可：`dsh plugin --profile desktop add <本地目录>`
  → 写入 `dependencies`（`link:`）+ `dsh.profile.bundles`，**不改动** profile 自己的 `cordis.patch.yml`。
- Host 半边在 `add` 完成后数秒内即被 `apply`（无需重启应用）；Client 半边改动会自动重载。
- 桌面版硬编码 `profiles/desktop`（`lib/main.js` 的 `resolveDesktopPaths`，无 `DSH_PROFILE` 覆盖），
  所以要在真实 Electron 里验证，只能落在 `desktop` profile。

## 五、对正式实现的约束

- 音频/视频素材由用户导入（版权原因），因此需要：
  1. 一个设置项 + 导入流程，把用户素材放到插件可读的位置；
  2. 素材缺失时的降级路径（无开屏视频 → 直接用静态背景；无问候语音 → 静默开屏）；
  3. 素材路径不得写死在本机绝对路径里（应落在 `$DSH_HOME` 下或由设置项给出）。
- 开屏问候按本地时间分档（6 档 × N 条），播放时机沿用"提前 `fetch` + `decodeAudioData`，
  到点 `source.start()`"的做法；现在是本地文件，延迟更低。

## 六、第一次实机运行踩到的坑：看不见的遮罩把整个窗口冻住

**现象**：开屏正常播完、徽记也落到侧栏，但之后整个 DSH 窗口点不动了——
右键托盘菜单还能退出，点击界面里的按钮没有任何反应。

**原因**：开屏层是 `position: fixed; inset: 0; z-index: 2147483000`。淡出把它变成
`opacity: 0`，但它**仍在 DOM 里**，也没有 `pointer-events: none`，于是它继续接收
所有点击——用户看到的是"应用卡死"，实际是"所有点击都打在了一层看不见的玻璃上"。

**修法（三条一起上，缺一不可）**：

1. 开屏层恒为 `pointer-events: none`——装饰层永远不参与命中测试；
2. 时间轴结束后**卸载**组件（`alive` 状态置 false 并 `return null`），而不是停在透明态；
3. 加一个绝对兜底定时器（12 秒），无论时间轴走到哪一步都强制移除。

**为什么自检没发现**：第一版 `smoke.mjs` 的 `useState` 是空实现（setter 不生效），
所以"卸载"从未被观察到。现在自检里实现了迷你 hooks（状态盒 + 副作用只跑一次），
并在时间轴跑完后**再渲染一次**，断言返回 `null`；同时断言 `<html>` 上的标记已移除。

> 教训：**淡出不等于消失**。任何 `position: fixed` 的装饰层都必须显式回答两个问题：
> 它什么时候从 DOM 里消失，以及在它存在期间是否吃点击。
