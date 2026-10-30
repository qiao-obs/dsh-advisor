# dsh-advisor

> 把第二个视角接入日常工作：从具体意见，到有范围、有验收条件的待办，再到执行回报与人工验收。

**中文** · [English](./README.en.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9.svg?style=flat-square)
![Node >=22](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?style=flat-square)

---

## 这是什么

`dsh-advisor` 给 DeepSeek Harness 加**第二个视角**：设置页里选好模型和材料范围，会话里点一下「咨询顾问」，把**一个具体的决定**发给另一个模型，拿回一段意见——并且让你一路看清问了谁、发了什么、意见改变了什么。

两种用法共用同一套状态与记录：

- **会话里的用户**：输入区「咨询顾问」→ 轻量确认区（关注问题 / 顾问模型 / 材料 / 查看材料）→ 会话内可折叠咨询卡。不离开当前会话。
- **主力模型**：一个工具 `advisor_consult`。正在干活的模型可以调用它，把同一个决定发给第二个模型。

它不是一个自动审查器，也不是流水线里的一道门：

- **不会自动触发**。没有定时、没有每步调用、没有回声室式的第二轮追问。一次咨询 = 一次由插件发起的模型调用，成本因此可归因。
- **不预设供应商**。默认跟随会话当前模型；装一个插件不应该把会话内容送到用户没选过的供应商。
- **可以是「不改」**。「没有新增建议」只表示这次没发现新问题，**不代表任务已验证通过**。

## 日常工作闭环（当前开发分支）

会话顶部新增「待办」工作台：**意见 → 待办 → 确认交付 → 执行回报 → 复查 → 人工验收**。当前功能在审查分支中，尚未包含在 `v0.2.1` 标签内。

- **建议变成可执行任务**：手动咨询可在同一次回复中给出最多 3 个候选行动；选择后编辑范围、优先级和验收条件。旧意见也能手动转待办，或直接创建待办。
- **主力参与执行**：预览完整任务包后确认交付给当前会话主力。模型通过 `advisor_work_report` 回报实际改动、检查证据或阻塞原因；接收成功不代表执行成功。
- **结果有据可查**：模型报完成只进入「待验收」。可以带着报告再请顾问复查，仍须预览并确认调用；人工填写依据后才记录「人工确认通过」。
- **每天继续推进**：支持搜索、优先级、待验收/进行中/已关闭筛选、重新开放和 Markdown 导出。执行方案、改动检查、失败定位、交付前验收有内置提问模板。
- **保留工作证据**：待办单独持久化在 `<DSH_HOME>/dsh-advisor/work/<会话ID的SHA-256>.json`，清空咨询历史不会删除待办里的原意见、执行报告和人工决定。交付超时会标记状态不确定，不自动重复派单。

创建和整理待办不调用模型；交给主力执行会产生宿主正常的模型/工具开销，顾问复查另计咨询次数。当前是会话内工作闭环，不是跨项目调度器。实现、截图、测试与真实宿主验收清单见 [工作闭环验证记录](docs/workflow-review.md)。

## 桌面交互版（v0.2）

v0.1 只有工具。v0.2 把它做成一个能用眼睛看的桌面插件，四件事必须始终可见：**为什么要咨询、正在问谁、发送了什么、意见最终改变了什么**。

### 1. 设置页（DSH 设置 → 顾问）

按顾问模型、使用方式、材料范围和交付方式分组。配置修改后点「保存修改」，或「放弃修改」恢复已保存的配置；总开关与会话授权即时生效。未保存时不能检查连接，避免检查到旧模型。

| 区块 | 行为 |
| --- | --- |
| 启用顾问 | 关闭后隐藏会话入口并拒绝新咨询；历史保留。已发出的请求不会因此自动取消。 |
| 顾问模型 | 跟随宿主当前模型，或指定供应商和模型。不完整的选择不会退回其他模型。 |
| 使用方式 | 仅手动发起 / 每次先确认 / 允许自动发起。自动模式对所有会话生效；手动模式下可临时授权当前会话，最长 24 小时。 |
| 材料范围 | 问题始终包含；选中/粘贴内容、方案、改动和测试可逐项控制。每次咨询仍可缩小范围。 |
| 交付方式 | 只展示给我 / 返回主力核验。交付不代表意见已验证。 |
| 高级设置 | 意见 token 上限、等待时限（秒）、每会话调用上限与历史保留条数。等待时限或次数上限为 0 表示不限。 |
| 连接检查 | 用户点击才会发出真实模型请求，并显示结果与耗时。 |

