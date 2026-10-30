# Claude takeover: independent review and practical product development

Prepared 2026-10-31 (Asia/Shanghai), at the owner's explicit request. This is the entry point for the next development agent. The owner wants Claude to review and continue implementation, including substantial redesign or replacement of weak components. This document is a brief and an evidence inventory, not a requirement to preserve the author's design.

## 1. Mission and authority

Build a useful daily-work partnership between an executor and a stronger advisor. Today the owner manually asks one model for strategy, turns that into an execution prompt, pastes it to another agent, brings results back for review, and repeats. The plugin should carry that work inside DSH with clear user control and visible outcomes.

The intended journey is: goal -> advisor framing and plan -> executable task brief -> executor work -> direct clarification or disagreement -> evidence-based review -> correction -> user acceptance. The advisor should improve decisions and completed work, not merely produce more commentary or flattering scores.

You are authorized to inspect, test, implement, refactor, replace modules, and redesign the settings and conversation UI. Challenge the existing architecture, prompts, defaults, and feature choices. A materially better solution may require rebuilding a subsystem. Explain what problem a replacement solves, how behavior/data migrate, how it is verified, and how it can be rolled back. Existing implementation choices are negotiable; evidence integrity, retained user work, and understandable user control remain product requirements. Do not ask the owner to reconfirm routine development choices already covered by this mandate.

Keep the product focused. Optimize strategic judgment, engineering depth, workflow coverage, and speed together. Extra agents, screens, options, and abstraction layers are not goals in themselves. Prioritize the direct advisor-executor relationship; broader project review and issue/PR assistance are later opportunities after the core loop works.

## 2. Exact source of truth

- Repository: https://github.com/qiao-obs/dsh-advisor (private).
- Integration PR: https://github.com/qiao-obs/dsh-advisor/pull/1 (open draft at handoff).
- Integration branch: `codex/advisor-review-20261029`.
- Code baseline verified before adding this handoff: `ce5d0758cc1f204e646b5134f34cce59ac1f9835`.
- Earlier implementation milestone: `55fc7c268a4bf5c7119b290cc637b4798ac89f35`.
- Subsequent DSH fixes: `c56069e34800da03a7433e97ca951d1242f1b12e`, then `ce5d0758cc1f204e646b5134f34cce59ac1f9835`.
- `main` remains `a9069e9c83c7d9cc8e746e361fd43b50796b8125`. Installing `main`/`v0.2.1` alone misses this development work. Package version remains `0.2.1`; verify commit identity, not just the version string.

Fetch current remote state before editing. The handoff commit will be newer than the code baseline above; later collaborators may also add changes. Do not reset to an old SHA. Preserve local edits. Use a clean clone/worktree when appropriate. Read repository instructions if present; do not import assumptions about the previous author's workspace.

Suggested coordination: start `claude/advisor-next` (or a unique successor) from the latest integration branch and open a draft PR targeting `codex/advisor-review-20261029`. Link it from PR #1 so other agents can follow it. If PR #1 has since merged, use current `main` after verifying the baseline is included and target `main`. Avoid simultaneous writers on the same branch; announce your branch and starting SHA in PR #1. Keep subsequent task status, review findings, commits, and blockers in GitHub. The owner should not need to relay implementation details between agents.

Do not merge or release as part of this takeover; deliver reviewable commits and a draft PR. Use ordinary pushes, fetch before publishing, and resolve new changes instead of overwriting another agent's work.

## 3. Evidence levels: do not conflate these

| Evidence | What is recorded | What it does not establish |
| --- | --- | --- |
| Prior author baseline at `55fc7c2` | 166 Node tests and 16 Chromium UI scenarios passed; actual client, RPC and tool code under a simulated host/model/identity | Real DSH scheduling, real model behavior, or measured quality gains |
| DSH contributor record at `c56069e` / `ce5d075` | 169 Node tests reported passing; real DSH desktop host with advisor `deepseek-official/deepseek-flash`; RPC-driven plan/clarify/review returned parsable scorecards | An executor independently choosing tools, consuming the reply, changing code, reporting evidence, and completing the loop |
| This handoff | Remote refs, the two new commits, their patches, PR discussion and documented limits inspected | No new live DSH/model run or fresh test-suite run performed for this documentation-only handoff |

