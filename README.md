# dsh-advisor

> 让工作会话在**拿不准的时候**问另一个模型一句。一个工具，用户不叫，它就不说话。

**中文** · [English](./README.en.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9.svg?style=flat-square)
![Node >=22](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?style=flat-square)

---

## 这是什么

`dsh-advisor` 给 DeepSeek Harness 会话加一个工具 `advisor_consult`。正在干活的模型可以调用它，把**一个具体的决定**发给第二个模型，拿回一段意见。

它不是一个自动审查器，也不是流水线里的一道门：

- **不会自动触发**。没有定时、没有每步调用、没有回声室式的第二轮追问。一次工具调用 = 一次由插件发起的模型调用，成本因此可归因。
- **不预设供应商**。插件不做任何事，直到主力模型主动调用；调用时才用**这个会话已经选定的模型**。
- **可以是「不改」**。顾问最有用的时候，往往是它给了理由让你停手，而不是让你继续动手。

## 安装

需要 Node `^22.19.0 || >=24.0.0`，DSH `^0.2.0-rc.1`。

```sh
# DSH Studio 桌面 App / Web CLI 通用：装进指定 profile
dsh plugin --profile web add github:qiao-obs/dsh-advisor
```

`web` 换成你在用的 profile 名（桌面 App 常见的是 `desktop`）。装完重启 DSH 并刷新页面。

固定版本：

```sh
dsh plugin --profile web add github:qiao-obs/dsh-advisor#v0.1.1
```

移除：

```sh
dsh plugin --profile web remove dsh-advisor
```

### 版本兼容

本包的 `engines.dsh` 是 `^0.2.0-rc.1`。宿主会用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定；不满足时安装被 `incompatible-version` 拒绝。确需豁免可以：

```sh
dsh plugin allow-version dsh-advisor@0.1.1 --profile web
```

## 配置

装完之后默认就能用：不写 `provider`，插件读会话自己的默认模型。

要改行为，编辑 profile 里的 `cordis.patch.yml`（或 `~/.dsh/profiles/<name>/` 下对应文件）：

```yaml
- insert:
    - id: dsh-advisor
      name: dsh-advisor
      config:
        maxAdviceTokens: 1000         # 每次咨询的输出上限（约 4000 字符，与协议上限对齐）
        maxConsultationsPerRun: 8     # 本次会话最多发起几次咨询，超了不花钱
        consultDeadlineMs: 60000      # 单次咨询的总预算
        authorizedScopes: [plan, diff, test, general]
        injectAdvice: true            # false = 照付钱但不给主力看
        outputDir: null               # null = 不写记录
```

**`provider` / `model` 默认不填**。填了就固定用那个模型；不填就用会话当前的默认模型。这个取舍是刻意的：装一个插件不应该把会话内容送到用户没选过的供应商。

### 环境变量

同样的键可以用环境变量给，优先级：插件 config > 上下文 config > 环境变量。

| 变量 | 对应字段 |
| --- | --- |
| `ADVISOR_PROVIDER` | `provider` |
| `ADVISOR_MODEL` | `model` |
| `ADVISOR_MAX_ADVICE_TOKENS` | `maxAdviceTokens` |
| `ADVISOR_MAX_CONSULTATIONS` | `maxConsultationsPerRun` |
| `ADVISOR_DEADLINE_MS` | `consultDeadlineMs` |
| `ADVISOR_AUTHORIZED_SCOPES` | `authorizedScopes`（逗号分隔） |
| `ADVISOR_INJECT_ADVICE` | `injectAdvice`（`false` 才关） |
| `ADVISOR_OUTPUT_DIR` | `outputDir` |
| `ADVISOR_RUN_ID` | `runId` |

空字符串当作没设。**解析不出来的值会被丢弃**，不会写成 `undefined` 覆盖默认值——那会让上限静默失效。

## 工具

```jsonc
{
  "name": "advisor_consult",
  "parameters": {
    "question": "这次要复核的那一个决定。说清你要做什么、为什么。",
    "focus": "plan | diff | test | general",
    "deadlineMs": "可选，单次咨询的预算"
  },
  "required": ["question"]
}
```

返回 `{ outcome, consultationId, advice, cancelled, timedOut, adviceWithheld, truncated, budgetRemaining }`。

`outcome` 只能是：

| 值 | 含义 |
| --- | --- |
| `advised` | 拿到可用意见（**含被输出上限截断的情况**，见下面 `truncated`） |
| `no_advice` | 顾问明确回了 `NO_ADVICE`，这也是一次正常结束 |
| `refused_no_consent` | 该 `focus` 未获授权，且没有可以问人的通道（headless）。**没有发出请求** |
| `budget_exhausted` | 到达本次会话的咨询上限。**没有发出请求，不花钱** |
| `failed` | 没配置、流被 `aborted`/`error` 打断、被取消、超时、或者返回内容不可用 |

`cancelled` 与 `timedOut` 分开报，不互相冒充：调用方取消不是超时，超时也不是取消。

