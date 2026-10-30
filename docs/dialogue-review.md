# 顾问与执行 Agent 的任务内交流

2026-10-30。本轮把「用户反复复制计划、执行提示词和结果」替换成一条直接工具交互路径。改动位于开发分支，未发布新标签。

## 谁在什么时候负责

| 阶段 | 触发方式 | 具体行为 |
| --- | --- | --- |
| 梳理方案 | 用户点击「请顾问梳理方案」，或已派单主力调用 plan | 顾问梳理假设、步骤与验证方法，给出供主力使用的执行要求。 |
| 开始执行 | 用户预览并确认交付一个任务 | 插件将范围、验收条件、顾问要求和协作说明发给当前主力；沿用宿主 followup/inject。 |
| 遇到疑点/分歧 | 主力调用 clarify，用户也可直接提问 | 顾问依据材料讨论，答复直接返回调用方，不经过人工复制。 |
| 检查成果 | 主力调用 review 并提交真实证据，或用户发起评价 | 顾问对照验收条件给出问题、修改要求与分项评价；不能冒充已运行检查。 |
| 接受、改范围或继续授权 | 用户决定 | 评分不会自动通过验收，任务关闭仍由人工带依据确认。 |

界面的「顾问正在思考 / 主力负责执行 / 等待你决定下一步」表示当前交流或任务状态，不表示顾问获得主力的工具权限。顾问不执行项目命令。主力是否按提示再次调用顾问仍取决于模型行为；本版没有监听所有报告并自动唤醒两个模型循环。

## 直接通道与提示质量

新增 `advisor_work_discuss`：参数包含当前任务 ID、有效派单 ID、plan/clarify/review、本轮问题及可选证据。会话取自 `exec.agent.session.id`；其他会话或错误派单 ID 不能发起交流。有 profile 数据目录时注册，实际协作服务依赖挂载中的 host 服务；无可用服务时清楚拒绝，不假装完成。

- 用户为特定任务预览并授权 1–5 轮，绑定当前顾问供应商/模型、任务范围与验收条件。改变模型或任务范围需要重新授权。
- 主力调用后，答复作为该工具结果直接返回。不会额外通过 followup 重复发送同一回复；普通咨询的 return 设置不触发该路径的二次交付。
- 计划答复中的 `nextPrompt` 会进入后续交付预览，用户确认后与任务一起传给主力；原始答复没有合法结构时可作为标明待核实的普通参考。
- 专用提示词区分方案、澄清、复查，要求依据、最小改动、具体补证问题和停止无意义润色。不预设供应商，也不保证某模型实际质量或工具遵循程度。
- 顾问按 correctness / coverage / evidence 三个维度分别给 0–5 的整数或 null，并附理由。无总分、无平均分，不把未知换成 0；实施证据不足时不应给实施质量分。评分卡围栏标签按任意代码块语言匹配（`findReviewCard` 会从尾部扫描所有围栏并逐个解析 JSON + 校验），因此真实模型常用的 ```json 或 ```advisor-review 围栏都能识别；只有末尾确实缺完整评分卡（JSON 不合法、维度重复、越界、围栏未闭合）时才丢弃分数卡并保留原文供查看。
- 输出被预算截断（`max-tokens`）或超出字符上限时，只要文本里已出现完整评分卡，仍视为有效意见并解析评分（`classifyOutcome` 用 `hasCompleteReview` 兜底）；此时不会误判为 `truncated` 而丢弃分数卡。默认 `maxAdviceTokens` 为 3000，避免真实模型把评分卡截断在 JSON 中间。

## 用户可见信息

任务详情有「顾问 × 执行 Agent」区域：显示顾问目标、已用/授权轮次、当前角色、双方交流、建议改变什么、下一步要求与评分依据。可展开查看原始问答、执行方证据及实际发送的材料。交流草稿在当前页面运行时保留；关闭面板再打开不会丢失，刷新页面不持久化草稿。

评分是对当时材料的意见。新的回报到达或范围改变后，旧评价标记为过期、隐藏评分与执行要求，仅保留原文参考。交流期间的授权、范围、报告或派单改变会令返回结果失效，不能覆盖主力进展或人工决定。

暂停按钮在等待时仍可操作，终止本地等待并阻止新的协作调用；不保证供应商立即停止计费，也不终止主力已开始的操作。暂停后的迟到结果仍可留档，但不作为当前指令返回。

## 材料、额度与恢复

授权说明明确允许发送当前任务、最近报告和顾问答复的摘录，以及本轮执行方问题/证据。只使用问题和允许的补充片段，不自动采集 plan/diff/test 或其他会话。范围与验收条件完整保留，报告、逐项检查和本轮补充证据有明确摘录边界；实际发送正文保存在交流记录里。仅允许本任务交流并不代表授权外部发布、删除、扩大仓库范围等操作。

每项保留最近 20 轮交流；每次明确授权最多 5 次尝试。开始前持久化预留名额，失败/取消不自动返还任务名额，不等同供应商账单。仍受原有会话咨询额度、输出 token 限制与并发上限约束。相同请求/工具调用 ID 重放复用已有结果，不重复付费。单任务不同时启动两轮。

每轮顾问等待最多 90 秒（材料准备另有既有上限）；过期 running 记录在约 105 秒后显示等待中断，不自动重试。用户可暂停后重新决定。单宿主 JSON 文件存储的并发边界不变，不支持跨进程文件锁。重启不会自动恢复模型交流。

## 本次验证

