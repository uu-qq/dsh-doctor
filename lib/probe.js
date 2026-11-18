/**
 * probe.js — 分层探测：从下往上一层层确认，坏在哪一层就停在哪一层。
 *
 *   0 config  base URL 形态（/v1/v1 重复、协议、主机名）
 *   1 dns     域名解析
 *   2 connect TCP + TLS 握手（计时）
 *   3 auth    带密钥请求 /models，看上游认不认（401/404/200）
 *   4 generate 最小生成请求（max_tokens=1），看上游出不出字、排不排队
 *
 * 每一步返回 { step, ok, ms, detail }；第一个失败步经 classify.js 给出判定。
 * 密钥只从指定环境变量读取，只用于 Authorization 头，绝不出现在结果里。
 */

import { lookup } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'
import { classifyFailure } from './classify.js'

const now = () => performance.now()

function fail(step, ms, detail, signals) {
  return { step, ok: false, ms: Math.round(ms), detail, verdict: classifyFailure(signals) }
}

async function stepDns(host) {
  const t0 = now()
  try {
    const { address } = await lookup(host, { family: 4 })
    return { step: 'dns', ok: true, ms: Math.round(now() - t0), detail: `${host} → ${address}` }
  } catch (error) {
    return fail('dns', now() - t0, `DNS 解析失败：${error.code ?? error.message}`, {
      phase: 'dns',
      code: error.code,
      message: error.message,
    })
  }
}

function stepConnect(host, port, timeoutMs) {
  const t0 = now()
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port, servername: host, timeout: timeoutMs })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.once('secureConnect', () =>
      done({ step: 'connect', ok: true, ms: Math.round(now() - t0), detail: `TLS 握手完成（${host}:${port}）` }),
    )
    socket.once('timeout', () =>
      done(
        fail('connect', now() - t0, '连接超时', {
          phase: 'connect',
          code: 'ETIMEDOUT',
          message: 'connect timeout',
        }),
      ),
    )
    socket.once('error', (error) => {
      const isTls = /CERT|TLS|SSL|VERIFY/i.test(`${error.code ?? ''} ${error.message}`)
      done(
        fail('connect', now() - t0, `连接失败：${error.code ?? error.message}`, {
          phase: isTls ? 'tls' : 'connect',
          code: error.code,
          message: error.message,
        }),
      )
    })
  })
}

async function readSnippet(response) {
  try {
    const body = await response.text()
    return body.slice(0, 300)
  } catch {
    return ''
  }
}

function parseUpstreamError(status, body) {
  let code
  let message
  try {
    const parsed = JSON.parse(body)
    code = parsed?.error?.code ?? parsed?.code
    message = parsed?.error?.message ?? parsed?.message
  } catch {
    message = body
  }
  return { status, code, message }
}

async function stepAuth(base, apiKey, timeoutMs) {
  const t0 = now()
  const url = `${base}/models`
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ms = Math.round(now() - t0)
    if (response.ok) {
      return { step: 'auth', ok: true, ms, detail: `GET /models 返回 ${response.status}：密钥有效、路径正确` }
    }
    const body = await readSnippet(response)
    return fail('auth', ms, `GET /models 返回 ${response.status}：${body.slice(0, 160)}`, {
      ...parseUpstreamError(response.status, body),
      url,
    })
  } catch (error) {
    return fail('auth', now() - t0, `请求 /models 时网络出错：${error.cause?.code ?? error.message}`, {
      phase: 'request',
      code: error.cause?.code ?? error.name,
      message: error.cause?.message ?? error.message,
      url,
    })
  }
}

async function stepGenerate(base, apiKey, model, timeoutMs) {
  const t0 = now()
  const url = `${base}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ms = Math.round(now() - t0)
    if (response.ok) {
      await response.text().catch(() => '')
      const slow = ms > 20_000
      return {
        step: 'generate',
        ok: true,
        ms,
        detail: slow
          ? `生成成功但耗时 ${(ms / 1000).toFixed(1)}s：上游在排队`
          : `生成成功，耗时 ${(ms / 1000).toFixed(1)}s`,
        ...(slow
          ? { verdict: classifyFailure({ firstTokenMs: ms }) }
          : {}),
      }
    }
    const body = await readSnippet(response)
    return fail('generate', ms, `生成请求返回 ${response.status}：${body.slice(0, 160)}`, {
      ...parseUpstreamError(response.status, body),
      url,
    })
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError'
    if (timedOut) {
      return fail('generate', now() - t0, `${Math.round(timeoutMs / 1000)}s 内上游没有给出任何回答`, {
        phase: 'request',
        code: 'GENERATE_TIMEOUT',
        message: 'upstream did not respond in time',
        status: 504,
      })
    }
    return fail('generate', now() - t0, `生成请求网络出错：${error.cause?.code ?? error.message}`, {
      phase: 'request',
      code: error.cause?.code ?? error.name,
      message: error.cause?.message ?? error.message,
      url,
    })
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl   如 https://developer.amd.com.cn/radeon/api/v1
 * @param {string} [options.model]   提供时才做 generate 探测
 * @param {string} [options.apiKey]  只用于 Authorization 头，不进入返回值
 * @param {number} [options.timeoutMs]
 */
export async function runProbes({ baseUrl, model, apiKey, timeoutMs = 20_000 }) {
  const steps = []

  // 0) 配置形态
  let parsed
  try {
    parsed = new URL(baseUrl)
    if (!/^https?:$/.test(parsed.protocol)) throw new Error(`协议不对：${parsed.protocol}`)
  } catch (error) {
    const v = classifyFailure({ phase: 'config', message: `base URL 不合法：${error.message}` })
    return { steps, verdict: v, healthy: false }
  }
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v1\/v1(\/|$)/.test(base)) {
    const v = classifyFailure({ url: base })
    steps.push({ step: 'config', ok: false, ms: 0, detail: 'base URL 里有 /v1/v1' })
    return { steps, verdict: v, healthy: false }
  }
  steps.push({ step: 'config', ok: true, ms: 0, detail: `base URL 形态正常：${base}` })

  const host = parsed.hostname
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80

  // 1) DNS
  const dns = await stepDns(host)
  steps.push(dns)
  if (!dns.ok) return { steps, verdict: dns.verdict, healthy: false }

  // 2) TCP + TLS（http 端点跳过 TLS 细节，只测可达性时仍走 tls 会失败，故 http 时跳过）
  if (parsed.protocol === 'https:') {
    const conn = await stepConnect(host, port, Math.min(timeoutMs, 10_000))
    steps.push(conn)
    if (!conn.ok) return { steps, verdict: conn.verdict, healthy: false }
  }

  // 3) 认证 + 路径
  const auth = await stepAuth(base, apiKey, timeoutMs)
  steps.push(auth)
  if (!auth.ok) return { steps, verdict: auth.verdict, healthy: false }

  // 4) 生成（可选）
  if (model) {
    const gen = await stepGenerate(base, apiKey, model, Math.max(timeoutMs, 45_000))
    steps.push(gen)
    if (!gen.ok) return { steps, verdict: gen.verdict, healthy: false }
    if (gen.verdict) return { steps, verdict: gen.verdict, healthy: true }
  }

  return {
    steps,
    healthy: true,
    verdict: {
      category: 'none',
      categoryLabel: '未发现问题',
      summary: '探测全部通过：网络通、密钥认、路径对，上游也能出字。',
      suggestion: '如果实际对话仍失败，把当时的错误原文交给 diagnose_failure 分类，可能是间歇性上游排队。',
    },
  }
}
