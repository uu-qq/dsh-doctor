#!/usr/bin/env node
/**
* cli.js — 不装进 dsh 也能用的独立诊断命令。
*
* node lib/cli.js --base-url https://example.com/v1 --model <模型id>
* DSH_DOCTOR_API_KEY=xxx node lib/cli.js --base-url... [--error "报错原文"]
*
* 退出码：0 = 探测全过；2 = 发现问题（已分类）；1 = 用法错误。
*/

import { classifyFailure} from './classify.js'
import { runProbes} from './probe.js'
import { formatVerdict, formatProbeReport} from './format.js'

function parseArgs(argv) {
const args = {}
for (let i = 0; i < argv.length; i += 1) {
const a = argv[i]
if (a === '--base-url') args.baseUrl = argv[++i]
else if (a === '--model') args.model = argv[++i]
else if (a === '--error') args.errorText = argv[++i]
else if (a === '--key-env') args.keyEnv = argv[++i]
else if (a === '--no-probe') args.noProbe = true
else if (a === '--help' || a === '-h') args.help = true
}
return args
}

const args = parseArgs(process.argv.slice(2))

if (args.help || (!args.baseUrl &&!args.errorText)) {
console.log(`用法：
node lib/cli.js --base-url <API base URL> [--model <模型id>] [--key-env DSH_DOCTOR_API_KEY]
node lib/cli.js --error "429 model_concurrency_rate_limit_exceeded..." [--base-url <...>]

环境变量：密钥放在 --key-env 指定的环境变量里（默认 DSH_DOCTOR_API_KEY），不会打印。`)
process.exit(args.help? 0: 1)
}

let failed = false

if (args.errorText) {
const statusMatch = /\b(4\d\d|5\d\d)\b/.exec(args.errorText)
const v = classifyFailure({
message: args.errorText,
url: args.baseUrl,
status: statusMatch? Number(statusMatch[1]): undefined,
})
console.log('')
console.log(formatVerdict(v))
failed = true
}

if (args.baseUrl &&!args.noProbe) {
const apiKey = process.env[args.keyEnv?? 'DSH_DOCTOR_API_KEY'] || undefined
const report = await runProbes({ baseUrl: args.baseUrl, model: args.model, apiKey})
if (args.errorText) console.log('')
console.log(formatProbeReport(report))
failed = failed ||!report.healthy
}

process.exit(failed? 2: 0)