### 2. 提问 → 预览 → 确认

从输入区「咨询顾问」进入，填写具体问题，选择综合/方案/改动/测试重点，可附上选中或粘贴的文字。下一步显示将发送的实际正文、顾问模型和材料警告；此时尚未调用顾问。只有「确认并发送」才发起咨询。编辑后需要重新预览；材料或模型在确认期间发生变化会被拒绝，保留问题供重新确认。

### 3. 会话顶部工作台

顶部入口显示待办、运行中或待核验数量。打开后查看完整意见、材料、真实状态与错误；结果面板内部滚动，不占用主对话输入框。支持取消、复制和再次咨询。截断、无新增建议、超时、失败与取消分别显示，不使用模拟进度。

取消只表示结束本地等待，不保证供应商停止生成；没有新增建议也不代表任务已经通过验证。

### 4. 独立核验表单

「让主力核验」将意见交给主力模型；「记录核验结果」打开卡片内表单，分别填写核验结论、处理状态和依据。非待定结论必须填写依据。人工标注显示「已标记成立/不成立」，不会声称主力已经确认，也不会使用主对话输入框的草稿。

核验、处理和交付是三个独立事实。关闭面板后，尚未保存的核验说明在当前页面运行时保留。

### 5. 材料与历史

记录保留实际发送材料的摘要与文件指纹，材料变化时显示需重新核验。历史可按问题、意见或模型搜索，也可筛选待核验、进行中和未完成；查看旧记录时刷新不会跳回最新意见。

历史按会话保存在 `<DSH_HOME>/dsh-advisor/sessions/<sessionId>.json`，设置保存在 `<DSH_HOME>/dsh-advisor/settings.json`。清空历史需要再次确认，不会重置调用次数，也不会自动取消已发出的请求。草稿仅保留在当前页面内，刷新后不持久化。

此前设置与咨询界面的验证见 [交互验证记录](docs/ui-interaction-review.md)；当前总计 12 个浏览器回归场景，最新结果见 [工作闭环验证记录](docs/workflow-review.md)。

## 安装

需要 Node `^22.19.0 || >=24.0.0`，DSH `^0.2.0-rc.1`。

```sh
# DSH Studio 桌面 App / Web CLI 通用：装进指定 profile
dsh plugin --profile web add github:qiao-obs/dsh-advisor
```

`web` 换成你在用的 profile 名（桌面 App 常见的是 `desktop`）。装完重启 DSH 并刷新页面。

固定版本：

```sh
dsh plugin --profile web add github:qiao-obs/dsh-advisor#v0.2.1
```

从本地目录装：

```sh
dsh plugin --profile desktop add file:D:/path/to/dsh-advisor
```

移除：

```sh
dsh plugin --profile web remove dsh-advisor
```

装完在 **设置 → 顾问** 里选顾问模型（默认跟随会话，通常不用动），然后在会话输入区点「咨询顾问」。

### 版本兼容

本包的 `engines.dsh` 是 `^0.2.0-rc.1`。宿主会用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定；不满足时安装被 `incompatible-version` 拒绝。确需豁免可以：

```sh
dsh plugin allow-version dsh-advisor@0.2.1 --profile web
```

## 配置

**v0.2 起，日常都不用手写配置**：设置 → 顾问 里改的就是它，落盘在 `<DSH_HOME>/dsh-advisor/settings.json`，重启后保留。

`cordis.patch.yml` 那层留给装机的默认值与工具侧的预算：

```yaml
- insert:
    - id: dsh-advisor
      name: dsh-advisor
      config:
        maxAdviceTokens: 1000         # 每次咨询的输出上限（约 4000 字符，与协议上限对齐）
        maxConsultationsPerRun: 8     # 本次会话最多发起几次工具侧咨询，超了不花钱
        consultDeadlineMs: 60000      # 单次咨询的总预算
        authorizedScopes: [plan, diff, test, general]
        injectAdvice: true            # false = 照付钱但不给主力看
        outputDir: null               # null = 不写这份 run 记录
```

