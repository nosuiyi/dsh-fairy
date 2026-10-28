# 待定事项：徽记的尺寸与"惊艳感"调优

> 状态：**暂不实施**，先记录备查。当前落地版本见文末"当前值"。
> 相关：`packages/dsh-hdd-visual/client.js` 的 `[data-hdd-mark]`、`fairyMarkup()`、`Mark()`

## 一、背景：参考实现的"惊艳感"由什么构成

参考皮肤（`Fairy/给大肥鱼看的安装教程/plugin/client.js`）的矢量徽记由四层叠加：

1. **独占一整行的大舞台**：容器 `flex: 1 1 100%`，舞台 `width: min(224px, 100%)`；
2. **会呼吸的光**：背后一层 `radial-gradient(circle closest-side, …)` 的光晕，3s 脉冲；
3. **涟漪环**：舞台 `::before` 的描边圆 + `box-shadow` 发光，3.4s 从 `scale(1.02)` 扩到 `1.72` 并淡出；
4. **撕裂**：同一份矢量切成 20 条水平切片，每 3.6s 中有约 86ms 由切片替换整图，每条按各自的 `--hdd-shift` 同时横向错位。

外加矢量自身：角框 3s 转 90°，巩膜/虹膜外/虹膜蓝/瞳孔/高光各按负延迟（-47/-94/-188ms）分层缩放"呼吸"。

**结论**：它"大"的一半来自第 1 条（独占整行），另一半来自 2/3/4 同时开启。

## 二、已落地（当前值）

| 项 | 当前值 |
|---|---|
| 展开态尺寸 | `--hdd-mark-size: 60px` |
| 收起（rail）尺寸 | `30px`（本 build 收起来时页脚整排不渲染，用不到，留作保险） |
| 光晕 / 涟漪 / 撕裂 | 展开态**全开**（`data-hdd-mark-full`），rail 态关闭 |
| 环粗细 | `--hdd-mark-ring: 3px`（随尺寸走；参考的 5px 是为 224px 量的） |
| 点击安全 | 整个子树 `pointer-events: none` |
| 展开/收起 | `width 220ms ease-out` |

## 三、可选方案（未实施，按需再谈）

### A. 只调尺寸
一个变量：`[data-hdd-mark] { --hdd-mark-size: … }`。

| 档位 | 观感 | 代价 |
|---|---|---|
| 52px | 收敛一点，页脚更薄 | 眼睛细节略小 |
| 60px（当前） | 折中 | 页脚行高比原始 26px 高约 34px |
| 64–72px | 最接近参考的气场 | 页脚明显变高 |

### B. 盒子 48px + 绘制放大约 1.35–1.4 倍
`transform: scale(1.35)`（`pointer-events: none` 保证不挡点击）。
视觉更抢眼但**布局高度不变**；代价是光晕/涟漪会向上下多溢出一些，可能与下面的头像行视觉上挨得近。
若采用，注意与 `[data-hdd-mark]` 上的 `width` 过渡同时存在时的抖动（必要时把 transform 放到内层 stage）。

### C. 在收起 rail 里也显示 Fairy
收起态页脚整排不渲染；"仍在"的两个单座都已被壳占用：

| 座位 | 后果 |
|---|---|
| `sidebar.brand.mark` | 替换 DeepSeek 品牌标（`shadows-shipped-ui`） |
| `sidebar.toggle.badge` | 替换通知角标（`shadows-shipped-ui`） |

剩余两条路：

- **C1** `sidebar.panellist`（list，加法座位）：需先实机确认 rail 态是否渲染它；且该列表语义是"面板图标"，混入非交互项可能影响 More 菜单判定。
- **C2** 自己用 `position: fixed` 浮在 rail 底部：`pointer-events: none` 保证可点击穿透；缺点是坐标依赖壳的实际内边距，壳改版要跟着调。

### D. 想要真正的"独占整行"
只能接管 `sidebar` 整列（`replaceRisk: shadows-shipped-ui`），会盖掉壳自己的导航与页脚，**不建议**。

## 四、验证清单（任何一档改完都跑一遍）

1. 展开态：徽记尺寸正确、光晕/涟漪/撕裂可见（撕裂每 3.6s 一次，静图抓不到）；
2. 页脚高度可接受，头像行没有被挤变形；
3. 点侧栏的工作区行能立刻切换（徽记子树是 `pointer-events: none`，理论上不可能拦截，仍建议实测）；
4. 开屏：飞行落点仍准确落在 `[data-hdd-mark]` 上（落点用实时矩形计算，尺寸变了会自动适配）；
5. `prefers-reduced-motion` 下：角框/眼睛/光晕/涟漪/撕裂/宽度过渡全部关闭。
