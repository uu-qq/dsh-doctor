import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { runProbes } from '../lib/probe.js'

const servers = []
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.()
    s.close()
  }
})

function startServer(handler) {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

test('探测：/models 假 200（无可用渠道）→ 判中转站层，不报健康', async () => {
  const port = await startServer((req, res) => {
    if (req.url.endsWith('/models')) return json(res, 200, { error: { message: '无可用渠道' } })
    return json(res, 404, { error: { message: 'not found' } })
  })
  const report = await runProbes({ baseUrl: `http://127.0.0.1:${port}/v1` })
  assert.equal(report.healthy, false)
  assert.equal(report.verdict.category, 'relay')
  assert.equal(report.verdict.rule, 'relay-no-channel')
})

test('探测：生成步假 200（分组负载饱和）→ 判中转站层', async () => {
  const port = await startServer((req, res) => {
    if (req.url.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: 'm' }] })
    if (req.url.endsWith('/chat/completions')) {
      return json(res, 200, { error: { message: '当前分组上游负载已饱和，请稍后再试' } })
    }
    return json(res, 404, { error: { message: 'not found' } })
  })
  const report = await runProbes({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' })
  assert.equal(report.healthy, false)
  assert.equal(report.verdict.category, 'relay')
  assert.equal(report.verdict.rule, 'relay-channel-saturated')
})

test('探测：正常端点仍报健康（假 200 检查不误伤）', async () => {
  const port = await startServer((req, res) => {
    if (req.url.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: 'm' }] })
    if (req.url.endsWith('/chat/completions')) {
      return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] })
    }
    return json(res, 404, { error: { message: 'not found' } })
  })
  const report = await runProbes({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' })
  assert.equal(report.healthy, true)
})
