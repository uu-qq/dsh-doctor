/**
 * dsh-doctor — DeepSeek Harness 失败诊断插件。
 *
 * 回答失败时，先分清问题出在哪一方面，再决定是重试还是改配置：
 *   API 调用 / 网络环境 / 工作环境（本地配置） / 上游阻塞
 *
 * 注册一个模型工具 diagnose_failure：
 *   - 给它错误原文（errorText），它按状态码/错误码分类；
 *   - 开启 probe 时，它对配置的端点做分层探测（配置形态 → DNS → 连接/TLS
 *     → 密钥与路径 → 最小生成），坏在哪一层就停在哪一层并给出判定。
 *
 * 密钥只从 apiKeyEnv 指定的环境变量读取，绝不出现在工具结果里。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { classifyFailure } from './classify.js'
import { runProbes } from './probe.js'
import { formatDiagnosis } from './format.js'

export const name = 'doctor'

export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  apiKeyEnv: z.string().default('DSH_DOCTOR_API_KEY'),
  timeoutMs: z.number().default(20_000),
  relay: z.string().default('auto'),
})

const GUIDANCE = [
  '当一次模型/API 调用失败，或用户说“回答失败”时，先调用 diagnose_failure 再决定怎么办：',
  '把报错原文（状态码、错误码、信息）放进 errorText，它会判定问题属于 API 调用、网络环境、工作环境（本地配置）还是上游阻塞。',
  '上游阻塞（429 并发满、5xx、首 token 极慢）不要立刻反复重试，等一会儿或换模型；',
  '工作环境/API 调用类问题（/v1/v1、模型名不存在、密钥无效）重试多少次都没用，要先改对配置。',
  '若判定为中转站层问题（无可用渠道、Cloudflare 52x、返回网页而非 JSON、站内余额/分组问题），坏的是中转站本身或它背后的渠道：不要改本地配置，反复重试也没用，等它恢复或换站。',
].join('')

/** 从错误原文里尽量抠出状态码与错误码，喂给分类器。 */
function signalsFromText(errorText, baseUrl, relayMode = 'auto') {
  const signals = { message: errorText, url: baseUrl, relay: relayMode }
  const statusMatch = /\b(4\d\d|5\d\d)\b/.exec(errorText)
  if (statusMatch) signals.status = Number(statusMatch[1])
  const codeMatch = /"code"\s*:\s*"([^"]+)"/.exec(errorText) ?? /\bcode[:=]\s*"?([a-z_]+)"?/i.exec(errorText)
  if (codeMatch) signals.code = codeMatch[1]
  return signals
}

export function apply(ctx, config) {
  const resolved = {
    baseUrl: config?.baseUrl ?? '',
    model: config?.model ?? '',
    apiKeyEnv: config?.apiKeyEnv ?? 'DSH_DOCTOR_API_KEY',
    timeoutMs: config?.timeoutMs ?? 20_000,
    relay: config?.relay ?? 'auto',
  }

  ctx.tools.register(
    defineTool({
      name: 'diagnose_failure',
      description:
        '诊断一次失败的模型调用到底是哪方面的问题：API 调用（密钥/模型名/路径/额度）、网络环境（DNS/连接/TLS/代理）、工作环境（本地配置，如 base URL 多拼 /v1）、上游阻塞（并发满/5xx/排队）、还是中转站层（无可用渠道/Cloudflare 52x/返回网页/站内余额与分组，经中转站时适用）。把报错原文放进 errorText 分类；probe=true 时还会对端点做分层实时探测并识别中转站指纹。回答失败时先调用它，再决定重试或改配置。',
      parameters: {
        errorText: {
          type: 'string',
          description: '失败时的错误原文，尽量包含状态码与错误码，如 429 model_concurrency_rate_limit_exceeded。',
        },
        baseUrl: {
          type: 'string',
          description: '要探测的 API base URL；省略时用插件配置里的 baseUrl。',
        },
        model: {
          type: 'string',
          description: '要探测的模型 id；提供时多做一步最小生成探测。省略时用插件配置里的 model。',
        },
        probe: {
          type: 'boolean',
          description: '是否做分层实时探测（默认 true，前提是有 baseUrl）。只想分类错误原文时设为 false。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: formatDiagnosis(value) }],
      },
      timeoutMs: 120_000,
      async execute(args) {
        const result = {}
        const baseUrl = args.baseUrl ?? resolved.baseUrl

        if (args.errorText) {
          result.classification = classifyFailure(signalsFromText(args.errorText, baseUrl, resolved.relay))
        }

        const wantProbe = args.probe !== false
        if (wantProbe && baseUrl) {
          const apiKey = process.env[resolved.apiKeyEnv] || undefined
          result.probe = await runProbes({
            baseUrl,
            model: args.model ?? (resolved.model || undefined),
            apiKey,
            timeoutMs: resolved.timeoutMs,
            relay: resolved.relay,
          })
        } else if (wantProbe && !baseUrl) {
          result.probeNote = '未配置 baseUrl（插件配置或参数），跳过实时探测。'
        }

        return JSON.parse(JSON.stringify(result))
      },
    }),
  )

  if (ctx.systemPrompt !== undefined) {
    ctx.systemPrompt.section({
      name: 'tool:dsh_doctor',
      order: 3100,
      text: () => GUIDANCE,
    })
  }
}
