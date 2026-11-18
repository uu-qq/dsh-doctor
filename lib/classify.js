/**
 * classify.js — 把一次失败的模型调用归类到四个方面之一：
 *
 *   api         API 调用问题   —— 密钥、模型名、接口路径、请求参数、账户额度
 *   network     网络环境问题   —— DNS、连接、TLS、代理、连接被重置
 *   environment 工作环境问题   —— 本地配置写错（典型：base URL 多拼了一层 /v1）
 *   upstream    上游阻塞       —— 并发打满 / 容量不足 / 上游 5xx / 首 token 排队过久
 *   relay       中转站层问题   —— 无可用渠道 / Cloudflare 52x / 站内余额 / 分组无权（见 relay.js）
 *
 * 纯函数，无副作用：输入观测到的信号，输出带理由和建议的判定。
 * 信号来源可以是 HTTP 响应（status / code / message），也可以是
 * fetch / net 抛出的错误（code / phase），或分层探测的某一步结果。
 */

import { matchRelayFailure } from './relay.js'

const CATEGORY_LABEL = {
  api: 'API 调用问题',
  network: '网络环境问题',
  environment: '工作环境问题（本地配置）',
  upstream: '上游阻塞',
  relay: '中转站层问题',
  unknown: '暂时无法归类',
}

function verdict(category, rule, summary, suggestion, extra = {}) {
  return {
    category,
    categoryLabel: CATEGORY_LABEL[category],
    rule,
    summary,
    suggestion,
    ...extra,
  }
}

function text(signals) {
  return [signals.code, signals.message, signals.causeCode, signals.causeMessage]
    .filter(Boolean)
    .join(' ')
}

/**
 * @param {object} signals
 * @param {number} [signals.status]      HTTP 状态码
 * @param {string} [signals.code]        上游错误码，如 model_not_found
 * @param {string} [signals.message]     错误信息原文
 * @param {string} [signals.url]         出错的请求 URL
 * @param {string} [signals.phase]       dns | connect | tls | request | stream | config
 * @param {number} [signals.firstTokenMs] 成功但首 token 耗时（毫秒）
 */
