import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure } from '../lib/classify.js'
import { detectRelay } from '../lib/relay.js'

test('无可用渠道 → 中转站层（话术独有，无需指纹）', () => {
  const v = classifyFailure({ status: 503, message: '无可用渠道' })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-no-channel')
})

test('524 + 已知中转站 → 中转站层 Cloudflare 回源超时', () => {
  const v = classifyFailure({ status: 524, message: 'A timeout occurred', isRelay: true })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-cloudflare')
})

test('522 即使没指纹也按中转站层（状态码段本身就是 CF 源站错误）', () => {
  const v = classifyFailure({ status: 522, message: 'Connection timed out' })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-cloudflare')
})

test('错误响应是 HTML 网页 → 中转站层拦截页', () => {
  const v = classifyFailure({ status: 403, message: '<html>Attention Required</html>', bodyIsHtml: true })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-html-error')
})

test('已知中转站 + 余额不足 → 中转站站内余额', () => {
  const v = classifyFailure({ status: 403, message: '余额不足，请充值', isRelay: true })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-account-balance')
})

test('未确认中转站 + 余额不足 → 仍走通用 API 额度（不误判）', () => {
  const v = classifyFailure({ status: 429, message: '余额不足' })
  assert.equal(v.category, 'api')
})

test('上游渠道额度耗尽的话术 → 中转站层', () => {
  const v = classifyFailure({ status: 403, message: '上游渠道额度不足' })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-upstream-exhausted')
})

test('分组无权 → 中转站层', () => {
  const v = classifyFailure({ status: 403, message: '该分组无权使用此模型' })
  assert.equal(v.category, 'relay')
  assert.equal(v.rule, 'relay-group')
})

test("relay: 'off' 时中转规则整体禁用", () => {
  const v = classifyFailure({ status: 503, message: '无可用渠道', relay: 'off' })
  assert.equal(v.category, 'upstream')
})

test('detectRelay：New API 版本头 → 确认中转站', () => {
  const d = detectRelay({ headers: { 'x-new-api-version': 'v1.2.3' } })
  assert.equal(d.isRelay, true)
  assert.equal(d.kind, 'new-api')
})

test('detectRelay：Cloudflare + HTML 错误页 → 确认中转站', () => {
  const d = detectRelay({ headers: { server: 'cloudflare' }, bodyText: '<!DOCTYPE html><html>error</html>' })
  assert.equal(d.isRelay, true)
  assert.equal(d.bodyIsHtml, true)
})

test('detectRelay：只有 Cloudflare → 证据不足，不下结论', () => {
  const d = detectRelay({ headers: { server: 'cloudflare' } })
  assert.equal(d.isRelay, false)
  assert.ok(d.evidence.length >= 1)
})
