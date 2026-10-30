# Claude kickoff / Claude 接手提示词

## English — send this to Claude

Take ownership of the independent technical review and continued development of my DSH advisor plugin. GitHub is already signed in on this machine. Work directly in the repository and use GitHub for handoffs; I do not want to keep copying plans, prompts and results between agents.

Repository: https://github.com/qiao-obs/dsh-advisor
Current integration PR: https://github.com/qiao-obs/dsh-advisor/pull/1
Integration branch: `codex/advisor-review-20261029`
Start here: `docs/handoff-to-claude.md` on that branch, then read PR #1 and its comments. Fetch the latest branch; do not start from the old `main` or `v0.2.1` alone. Preserve newer commits and any local work.

My goal is a daily-use partnership: the advisor frames problems, develops plans and executable instructions, discusses questions and disagreements directly with the executor, reviews actual evidence, and helps it improve the result. I should see when and why the advisor intervenes, who is acting, what changed because of its advice, and when my decision is needed. Reduce my manual coordination while improving the quality of completed work.

Be independent and ambitious. Evaluate the product across strategy, engineering depth, workflow coverage, interaction design, reliability, speed and cost. You are authorized to improve, refactor, redesign or replace weak components—including a substantial rebuild when justified. Do not preserve mediocre work merely because another agent wrote it. Explain major decisions, retain user data through migration, and verify the new behavior. Aim for an excellent, coherent product; do not equate ambition with feature count.

Begin with an evidence-backed audit, establish a reproducible baseline, then implement the highest-impact improvements. Do not stop at an assessment or roadmap. Investigate actual host integration, model dialogue, evidence sufficiency, useful intervention triggers, settings and conversation UX, failure recovery, and measurable advisor impact. You may challenge every existing implementation choice.

Read the validation boundaries carefully: the latest DSH contributor reports 169 passing Node tests and real-host RPC-driven advisor exchanges. Earlier browser coverage had 16 passing simulated-host scenarios. A genuine executor-driven loop—receiving a task, calling the advisor, acting on its reply, reporting evidence and reaching user acceptance—still needs verification. Test that actual path when the environment supports it; never label simulated or manually driven RPC tests as autonomous two-model completion. Record exact blockers and continue unblocked work.

Use a dedicated branch from the latest integration branch and a linked draft PR, following the handoff's coordination instructions. Commit and push reviewable changes; keep findings, validation and next-agent instructions in GitHub. Routine development is already authorized. Do not merge or release yet.

Report to me in English: what you found and changed, what was genuinely tested, how the advisor improved execution, remaining limitations, how I can try it, and the commit/PR links. Start by inspecting the repository and environment, then proceed with implementation.

## 中文译文

请接手我的 DSH 顾问插件，负责独立技术审查和后续开发。这台电脑已经登录 GitHub。请直接操作仓库，通过 GitHub 交接任务；我不希望继续在不同 Agent 之间复制计划、提示词和结果。

仓库：https://github.com/qiao-obs/dsh-advisor
当前集成 PR：https://github.com/qiao-obs/dsh-advisor/pull/1
集成分支：`codex/advisor-review-20261029`
先阅读该分支的 `docs/handoff-to-claude.md`，再阅读 PR #1 及评论。拉取最新分支，不要仅从旧 `main` 或 `v0.2.1` 开始。保留后续提交和本地已有工作。

我的目标是形成可以日常使用的协作关系：顾问帮助界定问题、制定方案和执行指令，与执行 Agent 直接讨论疑问与分歧，审查真实证据，并帮助执行方改善结果。我应能看到顾问何时、为何介入，现在谁在处理，它的意见带来了什么变化，以及什么时候需要我决策。在提高最终完成质量的同时，减少我的人工协调。

请保持独立判断，并有足够的野心。从战略、工程深度、工作流覆盖、交互设计、可靠性、速度和成本多个维度评估产品。你有权优化、重构、重新设计或替换质量不足的部分，有充分理由时也可以大幅推倒重建。不要因为代码由另一个 Agent 编写，就迁就一般水平的实现。解释重大决策，通过迁移保留用户数据，并验证新行为。目标是优秀且完整一致的产品，不要把野心等同于功能数量。

先做有证据支持的审查，建立可复现的基线，然后实施收益最大的改进。不要停留在评价或路线图。重点检查真实宿主集成、模型之间的交流、证据是否充分、有效的介入时机、设置与对话界面体验、失败恢复，以及顾问带来的可衡量改善。你可以质疑任何现有实现选择。

仔细阅读验证边界：最新 DSH 开发者报告了 169 项 Node 测试通过，以及真实宿主中由 RPC 驱动的顾问交流；此前还有 16 个模拟宿主的浏览器场景通过。真正由执行 Agent 驱动的完整链路——收到任务、调用顾问、依据回复行动、回报证据、到达用户验收——仍需验证。环境具备时，请测试这条真实路径；不要把模拟测试或人工驱动的 RPC 测试描述为双模型自主完成任务。准确记录阻塞项，并继续推进不受阻塞的工作。

按照交接文档的协作规则，从最新集成分支建立独立开发分支，并创建关联的草稿 PR。提交并推送便于审查的改动，把发现、验证和下一位 Agent 的接续说明留在 GitHub。常规开发已经获得授权。暂时不要合并或发布版本。

请用英文向我汇报：发现和修改了什么，实际验证了什么，顾问如何改善了执行，还有哪些限制，我怎样体验，以及提交和 PR 链接。现在先检查仓库与环境，然后直接推进实现。
