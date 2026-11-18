/**
 * relay.js — 中转站（API relay / 聚合站）层面的识别与失败匹配。
 *
 * 很多人不直连官方 API，而是经中转站转发（New API / One API 类面板居多）。
 * 这一层有自己独有的失败方式，既不是你的调用错、也不是模型上游挤：
 *   - 站里没有可用渠道（它背后的通道全挂了，或你的分组没配这个模型）
 *   - 站点挂在 Cloudflare 后面：52x 是站/回源的问题，还会返回网页而不是 JSON
 *   - 你在站里的账户余额/令牌额度用完（和官方账户额度是两回事）
 *   - 站长自己的上游账号额度耗尽
 *   - 令牌分组无权使用该模型
 *
 * detectRelay：从响应头/响应体指纹判断对面是不是中转站。
 * matchRelayFailure：纯匹配，命中返回 { rule, summary, suggestion }，由
 * classify.js 包成 'relay' 类判定。signals.relay === 'off' 时整体禁用。
 */

export function detectRelay({ headers = {}, bodyText = '' } = {}) {
  const evidence = []
  let kind = null

  const server = String(headers['server'] ?? headers['Server'] ?? '')
  const hasCloudflare = /cloudflare/i.test(server) || 'cf-ray' in headers || 'CF-Ray' in headers
  if (hasCloudflare) evidence.push('响应经过 Cloudflare')

  if (headers['x-new-api-version'] || headers['X-New-Api-Version']) {
    kind = 'new-api'
    evidence.push('带有 New API 面板版本头')
  } else if (headers['x-one-api-version'] || headers['X-One-Api-Version']) {
    kind = 'one-api'
    evidence.push('带有 One API 面板版本头')
  }

  const bodyIsHtml = /^\s*<(?:!doctype|html)/i.test(bodyText ?? '')
  if (bodyIsHtml) evidence.push('响应体是 HTML 网页而不是 JSON')

  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText)
      const type = String(parsed?.error?.type ?? '')
      if (/new_api|one_api/i.test(type)) {
        kind = kind ?? (type.includes('one') ? 'one-api' : 'new-api')
        evidence.push(`错误类型是面板特有的 ${type}`)
      }
    } catch {
      /* 不是 JSON 就算了 */
    }
  }

  const panelFingerprint = kind !== null
  return {
    isRelay: panelFingerprint || (hasCloudflare && bodyIsHtml),
    kind: kind ?? (hasCloudflare ? 'cloudflare' : null),
    bodyIsHtml,
    evidence,
  }
}

function match(rule, summary, suggestion) {
  return { rule, summary, suggestion }
}

/**
 * @param {object} signals 同 classifyFailure 的信号，另加：
 * @param {string} [signals.relay]   'auto' | 'on' | 'off'（off 时 classify 不会调用本函数）
 * @param {boolean} [signals.isRelay] 探测/指纹已确认是中转站
 * @param {boolean} [signals.bodyIsHtml] 错误响应体是 HTML
 */
export function matchRelayFailure(signals = {}) {
  const t = [signals.code, signals.message, signals.causeCode, signals.causeMessage].filter(Boolean).join(' ')
  const status = signals.status
  const relayOn = signals.relay === 'on'
  const knownRelay = relayOn || signals.isRelay === true

  // 1) 无可用渠道：中转站独有的话术，直连官方永远不会这么说。
  if (/无可用渠道|没有可用渠道|无可用分发|暂无可用渠道|no available channel|channel.*not.*available/i.test(t)) {
    return match(
      'relay-no-channel',
      '中转站说没有可用渠道：它背后转发这个模型的通道全挂了，或者你的分组压根没配这个模型。不是你的密钥或网络问题。',
      '换个模型试试（可能只是这个模型的渠道挂了）；都这样就是站方的问题，等恢复或换站。',
    )
  }

  // 2) 站长自己的上游额度/账号耗尽。
  if (/上游.*(额度|余额)不足|渠道.*(额度不足|余额不足)|channel.*(quota|balance).*(exhaust|insufficient)|上游账号.*(额度|欠费)/i.test(t)) {
    return match(
      'relay-upstream-exhausted',
      '中转站自己的上游账号额度耗尽了：你的账户可能还有钱，但站方转发用的账号没钱了。',
      '这只能等站长补额度，或者换一个中转站；自己充值解决不了这一条。',
    )
  }

  // 3) Cloudflare 52x / 10xx：站点层或回源问题。
  const cfStatus = typeof status === 'number' && ((status >= 520 && status <= 526) || status === 1015 || status === 1020)
  if (cfStatus || (knownRelay && /cloudflare/i.test(t))) {
    const what =
      status === 524
        ? '524：中转站回源超时 —— 站活着，但它连它背后的上游太慢，先超时断开了'
        : status === 522
          ? '522：Cloudflare 连不上中转站的源站'
          : status === 1015
            ? '1015：被 Cloudflare 限速了，请求太频繁'
            : status === 1020
              ? '1020：被 Cloudflare 防火墙规则拦截'
              : `${status ?? 'Cloudflare'}：中转站/CDN 层错误`
    return match(
      'relay-cloudflare',
      `${what}。这一层在中转站和它的 CDN 之间，不是你的本地问题。`,
      '524 频发说明这个站回源质量差，换个入口域名或换站；1015 就放慢请求频率。',
    )
  }

  // 4) 返回网页而不是 JSON：拦截页 / 维护页 / WAF。
  if (signals.bodyIsHtml || /^text\/html/i.test(String(signals.contentType ?? ''))) {
    return match(
      'relay-html-error',
      '接口返回的是一个网页而不是 JSON 错误：多半是 Cloudflare 拦截页、站点维护页或 WAF 把请求挡了。',
      '看一眼站点公告/换个入口域名；请求频率太高触发拦截时，先停一会儿再试。',
    )
  }

  // 5) 你在中转站的账户余额 / 令牌额度用完（需已确认是中转站才这么判，
  //    否则和官方账户额度分不清，交给通用规则）。
  if (knownRelay && /余额不足|余额已用完|预付费额度|额度已用完|用户额度不足|令牌额度|insufficient balance|token quota/i.test(t)) {
    return match(
      'relay-account-balance',
      '你在中转站的账户余额或这个令牌的额度用完了（这是站内账户，和官方 API 账户是两回事）。',
      '去中转站面板看余额/令牌额度：充值、换一个有额度的令牌，或调高令牌额度上限。',
    )
  }

  // 6) 令牌分组问题。
  if (/分组.*(无权|没有权限|不存在|未配置|不可用|已禁用)|令牌分组/i.test(t) || (knownRelay && /group.*(no permission|not found|disabled|not configured)/i.test(t))) {
    return match(
      'relay-group',
      '中转站说你的令牌分组用不了这个模型：分组不存在、没开这个模型的权限，或被禁用了。',
      '去中转站面板看令牌所属分组支持哪些模型；换到有权限的分组或换令牌。',
    )
  }

  return null
}