- **166/166 逻辑测试，16/16 Chromium 浏览器场景通过，无跳过。**
- 新增 13 项逻辑用例：精确授权、计划到执行要求、真实会话/派单绑定、直接工具返回、请求幂等/轮数限制、策略/材料关闭、准备阶段暂停与撤权、回报变更导致过期、评分解析、共享预算、暂停后旧结果不可复活、长材料保留验收与检查状态、旧评分过期。
- 新增 2 项浏览器场景：授权→顾问方案→交付→执行方复查→可见评分且未自动验收；以及思考状态可见、草稿保留、等待期间可暂停。
- 浏览器运行真实客户端、RPC 与工具代码；执行 Agent 身份、DSH 槽位和模型输出由本地夹具模拟。**未接入两个真实模型，也未实测真实 DSH。**
- [桌面对话与评分](ui-review/advisor-dialogue.png) · [窄屏评分](ui-review/advisor-dialogue-mobile.png)

重现：

```sh
node --test tests/*.test.mjs
npm ci --prefix scripts/ui
# 浏览器安装：cd scripts/ui && npx playwright install chromium
npm run test:ui
# 或 DSH_UI_CHROMIUM=/absolute/path/to/chromium npm run test:ui
```

## 真实 DSH 双模型联调记录（2026-10-30）

本分支在真实 DSH 桌面环境（desktop profile，host `http://127.0.0.1:63378`）接入双模型做端到端联调，顾问模型为 `deepseek-official/deepseek-flash`。逻辑测试 **169/169** 通过。

**联调步骤（RPC 直连，等价于界面操作）**：`settings.patch`（顾问模型可连）→ `work.create`（用户提出任务）→ `discussion.preview`（展示将共享的材料）→ `discussion.enable`（用户授权，绑定 digest+revision）→ `discussion.ask plan`（梳理方案）→ `discussion.ask clarify`（主力提出真实分歧）→ `discussion.ask review`（主力提交证据、顾问评分）→ `work.list`（查看轮次与状态）。

**真实闭环已验证**：plan / clarify / review 三个阶段都返回 `state=returned` 并解析出评分卡——plan 阶段 `verdict=proceed`、实施质量维度正确地给 `null`（方案阶段无实现可评）；clarify 阶段 `verdict=revise`；review 阶段 `verdict=revise`、三维分数卡（如 correctness=null / coverage=2 / evidence=1）与具体取证要求 `nextPrompt` 都能正确解析。`work.list` 的轮次统计 `plan:returned, clarify:returned, review:returned` 与状态计数一致。

**联调发现并修复的两处真实 bug**：

1. **预算截断误丢评分卡**（`lib/consult.js` `classifyOutcome`）：原实现在 `max-tokens`（预算截断）和 `stop`+`too-long`（超字符上限）两条路径上无条件返回 `truncated`，只要发生截断就丢弃整张评分卡——即使模型已经交付了完整的 ```advisor-review 分数卡。修复：新增 `hasCompleteReview(text)`（委托给 `findReviewCard`），两条路径改为「文本中已含完整评分卡时返回 `returned`，否则才 `truncated`」。
2. **围栏标签过脆丢评分卡**（`lib/discussion.js` `parseReview` → `findReviewCard`）：原实现在状态为 `returned` 时只匹配 ```advisor-review 围栏标签；真实模型（deepseek-flash）实际把分数卡包在 ```json 围栏里，导致 `review=null`、整卡被丢弃。修复：抽出 `validateReview(value)`（校验 verdict∈{proceed,revise,blocked}、summary≤600、nextPrompt≤2400、scores 恰 3 维且互异、每维 score∈null∪整数 0..5、reason≤600 字），新增导出的 `findReviewCard(text)` 从文本尾部扫描所有代码块围栏（`/```[a-zA-Z0-9-]*\s*\n([\s\S]*?)\n```/g`），逐个 `JSON.parse` + `validateReview`，返回首个有效卡；`parseReview(text,state)` 在 `state==='returned'` 时改为委托 `findReviewCard`。`hasCompleteReview`（consult.js）随之改为 `findReviewCard(text)!==null`，删掉重复的围栏正则。

**配套改动**：`lib/settings.js` 默认 `advanced.maxAdviceTokens` 从 1000 提到 3000（1000 时真实模型常把评分卡截断在 JSON 中间）；`tests/states.test.mjs` 新增 3 条回归测试（`max-tokens` 带完整卡→`returned`、`stop` 超上限带完整卡→`returned`、半写卡无闭合围栏仍 `truncated`）。

**仍未接入/待真实宿主验收**：本轮通过 RPC 直连驱动 host 服务验证了咨询与协作的数据链路；`advisor_work_report` / `advisor_work_context` / `advisor_work_discuss` 三个工具在真实 host 已注册（`advisor_work_context` 已返回真实空队列结构）。但主力 Agent 在被 followup/inject 后**是否真正自主调用这些工具、顾问答复是否进入主力上下文并影响其后续执行**，需在隔离 profile 中用两个真实模型跑一个完整小任务来验证（见下节）。工具等待时限（顾问每轮最多 90 秒）与宿主工具超时的匹配也是联调重点。

## 真实宿主还需验收

在独立 profile 中使用不同的主力和顾问模型，完成一个可控的小任务：确认四个工具可用、工具等待时限足以覆盖顾问调用、主力能根据返回答复继续执行、轮数统计与会话额度一致、暂停可用、模型/范围改变不能复用旧授权，以及实际费用。验证真实宿主对 `followup` 和 `inject` 的行为，不能用本地模拟证明自动执行可靠性。

第一版任务闭环与其余限制见 [workflow-review.md](workflow-review.md)，进度与上下文恢复见 [continuation-review.md](continuation-review.md)。客户端与服务端须一起升级。