export function classifyFailure(signals = {}) {
  const t = text(signals)
  const status = signals.status
  const url = signals.url ?? ''

  // 1) 工作环境：base URL 多拼了一层 /v1 —— dsh 里 anthropic-messages 类型的
  //    provider 地址带 /v1 会让请求落到 /v1/v1/messages，直接 404。
  if (/\/v1\/v1(\/|$|\?)/.test(url) || /\/v1\/v1(\/|$)/.test(t)) {
    return verdict(
      'environment',
      'double-v1-in-url',
      '请求 URL 里出现了 /v1/v1：base URL 多拼了一层 /v1，这是本地配置写错了。',
      '把 provider 的 base URL 去掉一层 /v1（anthropic-messages 类型应以 /api 结尾、不带 /v1；openai-completions 类型才带 /v1）。',
    )
  }

  // 2) 工作环境：URL 本身不合法 / 没配密钥 —&gt; 还没发出去就死在本地。
  if (signals.phase === 'config') {
    return verdict(
      'environment',
      'local-config',
      signals.message ?? '本地配置不完整，请求没有发出去。',
      '检查插件/provider 配置：base URL 是否填写、密钥环境变量是否设置。',
    )
  }

  // 2.5) 中转站层：经中转站转发时独有的失败（无可用渠道、Cloudflare 52x、
  //      返回网页、站内余额/分组）。signals.relay === 'off' 时整体跳过；
  //      余额/分组这类和官方话术重叠的，要求已知是中转站才命中（见 relay.js）。
  if (signals.relay !== 'off') {
    const relayMatch = matchRelayFailure(signals)
    if (relayMatch) {
      return verdict('relay', relayMatch.rule, relayMatch.summary, relayMatch.suggestion)
    }
  }

  // 3) 上游阻塞：并发 / 容量打满。AMD 免费额度的典型报错
  //    model_concurrency_rate_limit_exceeded，页面上显示 “At capacity”。
  if (
    /model_concurrency_rate_limit_exceeded|concurrency|at capacity|overloaded|too many concurrent|rate_limit_exceeded/i.test(t) ||
    (status === 429 && !/quota|balance|余额|credit/i.test(t))
  ) {
    return verdict(
      'upstream',
      'concurrency-limit',
      '对方同时在用的人太多，把你的请求挡回来了（429）。不是你的设置错，也不是网断了。',
      '等一会儿再试，或换一个不那么挤的模型；高峰时段免费额度尤其容易满。',
    )
  }

  // 4) API 调用：429 但原因是额度/余额 —— 这是账户问题，不是上游挤。
  if (status === 429 || /insufficient_quota|quota|余额不足|balance|arrear/i.test(t)) {
    return verdict(
      'api',
      'quota-or-balance',
      '请求被拒是因为账户额度/余额问题（429 或额度类错误码）。',
      '去服务商页面看剩余额度；免费额度通常按天重置，确认重置时间。',
    )
  }

  // 5) API 调用：密钥无效或无权限。
  if (status === 401 || status === 403 || /invalid_api_key|unauthorized|authentication|invalid.*key|api key/i.test(t)) {
    return verdict(
      'api',
      'auth-failed',
      `上游返回 ${status ?? '认证错误'}：密钥无效、过期或没有这个模型的权限。`,
      '核对密钥有没有复制完整、有没有多余空格；再确认这把密钥和你填的接口地址是同一家的。',
    )
  }

  // 6) API 调用：模型名不存在。注意有些平台页面上的显示名不是 API 模型 id。
  if (/model_not_found|model not found|no such model/i.test(t) || (status === 404 && /model/i.test(t))) {
    return verdict(
      'api',
      'model-not-found',
      '对方说没这个模型：路通了、密钥也认了，只是模型名对不上。',
      '去服务商的模型列表里抄准确的模型名，不要用网页上显示的名字——两者经常不一样。',
    )
  }

  // 7) API 调用：路径 404 —— base URL 写错（少/多一段路径）。
  if (status === 404) {
    return verdict(
      'api',
      'path-not-found',
      '对方说这个地址不存在（404）：多半是接口地址拼错了，少一段或多一段。',
      '对照服务商给的地址逐字核对；这类接口地址一般以 /v1 结尾。',
    )
  }

  // 8) API 调用：请求参数 / 上下文长度问题。
  if (status === 413 || /context_length|context length|too long|maximum context/i.test(t)) {
    return verdict(
      'api',
      'context-too-long',
      '请求太长，超过了模型的上下文上限。',
      '缩短对话历史或换上下文更大的模型。',
    )
  }
  if (status === 400) {
    return verdict(
      'api',
      'bad-request',
      '上游返回 400：请求参数不合要求（看错误原文里点名的字段）。',
      '按错误原文修参数；常见是模型名格式、messages 结构或不支持的参数。',
    )
  }

  // 9) 上游阻塞/故障：5xx 是网关或服务本身的问题。
  if (typeof status === 'number' && status >= 500) {
    return verdict(
      'upstream',
      'server-5xx',
      `对方服务器自己出故障了（错误码 ${status}），不是你这边的问题。`,
      '等一会儿再试；一直这样说明对方还没修好，可以换个模型或服务商。',
    )
  }

  // 10) 网络环境：DNS 解析失败。
  if (signals.phase === 'dns' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(t)) {
    return verdict(
      'network',
      'dns-failed',
      '连域名都解析不出来：请求没离开本机，卡在 DNS 这一步。',
      '检查本地网络与代理：代理没开/DNS 被污染时先恢复网络；确认域名拼写无误。',
    )
  }

  // 11) 网络环境：连接被拒绝。
  if (/ECONNREFUSED/i.test(t)) {
    return verdict(
      'network',
      'connection-refused',
      'TCP 连接被对方/中间设备拒绝：端口不对、代理没在监听，或目标服务没开。',
      '若走了本地代理，先确认代理在运行且端口正确；直连则核对主机和端口。',
    )
  }

  // 12) 网络环境：连接超时。
  if (signals.phase === 'connect' || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect timeout|connection timed out/i.test(t)) {
    return verdict(
      'network',
      'connect-timeout',
      'TCP 连接超时：包出去了但没回应，常见于网络不通、被墙或代理未生效。',
      '先确认代理开着且分流规则覆盖这个域名；换网络（如手机热点）对比一下。',
    )
  }

  // 13) 网络环境：TLS/证书问题 —— 常见于代理劫持或系统证书异常。
  if (signals.phase === 'tls' || /CERT|TLS|SSL|self.signed|unable to verify/i.test(t)) {
    return verdict(
      'network',
      'tls-failed',
      '连接在加密握手这一步失败了：多半是代理软件在中间拦截，或者电脑的证书、时间不对。',
      '检查代理软件的证书相关设置、把系统时间校准；公司/校园网的网络审查也会这样。',
    )
  }

  // 14) 网络环境：流式回答中途断开。
  if (signals.phase === 'stream' || /ECONNRESET|UND_ERR_SOCKET|socket hang up|premature close/i.test(t)) {
    return verdict(
      'network',
      'stream-reset',
      '连接在传输中途被重置：回答流断了，多半是代理不稳定或中间设备掐断长连接。',
      '换一个代理节点/关掉代理对比；长回答更容易触发，短问一句试试是否稳定。',
    )
  }

  // 15) 上游阻塞（软）：请求最终成功，但首 token 等了太久 —— 上游在排队。
  if (typeof signals.firstTokenMs === 'number' && signals.firstTokenMs > 20_000) {
    return verdict(
      'upstream',
      'slow-first-token',
      `请求成功了，但等第一个字出来就等了 ${(signals.firstTokenMs / 1000).toFixed(1)} 秒：是对方在排队，不是你这边慢。`,
      '高峰期换个模型试试；同一句话换个模型问，对比谁先开口最能说明问题。',
    )
  }

  // 16) 网络环境（笼统）：fetch 只给了 failed，没有细节。
  if (/fetch failed|network error|failed to fetch/i.test(t)) {
    return verdict(
      'network',
      'fetch-failed-generic',
      '请求在网络层失败（只有笼统的 fetch failed）。需要分层探测才能分清是 DNS、连接还是 TLS。',
      '运行本插件的探测（probe）模式，从 DNS 开始逐层往上查。',
    )
  }

  return verdict(
    'unknown',
    'no-match',
    '现有信号不足以归类。建议按顺序排查：先看 HTTP 状态码和错误原文，再跑分层探测。',
    '把错误原文（状态码 + 错误码 + 信息）交给 diagnose_failure，并开启 probe 逐层确认。',
  )
}

export { CATEGORY_LABEL }