Read [the DSH contributor's report](https://github.com/qiao-obs/dsh-advisor/pull/1#issuecomment-6526870689) and the added real-host section in [dialogue-review.md](dialogue-review.md). The report's broad "end-to-end" wording is explicitly limited by its own remaining-work section: direct RPC exercised the consultation data path; executor-driven completion remains unproven. The 16-browser result predates the latest two fixes. Re-establish your own baseline and record exact commit/environment/results.

Latest fixes accept valid scorecard JSON in different fenced block labels, preserve a complete card when the stream hits a token/length limit, increase the default advisor output allowance from 1000 to 3000, and tighten the prompt. Keep these real integration findings in view rather than accidentally reverting them.

## 4. Read and inspect

Read this file, PR #1 and comments, [dialogue-review.md](dialogue-review.md), [continuation-review.md](continuation-review.md), [workflow-review.md](workflow-review.md), [ui-interaction-review.md](ui-interaction-review.md), then README/README.en.md and the implementation. [review-v0.2.1.md](review-v0.2.1.md) and [handoff-for-review.md](handoff-for-review.md) contain older context; their old counts and limitations are historical.

| Area | Main entry points | Review focus |
| --- | --- | --- |
| Host/tool wiring | `lib/index.js`, `lib/host.js` | Actual profile/session identity, host lifecycle, four tools, RPC and executor delivery |
| Task ledger | `lib/workflow.js` | Task states, revisions, assignment identity, evidence, recovery and persistence |
| Model dialogue | `lib/discussion.js` | Task authorization, bounded attempts, direct replies, prompts, parsing, staleness and cancellation |
| Consultation/model call | `lib/consult.js`, `lib/settings.js` | Shared budget, targets, deadlines, output caps and settings migration |
| Context and suggestions | `lib/materials.js`, `lib/action-candidates.js` | Relevant sufficient evidence, truncation, context provenance and actionable tasks |
| User experience | `client/client.js`, `locale/`, `docs/ui-review/` | Conversation entry, settings, workflow visibility, feedback, recovery and accessibility |
| Verification | `tests/`, `scripts/ui/test.mjs`, `scripts/ui/server.mjs` | Behavioral regression coverage, real UI harness, limits of fixtures |

Existing tools are `advisor_consult`, `advisor_work_context`, `advisor_work_report`, and `advisor_work_discuss`. Task status and model dialogue status are separate. Current human acceptance is distinct from executor completion and advisor scoring. The advisor has no executor tool privileges. There is no verified background scheduler that automatically runs the entire loop.

Current task storage is profile-local JSON under `dsh-advisor/work/<session hash>.json`; it assumes one host writer. Existing tasks/evidence must survive upgrades. Current dialogue grants bind task scope, acceptance and model, allow 1–5 attempts, and share consultation limits. Replay, invalid assignments, stale reports, pause/unload and uncertain delivery have explicit handling. You may redesign their implementation, but preserve or deliberately improve these behavioral guarantees.

## 5. Independent audit and next implementation priorities

Start with a compact severity-ranked audit backed by file/line references and reproduction steps. Separate confirmed defects, hypotheses needing tests, product shortcomings, and design preferences. Continue from findings into implementation; the audit is not the deliverable by itself.

### P0: demonstrate useful execution

Use a bounded development task in an isolated DSH profile. Exercise the user journey and actual executor tool path, not only direct calls to user-facing RPC endpoints:

1. User supplies an objective and authorizes task collaboration.
2. Advisor produces a concrete plan, assumptions and acceptance checks.
3. Executor receives the task brief through the host's actual delivery mechanism.
4. Executor calls `advisor_work_discuss` with its real session/assignment and receives the advisor reply in its own context.
5. Executor makes a meaningful change based on that reply, or explicitly rejects it with evidence.
6. Executor reports real checks/results; advisor requests a correction or accepts the evidence as sufficient for its review.
7. User can see the material effect, outstanding uncertainty and next action, and independently accept the task.

Record commit, host/runtime versions, exact provider/model identities, sanitized tool trace, relevant diff, checks, time and available usage data. Mark unavailable cost data unknown. If a host, provider or credential is missing, identify the exact blocker and continue independent work. Development access to Claude and the plugin's runtime provider configuration are separate matters; inspect actual availability rather than assuming one configures the other. Never put credentials in GitHub.

### P1: make collaboration dependable and understandable

- Intervention: define when planning, escalation, clarification and review help; expose reason, current role and next actor. If host APIs support automatic triggers, make behavior bounded and observable. Do not claim guaranteed autonomous handoff when only prompting the model.
- Feedback loop: distinguish advice generated, delivered, acknowledged, acted on, and verified. Use actual trace/report evidence; do not infer adoption from successful delivery.
- Advice quality: require specific steps, tradeoffs, missing evidence, actionable next instructions, principled disagreement and a stopping condition. Scores need reasons and unknown values; they are not proof of quality.
- UX: inspect first use, provider setup, task initiation, conversation-level status, details, waiting, failure recovery, pause/resume and settings. Aim for restrained, polished Chinese-first interaction with consistent English support, keyboard access, narrow-window layouts and no interference with the main composer.
- Context: assess whether current short evidence excerpts let the advisor judge real work. Improve retrieval/selection/provenance and clearly expose omitted or stale information, while staying within the task's granted scope.
- Reliability: validate actual host tool deadlines, service lifecycle, busy-session followup/inject behavior, cancellation, late replies, restart recovery, duplicate dispatch, stale assignments, migration and concurrent writers where supported.
- Efficiency: use less consultation for routine work and deeper review for complex/high-impact work. Provide explicit round/time/budget stopping rules. Investigate provider-specific behavior without hard-coding one model's quirks everywhere.

### P2: extend only after measuring the core

Broaden from coding to research and document work with appropriate evidence and acceptance criteria. Explore cross-project reviews and GitHub issues/PR assistance if they materially reduce the owner's workload. Tie every extension to an actual user journey and verification. Do not build a sprawling orchestration platform just to appear ambitious.

### Concrete hypotheses to investigate, not pre-established defects

- The new prompt says placing a scorecard last ensures it survives truncation; verify that claim under genuinely constrained output. Compare concise structured-first or other robust formats if needed.
- `classifyOutcome` now recognizes a scorecard across the common consultation path. Verify generic consultations retain correct truncation semantics, incomplete surrounding advice remains visible as incomplete, and the card used for classification is still available in persisted/rendered/tool-returned output after downstream clipping.
- More permissive fenced JSON parsing needs cases for invalid trailing cards, multiple conflicting cards, quoted examples, unknown labels, incomplete JSON and false positives. Passing an existing test count is not evidence these cases are covered.
- Raising a default may not update an already-saved 1000-token setting. Check migration, user intent, visible configuration and actual effective runtime values.
- UI status must reflect real lifecycle events rather than imply the advisor has taken over the executor's tools. Check host availability when the panel is closed or a profile/session changes.

## 6. Evaluation: ambition with observable results

Use a small repeatable task set: a straightforward fix, an ambiguous requirement, and a failing/regressing change. Compare executor-only and advisor-assisted runs where feasible under recorded conditions. Do not promise statistical certainty from a few examples.

Measure: accepted task outcome, independently checked criteria, useful defects caught (and false alarms), human copy/paste or intervention count, time to useful action/completion, advisor rounds, available token usage/cost, and whether users can identify who is acting and what to do next. Also inspect cancel/error/restart paths. Optimize improved completed work per unit of user effort, time and cost; do not use the advisor's self-assigned score as the success metric.

## 7. Reproduce and deliver

Inspect `package.json` and current instructions first. Current Node requirement is `^22.19.0 || >=24.0.0`; DSH engine is `^0.2.0-rc.1`. The baseline commands are:

```sh
node --test tests/*.test.mjs
npm ci --prefix scripts/ui
# Install the browser from scripts/ui with: npx playwright install chromium
npm run test:ui
# An existing browser can be selected with DSH_UI_CHROMIUM.
npm pack --dry-run
```

Use your platform's environment-variable syntax; the previous workspace's absolute Chromium path is not portable. Test meaningful changed behavior, run relevant regressions, inspect desktop/narrow-window screenshots and real DSH layout when available. Do not weaken tests just to preserve a green count; update obsolete implementation-specific assertions when replacing behavior, with a clear explanation.

Keep the following reviewable in your branch and PR:

- `docs/claude-review.md`: severity-ranked findings, evidence, design decisions, and fixed/deferred status.
- `docs/claude-validation.md`: exact tested SHA/environment, commands/results, real versus simulated evidence, screenshots/traces and limitations.
- `docs/next-agent-handoff.md`: current branch/PR/commit, completed work, remaining priorities, blockers, reproduction commands, and the next concrete action.
- Updated installation/configuration guidance and migration notes where behavior changes.

Post a concise completion/progress comment linking these files and your commits in PR #1. Use GitHub as the durable task record, so the next agent can continue without the owner transporting large chat histories. Reports to the owner should be in clear Chinese. Leave the review in draft until its stated acceptance criteria are met; no merge or release is requested.

## 8. Handoff status

This handoff adds documentation only. No runtime code, model/provider settings, release tags or `main` changes are part of it. Claude's next action: fetch the integration branch, read its latest discussion, establish the baseline, publish the independent findings and implement the highest-impact improvements.

The owner's English kickoff message and Chinese translation are in [claude-kickoff.md](claude-kickoff.md).
