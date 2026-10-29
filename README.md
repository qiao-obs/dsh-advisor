# dsh-advisor

> 让工作会话在**拿不准的时候**问另一个模型一句。一个工具，用户不叫，它就不说话。

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

## 桌面交互版（v0.2）

v0.1 只有工具。v0.2 把它做成一个能用眼睛看的桌面插件，四件事必须始终可见：**为什么要咨询、正在问谁、发送了什么、意见最终改变了什么**。

### 1. 设置页（DSH 设置 → 顾问）

复用宿主设置系统，不是自建网页：

| 区块 | 内容 |
| --- | --- |
| **启用顾问** | 总开关，默认开。关掉后输入区入口、咨询卡、顶部状态全部消失，`consult.start` 直接拒绝（`reason:'disabled'`），**一次模型请求都不会发**；已存的咨询记录保留可查。 |
| 插件状态 | 未配置模型 / **可使用** / 配置异常。**「可使用」只表示可以用，不表示正在调用。** 同时显示「实际将使用」的模型。 |
| 使用方式 | 只在我要的时候咨询（默认）/ 主力建议后由我确认 / 本会话内已授权自动调用。授权只对当前会话有效，后面两项要一次显式授权，之后不再反复弹窗。 |
| 顾问模型 | 默认跟随当前会话模型；也可指定 provider + model（下拉列出宿主真实可用的模型目录）。 |
| 材料范围 | 本次问题 / 选中内容 / 当前方案 / 当前改动 / 测试输出，逐项开关。**发送前可看全文。** |
| 工作方式 | 只展示给我 / 返回主力核验。 |
| 高级设置 | 意见长度上限（token）、单次超时（毫秒）、本会话调用上限、本会话保留条数。 |
| 连接检查 | **用户点了才发请求**——一次 8 token 的 ping，报出实际模型与往返耗时。 |

### 2. 会话入口

输入区左侧「咨询顾问」按钮；选中代码后发起咨询默认围绕该段代码，不偷偷附带整个历史。确认区就地展开在 composer 上方，含关注问题、顾问模型、材料摘要、「查看材料」「开始咨询」「取消」。

### 3. 过程可见

会话内可折叠咨询卡，状态全部来自真实事件，**不播放虚假进度百分比**。卡片挂在 composer 下方，所以**默认折叠成一行摘要**（状态 + 问题前 30 字），展开时限高 `38vh` 内部滚动——不把对话区顶掉：

`等待确认` → `请求已发出（已等待 N 秒 · 取消）` → `已返回` / `输出被截断 — 意见不完整` / `顾问没有提出新问题` / `超时` / `失败` / `已取消`

会话顶部低干扰状态：`顾问：手动模式`、`顾问处理中`、`本会话已咨询 N 次`。

每条终态都带一条只说得出证据的注意事项：

- 截断 → 「正文保留，但结尾缺失，不要把它当作完整审查。」
- 无新增建议 → 「不代表任务已验证通过。」
- 已取消 → 「这次只取消了本地等待，不能据此认为远端已停止生成。」
- 失败 → 显示 provider 返回的真实原因（例如 `UNKNOWN_MODEL pi-ai provider "llmgo" has no configured model "no-such-model-v0"`）。

### 4. 结果界面

第一层是一两句结论，展开看完整意见与依据。每条意见回答四件事：**哪里有问题 / 依据是什么（哪些是假设）/ 怎么验证 / 是否扩大范围**。

动作：`让主力核验` / `标记为已处理` / `主力认为不成立` / `暂不处理` / `查看原始意见`。**刻意没有含义模糊的「一键采纳」。**

三个事实分开记，不压成一个「已采纳」：

- `核验状态`：尚未确认 / 主力核对后成立 / 主力核对后认为不成立 / 无法判定
- `处理状态`：未处理 / 已按建议处理 / 暂不处理
- `已交给主力` / `未交给主力`

**核验后拒绝建议也是成功结果**——它证明这条意见被读过、被判断过。

### 5. 材料版本绑定

每次咨询把发送材料的内容摘要（`sha256:` 前 32 位）与被发送的路径一起存进记录。之后重新打开卡片时，只重算**那次真正发出去的路径**：变了就显示

> 基于旧版本，需重新核验
> 改动过的材料：D:/DeepSeekHarness/工作区/.tmp/staleness-probe.txt

不重算整个工作区——那样任何地方一动就喊「变了」，用户很快就学会无视这个标记。

### 6. 历史与会话隔离

咨询卡右上「历史 (N)」可回看本会话全部记录（按时间倒序，逐条展开）。记录落盘在 `<DSH_HOME>/dsh-advisor/sessions/<sessionId>.json`，**一个会话一个文件**，切会话不会串记录。设置落盘在 `<DSH_HOME>/dsh-advisor/settings.json`，重启后保留；关闭插件后不再有任何自动调用（本来也没有）。

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
| `tests/materials.test.mjs` | 材料采集：当前方案 vs 旧待办、超预算截断、行为可复现、不可读即「缺失且有原因」、设置与显式退出优先 |

99 项全绿。**界面部分没有自动化测试**：v0.2 的验收是在真实桌面里一项项点出来的，理由是插件的状态来自宿主事件，用假 DOM 测「卡片显示了什么」只能测到自己写的 mock。真机验收记录见 `docs/acceptance-v0.2.md`。

## 已知限制

- **实测环境是 DSH 桌面 App（profile `desktop`，宿主 0.2.1-rc.3）**。Web CLI 与 headless 的界面部分是同一个 client bundle，但没有在那些 profile 上一项项走过。
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
