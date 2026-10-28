# 语音生成报告（Edge-TTS · 晓晓 · rate +8%）

> 生成命令：`node tools/render-voice.mjs --backend edge --rate "+8%"`
> 输出：`%USERPROFILE%\.dsh\hdd-fairy\assets\`，m4a 48k 单声道 48kbps

| 文件 | 字数 | 预估 | 实测 | 偏差 | 大小 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `greeting/dawn-1.m4a` | 20 | 4.7s | 5.19s | +10% | 29 KB |
| `greeting/dawn-2.m4a` | 20 | 4.7s | 5.14s | +9% | 29 KB |
| `greeting/dawn-3.m4a` | 20 | 4.7s | 5.14s | +9% | 29 KB |
| `greeting/morning-1.m4a` | 20 | 4.7s | 5.48s | +17% | 31 KB |
| `greeting/morning-2.m4a` | 21 | 4.9s | 5.36s | +9% | 30 KB |
| `greeting/morning-3.m4a` | 19 | 4.5s | 4.86s | +8% | 27 KB |
| `greeting/noon-1.m4a` | 20 | 4.7s | 5.34s | +14% | 30 KB |
| `greeting/noon-2.m4a` | 22 | 5.1s | 5.17s | +1% | 29 KB |
| `greeting/noon-3.m4a` | 18 | 4.3s | 4.38s | +2% | 24 KB |
| `greeting/afternoon-1.m4a` | 21 | 4.9s | 5.14s | +5% | 29 KB |
| `greeting/afternoon-2.m4a` | 21 | 4.9s | 5.0s | +2% | 29 KB |
| `greeting/afternoon-3.m4a` | 20 | 4.7s | 4.42s | -6% | 25 KB |
| `greeting/evening-1.m4a` | 19 | 4.5s | 4.78s | +6% | 27 KB |
| `greeting/evening-2.m4a` | 18 | 4.3s | 4.28s | -0% | 23 KB |
| `greeting/evening-3.m4a` | 22 | 5.1s | 5.72s | +12% | 32 KB |
| `greeting/night-1.m4a` | 19 | 4.5s | 4.93s | +10% | 27 KB |
| `greeting/night-2.m4a` | 19 | 4.5s | 4.76s | +6% | 27 KB |
| `greeting/night-3.m4a` | 21 | 4.9s | 5.14s | +5% | 29 KB |
| `cue/thinking.m4a` | 3 | 1.0s | 0.68s | -32% | 4 KB |
| `cue/done.m4a` | 4 | 1.2s | 0.83s | -31% | 5 KB |
| `cue/failed.m4a` | 7 | 1.9s | 1.72s | -9% | 11 KB |

- 问候 18 条：实测 4.28–5.72 秒，平均 5.01 秒（估算合计 84.6s → 实测 90.2s，整体慢约 +7%）
- 提示音：thinking 0.68s / done 0.83s / failed 1.72s（已裁掉 Edge 前后静音）
- 结论：Edge 默认语速约 3.8 字/秒，比 4.6 字/秒的估算慢 ~18%；+8% 后回到约 4.1 字/秒，最长一条 5.72 秒仍在 6 秒预算内。
- 提示音裁剪：未裁剪时「推演中。」为 2.07 秒（前后都是静音）；`silenceremove` 后用 0.05 秒尾音，降到 0.68 秒。


## 开屏总时长（按实测推算）

| 阶段 | 时长 | 累计 |
| --- | ---: | ---: |
| 问候起播点 | 0.70s | 0.70s |
| 播放问候（18 条平均） | 5.01s | 5.71s |
| 问候结束后停留 `holdAfter` | 0.90s | 6.61s |
| 徽记收拢 | 0.43s | 7.04s |
| 飞向侧栏 | 1.40s | 8.44s |
| 开屏层淡出 | 0.52s | 8.96s |

约 **9.0 秒**。原定目标是 6 秒以内，现在超了 3 秒。三个压缩选项：

1. `greetingAt` 0.70 → 0.50、`holdAfter` 0.90 → 0.30：约 **7.9 秒**（不动音频）；
2. 再用 `--rate "+15%"` 重生成（问候均长约 4.6 秒）+ 选项 1：约 **7.4 秒**；
3. 保持 9.0 秒（若您希望开屏更有仪式感）。
