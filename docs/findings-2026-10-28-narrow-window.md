# 排查记录：开屏后期界面变成"中间一条、两边深色、点不动"

> 环境与结论版本同 [`findings-2026-10-28-white-splash.md`](findings-2026-10-28-white-splash.md)
> 涉及文件：`packages/dsh-hdd-visual/client.js`

## 一、现象

开屏动画播完后，出现背景板 + 徽记。**背景板开始淡出的那一刻**：

- DSH 界面只剩下**中间一列**（宽约 460～760px，每次数字都不一样）；
- 高度正常，铺满窗口；
- 两侧是深色（不是纯黑，是 `#05080e`）；
- **点哪里都没有反应**；
- 等徽记飞完、开屏层卸载后，界面"自己"恢复正常。

## 二、排查过程（关键数据）

### 1. 先量，不猜

在开屏里采样 `innerWidth` / `dpr` / `visualViewport.scale` / `html` 的 `zoom` 与宽度 / `body` 与 shell 的矩形：

```
inner:      [1280, 820]     dpr: 1     visualScale: 1     html zoom: 1
html.width: 1280
body:       { w: 461, h: 5093 }      ← 应用容器真的只有 461 宽
sidebar:    0                        ← 被判定为窄屏，侧栏收起
splash:     fixed / 1280×820         ← 开屏层自己是满屏的
```

→ 不是缩放、不是 DPI、不是开屏层压窄，而是**应用容器真的被布局成了窄的**。
而且两次采样分别是 `461` 和 `468`、后来还有 `477`、`757` ——**宽度跟着内容变**，说明 `body` 变成了"收缩到内容宽度"的盒子。

### 2. 分组对照（问答式探针）

| 探针 | 内容 | 结果 |
|---|---|---|
| P1 | 纯深色遮罩（div） | 正常 |
| P2 | 只有视频在播（脱离 DOM） | 白屏（另一条 bug，见白屏记录） |
| P3 | 只有 canvas 渐变 | 正常 |
| P4 | 视频 + canvas（div 承载） | 正常 |
| P5 | **真正的开屏** | 白屏 / 窄屏 |

差异只有一处：真开屏会 **往 `<html>` 上写标记属性**，探针不会。

### 3. 决定性实验

在健康页面里，只做一件事——给 `<html>` 加上那个标记属性，然后量 `body`：

```
before = 1280
setAttribute('data-hdd-splash', 'true')   →  during = 757,  html display = grid
removeAttribute('data-hdd-splash')        →  after  = 1280
```

**一个属性，瞬间把页面压扁；删掉立刻恢复。**

## 三、根因

`client.js` 里的开屏样式是这样写的：

```css
[data-hdd-splash] {
  position: fixed; inset: 0; z-index: 2147483000;
  display: grid; place-items: center;
  background-color: #05080e;
  pointer-events: none;
}
```

而 `mountSplash()` 为了让侧栏徽记在开屏期间隐藏，执行了：

```js
document.documentElement.setAttribute('data-hdd-splash', 'true')
```

**属性选择器是全局的**——它不只匹配那个开屏 `<div>`，也匹配了 `<html>` 自己。于是整个文档根元素变成了：

| 属性 | 后果 |
|---|---|
| `position: fixed` | 文档根不再按正常流布局 |
| `display: grid` + `place-items: center` | `body` 成为被居中的 grid 项，宽度收缩到内容宽（461/468/477/757 就是这么来的） |
| `background-color: #05080e` | 两侧的"深色"就是它 |
| `pointer-events: none` | 整个文档不再接收指针事件 → **点什么都没反应** |

开屏卸载时 `cleanup()` 里 `removeAttribute(SPLASH_ATTR)` 把属性删掉，`<html>` 立刻恢复成 `display: block`，界面就"自己好了"——这就是"徽记动完就恢复"的真相。

### 为什么之前一直没发现

1. 探针用的是**另一个属性名**（`data-hdd-probe-stage`）且挂在 `div` 上，天然绕开了这个坑；
2. 白屏问题（视频叠加层）更抢眼，把"窄屏"当成了白屏的余波；
3. 日志里以前只记了 `html` 的 `computed background/opacity`，没有记 `html` 自己的 `display/position`。

## 四、修法

```css
/* 只匹配开屏那个 div，绝不匹配 <html> */
div[data-hdd-splash] { ... }
```

同时补充一道保险：揭幕前用 `shellIsWhole()` 检查 `body` 是否铺满窗口，1.6 秒内等不到就不揭幕（板子淡到深色、硬切到界面），任何情况下都不把"半成品布局"露给用户。

## 五、教训（写进 README 了）

1. **往 `<html>` 上写标记属性时，样式选择器必须限定元素类型**（`div[data-…]`），或者干脆不要用属性做全局开关；
2. 属性选择器 `[attr]` 的匹配范围是**整棵树**，包括 `html`/`body`；
3. `pointer-events: none` 写在会被 `html` 命中的规则里 = 整个应用失去交互，这种 bug 看起来像"卡死"，其实是布局事故；
4. 排查布局问题时，先量 `innerWidth / dpr / visualViewport / html 的 display+position / body 宽度`，比看截图快得多；
5. 客户端插件可以热重载，**改一行就能在活着的页面里做实验**（本次最终定位就是靠"热重载 + 一个属性开关 + 两次测量"完成的，没有重启）。