`truncated` 单独报：为 `true` 表示顾问撞上输出上限（`finish.kind === 'max-tokens'`）被截断。**这时 `advice` 仍然是它真正说出来的那部分**，一个字都不会丢；调用方应把结尾当作缺失，不要当成结论。之所以不判 `failed`：截断只说明它没说完，不说明它没说。`aborted`/`error` 仍然算 `failed`，因为那两种情况连「它说到哪」都不成立。

### 授权（consent）

`authorizedScopes` 是**预先授权**的 `focus` 列表。列表里的直接放行；不在列表里的走宿主的 `userQuestions` 问人。

headless 场景没有 `userQuestions`，此时未授权的 `focus` 一律 `refused_no_consent` 且**不发起请求**——所以工具 schema 也只广告本次真正可达的 `focus`。广告一个必然被拒的选项不是授权检查，是陷阱。

### 记录

`outputDir` 设了才写，写到 `<outputDir>/<runId>/`：

- `advisor-events.jsonl` — 每个决策点一行（预算拒绝、咨询返回等）
- `advisor-calls.jsonl` — 每次咨询的完成记录

**记录里不含意见正文**，也刻意不含问题全文（只有字符数）。它回答「为什么发起、花了多少」，不回答「它说了什么」。用法量三件事分开记：

- `usageRaw` — 收到的原始数字，零是零
- `usageCompleteness` — `complete` / `partial` / `missing`
- `usageOrigin` — `unknown` / `provider-reported` / `adapter-default` / `adapter-estimated`

默认 `unknown`。内核的 `TokenUsage` 没有来源字段，所以经它到达的读数**在构造上**就没有凭据；「成功且有内容」不构成「数字是供应商报的」。**未知的价格不按 0 处理。**

## 测试

```sh
npm test
```

三组，全部离线，不需要 provider、不需要网络、不花钱：

| 文件 | 覆盖 |
| --- | --- |
| `tests/plugin.test.mjs` | 注册面、调用纪律、预算、取消/超时/卸载、未配置、截断仍交付 |
| `tests/advice.test.mjs` | 意见协议、真实回归语料、用量分类 |
| `tests/config.test.mjs` | 配置解析优先级、清单与 patch 的自洽 |

## 已知限制

- **只在 headless 上实测过完整链路**。Web / 桌面 App 的界面行为没测。
- **`userQuestions` 授权分支未在真实宿主上走过**：headless 没有那个服务，实测覆盖的是「没有通道 → 拒绝」这一半。
- **没有真实的计价依据**。宿主侧对未知 provider 返回 `NO_COST`（`{input:0,output:0,...}`），那不是「免费」，是「没有这个事实」。所以本插件只报 token 读数，不报钱，也不把未知当 0。
- **`NO_ADVICE` 之后不会追问**。顾问说「没什么可说」，这次咨询就结束了。
- **截断的建议只能当半份用**。撞上 `maxAdviceTokens` 时（默认 1000，约 4000 字符）文本照给、`truncated` 标真，但结尾是断的：它可能正要否定前面的判断，而那半句已经被上限切掉了。真实第一次干净安装的咨询就撞过这个——旧的默认 400 token 把 1776 字符的可用建议整段丢弃，现在不会再丢，但「没说完」这件事只能由调用方处理。
- **没有重试**。请求失败就是 `failed`，要不要再来一次由主力模型自己判断——插件不替它决定。
- **`injectAdvice: false` 仍然花钱**：它只是把意见扣下不给主力看，用来单独测成本。
- **取消与超时的边界靠 `cancelGraceMs`**（默认 300 ms）：超时后给流一点时间自己收尾，收不到就直接判 `timed-out`，并记下 `waitEndedAs`。

## 设计取舍

代码里的注释逐条写了理由，这里只列最影响行为的四条：

1. **工具只注册，从不调度。** 自动咨询会让成本无法归因，也会把「再问一遍」变成默认动作。
2. **不选供应商。** 见上文 `provider` 默认不填。
3. **授权是硬门，不是警告。** 拿不到授权就不发请求，而不是发了再道歉。
4. **不推断，直接说不知道。** 用量的来源、超时与取消、意见是否可用，每个判断都只用能直接观测到的证据。

## 来源与许可

MIT，见 [LICENSE](./LICENSE)。

核心逻辑（`lib/advisor.js`）最初是一个探针：为了确认 DSH 的 `llm` / `tools` / 授权通道到底允许什么，写了一批离线夹具和真实调用去测，测出来什么就写进什么规则。代码里 `mNNNNN` 形式的标记指向那份开发记录的条目，保留它们是为了让「这条规则为什么存在」可以被追溯，读代码本身不需要它们。发布版本去掉了对那份记录的依赖：没有任何运行时路径会去读它。

`tests/fixtures/advice-regressions.json` 里的三段文本是真实的顾问回复，在开发期被当时「数句子」的规则整段拒收过。留着它们是因为：**解析器的改动应该拿真正弄坏它的文本来检验，而不是拿手写的仿制品。** 文本内容是关于一个假想的日志脱敏函数的讨论，不含任何凭据、主机名或用户数据。
