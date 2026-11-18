import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure } from '../lib/classify.js'

// —— 上游阻塞 ——

test('AMD 429 并发满 → 上游阻塞', () => {
  const v = classifyFailure({
    status: 429,
    code: 'model_concurrency_rate_limit_exceeded',
    message: 'At capacity',
  })
  assert.equal(v.category, 'upstream')
})

test('503 → 上游阻塞', () => {
  const v = classifyFailure({ status: 503, message: 'Service Unavailable' })
  assert.equal(v.category, 'upstream')
})

test('成功但首 token 31 秒 → 上游排队', () => {
  const v = classifyFailure({ firstTokenMs: 31_000 })
  assert.equal(v.category, 'upstream')
  assert.equal(v.rule, 'slow-first-token')
})

// —— API 调用 ——

test('401 → API 调用（密钥）', () => {
  const v = classifyFailure({ status: 401, code: 'invalid_api_key', message: 'Unauthorized' })
  assert.equal(v.category, 'api')
})

test('model_not_found → API 调用（模型名）', () => {
  const v = classifyFailure({
    status: 404,
    code: 'model_not_found',
    message: 'The model DeepSeek-V4.1-Flash-1017 does not exist',
  })
  assert.equal(v.category, 'api')
  assert.equal(v.rule, 'model-not-found')
})

test('纯路径 404 → API 调用（路径）', () => {
  const v = classifyFailure({ status: 404, message: 'Not Found' })
  assert.equal(v.category, 'api')
  assert.equal(v.rule, 'path-not-found')
})

test('429 但因余额 → API 调用（额度）', () => {
  const v = classifyFailure({ status: 429, code: 'insufficient_quota', message: '余额不足' })
  assert.equal(v.category, 'api')
  assert.equal(v.rule, 'quota-or-balance')
})

test('上下文超长 → API 调用', () => {
  const v = classifyFailure({ status: 400, message: 'context_length_exceeded: maximum context length is 128000' })
  assert.equal(v.category, 'api')
})

// —— 工作环境 ——

test('/v1/v1 → 工作环境（配置）', () => {
  const v = classifyFailure({
    status: 404,
    message: 'Not Found',
    url: 'https://developer.amd.com.cn/radeon/api/v1/v1/messages',
  })
  assert.equal(v.category, 'environment')
  assert.equal(v.rule, 'double-v1-in-url')
})

test('config 阶段失败 → 工作环境', () => {
  const v = classifyFailure({ phase: 'config', message: 'base URL 不合法' })
  assert.equal(v.category, 'environment')
})

// —— 网络环境 ——

test('ENOTFOUND → 网络环境（DNS）', () => {
  const v = classifyFailure({ phase: 'dns', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND example.com' })
  assert.equal(v.category, 'network')
})

test('ECONNREFUSED → 网络环境', () => {
  const v = classifyFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:7890' })
  assert.equal(v.category, 'network')
})

test('连接超时 → 网络环境', () => {
  const v = classifyFailure({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' })
  assert.equal(v.category, 'network')
})

test('证书错误 → 网络环境（TLS）', () => {
  const v = classifyFailure({ phase: 'tls', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' })
  assert.equal(v.category, 'network')
})

test('流式中途 ECONNRESET → 网络环境', () => {
  const v = classifyFailure({ phase: 'stream', code: 'ECONNRESET', message: 'socket hang up' })
  assert.equal(v.category, 'network')
})

test('笼统 fetch failed → 网络环境（需探测）', () => {
  const v = classifyFailure({ message: 'fetch failed' })
  assert.equal(v.category, 'network')
})

// —— 兜底 ——

test('无信号 → unknown', () => {
  const v = classifyFailure({ message: 'something went wrong' })
  assert.equal(v.category, 'unknown')
})
