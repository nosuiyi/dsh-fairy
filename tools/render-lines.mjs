#!/usr/bin/env node
/**
 * Render the line table as Markdown from `docs/voice-lines.json`.
 *
 *   node tools/render-lines.mjs docs/voice-lines.json docs/voice-lines.md
 *
 * Keeping the JSON as the source of truth means a table edited in Gemini's answer
 * can be validated by `check-lines.mjs` and rendered here, with counts and
 * durations always agreeing with the text.
 */
import { readFile, writeFile } from 'node:fs/promises'

const SILENT = new Set([...'，。、；：！？—…「」『』（）《》""‘’ \n\t'])
const clean = (text) => text.split('‖').join('')
const printed = (text) => [...clean(text)].filter((character) => !SILENT.has(character)).length
const estimate = (text) => Math.max(0.9, Math.round((printed(text) / 4.6 + 0.35) * 10) / 10)

const BUCKETS = [
  ['dawn', '深夜', '00:00–04:59'],
  ['morning', '早上', '05:00–10:59'],
  ['noon', '中午', '11:00–13:59'],
  ['afternoon', '下午', '14:00–17:59'],
  ['evening', '晚上', '18:00–21:59'],
  ['night', '深夜', '22:00–23:59'],
]

const input = process.argv[2] ?? 'docs/voice-lines.json'
const output = process.argv[3] ?? 'docs/voice-lines.md'
const table = JSON.parse(await readFile(input, 'utf8'))

const lines = []
lines.push('# 开屏问候与提示音台词表', '')
lines.push('> 用途：静态语音资产。每条都是**整句一次性合成**，不做运行时合成。', '')
lines.push('> 生成后按本表最左列命名，放进 `%USERPROFILE%\\.dsh\\hdd-fairy\\assets\\`。', '')
lines.push('## 写作硬约束（为什么这些台词长这样）', '')
lines.push('1. **不能断言会过期的信息**：音频是固定的，写「今天有三项日程」第二天就成了假话。因此全部只陈述**恒定成立的系统状态**（自检、就绪、待命、检测、提议）。')
lines.push('2. **字数 12–28**（提示音 2–10）：低于 12 字显得敷衍，超过 28 字开屏会被拖长（目标总开屏 ≤ 6 秒）。')
lines.push('3. **至多一个数字，且带小数**：数字癖是 Fairy 的标志，但音频里连续多个数字会像念经。')
lines.push('4. **至多一个协议标签**（提示／警告／推测／检测到／查询完成／分析显示／提议／收到／很抱歉）：标签是开场词，不是句句都用。')
lines.push('5. **不用 emoji、不用括号动作、不用省略号拖长**：TTS 会把它们读出来或产生怪停顿。')
lines.push('6. **不用生僻字与多音字**，避免读音翻车。', '')
lines.push('## 开屏问候（6 档 × 3 条）', '')
lines.push('| 文件 | 台词 | 字数 | 预估时长* | 结构 |')
lines.push('| --- | --- | ---: | ---: | --- |')

let total = 0
let longest = { file: '', seconds: 0 }
for (const [id, label, span] of BUCKETS) {
  lines.push(`| | **${label} ${span}** | | | |`)
  for (const entry of table.greeting.filter((item) => item.file.startsWith(`greeting/${id}-`))) {
    const count = printed(entry.text)
    const seconds = estimate(entry.text)
    total += seconds
    if (seconds > longest.seconds) longest = { file: entry.file, seconds }
    lines.push(`| \`${entry.file}\` | ${entry.text} | ${count} | ${seconds}s | ${entry.note ?? ''} |`)
  }
}

lines.push('')
lines.push('> \\* 时长按 **4.6 字/秒** 保守估算（含句尾余量）；实际 TTS 多为 5–6 字/秒，可据此下调。')
lines.push('>')
lines.push(`> 18 条合计约 **${total.toFixed(1)} 秒** 素材；最长一条 \`${longest.file}\` ${longest.seconds.toFixed(1)} 秒。每条 3–6 秒为佳。`)
lines.push('')
lines.push('## 提示音（3 条）', '')
lines.push('| 文件 | 台词 | 字数 | 预估时长 | 说明 |')
lines.push('| --- | --- | ---: | ---: | --- |')
for (const entry of table.cue ?? []) {
  lines.push(`| \`${entry.file}\` | ${entry.text} | ${printed(entry.text)} | ${estimate(entry.text)}s | ${entry.note ?? ''} |`)
}
lines.push('')
lines.push('## 断句标记 `‖`', '')
lines.push('表里的 `‖` 不是标点，是**强制断句**：生成脚本会在该处把台词切成两段分别合成，')
lines.push('剥掉段尾标点（否则模型按连读把末字收急），再用 0.30 秒静音拼接。')
lines.push('实测「主人，」的逗号与句号都不产生停顿（0 秒），只有这种分段拼接能稳定得到停顿。')
lines.push('渲染本表时会自动隐藏该符号；想在别处加停顿，在原处插入 `‖` 即可。')
lines.push('')
lines.push('## 生成参数', '')
lines.push('- 单声道、48 kHz、AAC 48 kbps（`.m4a`）；也接受 `.mp3` `.ogg` `.opus` `.wav`。')
lines.push('- 每条**整句一次合成**：按逗号切段会改变音色（实测同一句整句 5.02 秒、逐逗号 5.48 秒，对数谱距离 1.98）。')
lines.push('- 同一档内三条请用**同一条参考音频、同一组参数**，否则三条之间音色会不一致。')
lines.push('- 句尾留 150–250 ms 静音，开屏播放时不会被硬切断。')
lines.push('')
lines.push('## 播放时序（供写台词时参考）', '')
lines.push('开屏在背景图淡入后约 0.7 秒开始播问候；问候结束再等 0.9 秒，徽记收拢飞向侧栏。')
lines.push('所以 4 秒的问候 ≈ 总开屏 6 秒，5 秒以上会明显变拖。')

await writeFile(output, lines.join('\n') + '\n', 'utf8')
console.log(`rendered ${output} from ${input}`)
