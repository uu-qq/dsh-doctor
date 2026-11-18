/** format.js — 把判定/探测结果排成给人看的中文报告。 */

export function formatVerdict(v) {
if (!v) return ''
const lines = [`结论：${v.categoryLabel}`, `依据：${v.summary}`, `建议：${v.suggestion}`]
return lines.join('\n')
}

export function formatProbeReport(report) {
const lines = ['分层探测：']
for (const s of report.steps) {
lines.push(` ${s.ok? '✓': '✗'} ${s.step}（${s.ms}ms）${s.detail}`)
}
if (report.relay?.isRelay) {
lines.push(` ↳ 识别为中转站${report.relay.kind? `（${report.relay.kind}）`: ''}：${report.relay.evidence.join('；')}`)
}
lines.push('')
lines.push(formatVerdict(report.verdict))
return lines.join('\n')
}

export function formatDiagnosis(result) {
const parts = []
if (result.classification) {
parts.push('')
parts.push(formatVerdict(result.classification))
}
if (result.probe) {
if (parts.length) parts.push('')
parts.push('')
parts.push(formatProbeReport(result.probe))
}
if (!parts.length) parts.push('没有可诊断的内容：请提供 errorText，或配置 baseUrl 后开启 probe。')
return parts.join('\n')
}
