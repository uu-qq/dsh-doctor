# dsh-doctor — dsh 失败诊断插件

给 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 用的诊断插件。

回答失败的时候，最浪费时间的就是瞎猜：是我的密钥错了？网断了？还是服务商挤爆了？
这个插件就是来分清这件事的 —— 它把一次失败归类到四个方面，并给出依据和下一步建议：

| 分类 | 典型信号 |
| --- | --- |
| **API 调用问题** | 401 密钥无效、模型名不存在（model_not_found）、路径 404、参数 400、额度/余额不足 |
| **网络环境问题** | DNS 解析失败、连接被拒/超时、TLS 证书错误、流式回答中途断开 |
| **工作环境问题** | 本地配置写错 —— 典型是 base URL 多拼了一层 `/v1`（请求落到 `/v1/v1/...`） |
| **上游阻塞** | 429 并发打满（model_concurrency_rate_limit_exceeded / “At capacity”）、5xx、首 token 排队几十秒 |

## 它怎么工作

插件注册一个模型工具 **`diagnose_failure`**，两种用法：

1. **分类已发生的错误**：把报错原文（状态码 + 错误码 + 信息）交给它，立刻得到分类和建议。
2. **分层实时探测**（probe）：对配置的端点从下往上逐层查 —— 配置形态 → DNS → TCP/TLS 握手 → 带密钥请求 `/models` → 最小生成请求（max_tokens=1）。坏在哪一层就停在哪一层，不会拿一个笼统的“失败了”糊弄你。

装上后，插件还会给模型留一段提示：遇到调用失败先跑诊断，再决定是重试、换模型还是改配置 —— 上游阻塞时盲目重试只会更挤，配置类错误重试多少次都没用。

## 安装

```sh
dsh plugin --profile web add github:uu-qq/dsh-doctor
```

然后在 profile 的 `cordis.patch.yml` 里按 id `doctor` 给这个插件填上你的端点（或保持空、用工具参数临时传）：

```yaml
- insert:
    - id: doctor
      name: dsh-doctor
      config:
        baseUrl: 'https://developer.amd.com.cn/radeon/api/v1'  # 你的 API base URL
        model: 'MiMo-V2.6-Flash'                                # 可选，填了才会做生成探测
        apiKeyEnv: DSH_DOCTOR_API_KEY                           # 密钥所在的环境变量名
        timeoutMs: 20000
```

密钥只从 `apiKeyEnv` 指定的环境变量读取，只用于探测请求的 Authorization 头，**绝不出现在任何输出里**。

## 不装插件也能用：独立 CLI

同一套诊断逻辑可以脱离 dsh 直接跑，适合先在终端里定位问题：

```sh
# 只分类一段报错原文
node lib/cli.js --error "429 model_concurrency_rate_limit_exceeded: At capacity"

# 对端点做分层探测（密钥放环境变量）
DSH_DOCTOR_API_KEY=你的密钥 node lib/cli.js \
  --base-url https://developer.amd.com.cn/radeon/api/v1 \
  --model MiMo-V2.6-Flash
```

退出码：0 = 探测全过；2 = 发现问题（已分类）；1 = 用法错误。

输出示例：

```
分层探测：
  ✓ config（0ms）base URL 形态正常：https://developer.amd.com.cn/radeon/api/v1
  ✓ dns（12ms）developer.amd.com.cn → 20.205.x.x
  ✓ connect（210ms）TLS 握手完成（developer.amd.com.cn:443）
  ✗ auth（180ms）GET /models 返回 401：{"error":{"code":"invalid_api_key",...}}

结论：API 调用问题
依据：上游返回 401：密钥无效、过期或没有这个模型的权限。
建议：核对密钥是否复制完整、有没有多余空格；确认密钥所属平台与 base URL 是同一家。
```

## 中转站版（v0.2 新增）

很多人不直连官方 API，而是经中转站（New API / One API 类面板）转发 —— 这一层有
自己独有的失败方式，既不是你的调用错、也不是模型上游挤。本插件为此加了第五类判定
**「中转站层问题」**，默认自动启用（配置 `relay: 'auto'`，设为 `'off'` 整体关闭）：

| 中转站独有的失败 | 怎么认出来 |
| --- | --- |
| 无可用渠道（它背后的通道全挂了/你的分组没配这个模型） | 错误话术独有，直连官方永远不会这么说 |
| Cloudflare 520–526 / 1015 / 1020（524=回源超时、1015=被限速） | 状态码段本身就是站点层错误 |
| 接口返回网页而不是 JSON（拦截页/维护页/WAF） | 探测时检查响应体是不是 HTML |
| 你在站内的账户余额/令牌额度用完 | 仅在已确认是中转站时才这么判，避免和官方账户额度混淆 |
| 站长自己的上游账号额度耗尽 | 「上游渠道额度不足」类话术 |
| 令牌分组无权使用该模型 | 「分组无权/未配置」类话术 |

探测时还会做**指纹识别**：New API / One API 的版本响应头、Cloudflare 痕迹、
面板特有的错误类型，识别结果会写在探测报告里（`识别为中转站（new-api）：…`）。
只有 Cloudflare 痕迹而没有其他证据时不会下结论 —— 官方 API 也可能套 CDN。

CLI 对应开关：默认开启中转规则，`--no-relay` 关闭。

## 开发

```sh
npm test   # 分类器单元测试（node --test，无外部依赖）
```

目录：

- `lib/index.js` — 插件入口：注册 `diagnose_failure` 工具与系统提示
- `lib/classify.js` — 纯函数分类器（信号 → 五类判定），规则都在这
- `lib/relay.js` — 中转站指纹识别 + 中转层失败规则
- `lib/probe.js` — 分层探测实现
- `lib/cli.js` — 独立命令行入口
- `test/` — 分类器测试用例，包含真实踩过的坑（AMD 429 并发满、/v1/v1、页面名≠模型 id）与中转站话术用例

## 说明

- dsh 还在开发者预览期，插件 API 可能有破坏性变更；本插件按 2026-11 的插件规范（Cordis bundle）编写。
- 生成探测会产生一次 max_tokens=1 的真实请求，费用可忽略，但会占用一次并发。
- MIT 许可。