两层各管一段，不互相覆盖：

| 层 | 管什么 | 谁改 |
| --- | --- | --- |
| `settings.json` | 顾问模型、材料范围、使用方式、工作方式、超时/上限/保留条数 | 用户，在设置页 |
| `cordis.patch.yml` / 环境变量 | 装机默认值、工具侧预算与授权、run 记录目录 | 装机者 |

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

有 profile 数据目录时注册两个工具：`advisor_consult` 发起第二意见，`advisor_work_report` 只回报用户已交付任务的结果。后者必须提交任务 ID、本次派单 ID、结果、说明和证据；会话身份取自宿主实际执行上下文。它不能派发任务、调用顾问或替用户标记验收通过。无数据目录的工具模式只注册原咨询工具。


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

逻辑测试全部离线，不需要 provider、不需要网络、不花钱；主要覆盖：

| 文件 | 覆盖 |
| --- | --- |
| `tests/plugin.test.mjs` | 注册面、调用纪律、预算、取消/超时/卸载、未配置、截断仍交付 |
| `tests/advice.test.mjs` | 意见协议、真实回归语料、用量分类 |
| `tests/config.test.mjs` | 配置解析优先级、清单与 patch 的自洽 |
| `tests/materials.test.mjs` | 材料采集：当前方案 vs 旧待办、超预算截断、行为可复现、不可读即「缺失且有原因」、设置与显式退出优先 |

| `tests/workflow.test.mjs` | 持久化任务、去重派单、超时/卸载、实际会话隔离、回报、人工验收、过期版本冲突、复查和候选行动 |

当前 **146/146** 项逻辑测试通过；另有 **12/12** 项 Chromium 浏览器场景通过，运行真实客户端组件及 RPC handlers，但使用模拟宿主与假模型。重现方法见 [工作闭环验证记录](docs/workflow-review.md)。旧版真机验收记录见 `docs/acceptance-v0.2.md`，不代表本分支新增工作流已在真实 DSH 中验证。

## 已知限制

- **旧版实测环境是 DSH 桌面 App（profile `desktop`，宿主 0.2.1-rc.3）**。当前分支的任务交付、回报工具和复查仍需真实宿主验收。Web CLI 与 headless 的界面部分是同一个 client bundle，但没有在那些 profile 上一项项走过。
- **工具侧的 `userQuestions` 授权分支仍未在真实宿主上走过**：实测覆盖的是「没有通道 → 拒绝」这一半；v0.2 的用户态咨询走的是另一条路（用户在确认区点了「开始咨询」），不依赖那个 seam。
- **没有真实的计价依据**。宿主侧对未知 provider 返回 `NO_COST`（`{input:0,output:0,...}`），那不是「免费」，是「没有这个事实」。所以本插件只报 token 读数，不报钱，也不把未知当 0。
- **`NO_ADVICE` 之后不会自动追问**。顾问说「没什么可说」，这次咨询就结束了；要补材料得用户或主力显式再发一次。
- **截断的建议只能当半份用**。撞上 `maxAdviceTokens` 时（默认 1000，约 4000 字符）文本照给、`truncated` 标真，但结尾是断的：它可能正要否定前面的判断，而那半句已经被上限切掉了。卡片会写明「输出被截断 — 意见不完整」。
- **没有重试**。请求失败就是 `failed`，要不要再来一次由用户或主力判断——插件不替他们决定。
- **`injectAdvice: false` 仍然花钱**：它只是把意见扣下不给主力看，用来单独测成本。
- **取消与超时的边界靠 `cancelGraceMs`**（默认 300 ms）：超时后给流一点时间自己收尾，收不到就直接判 `timed-out`，并记下 `waitEndedAs`。
- **材料版本绑定只覆盖「那次真正发出去的路径」**。如果用户改的是没有作为材料发送的文件，卡片不会报旧版本——那是对的，但容易被误解成「什么都盯住了」。
- **「基于旧版本」不会自动重跑**。它只做标记，补证要人来点。

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
