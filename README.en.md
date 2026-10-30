# DSH Advisor

> Bring a second opinion into everyday work: scoped tasks, execution reports, evidence, and human acceptance.

[中文](./README.md) · **English**

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9.svg?style=flat-square)
![Node >=22](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?style=flat-square)

---

## What it is

`dsh-advisor` gives a DeepSeek Harness session **a second point of view**: pick a
model and a material scope in the settings page, press "consult the advisor" in
the composer, and send **one specific decision** to a second model — while
keeping visible the whole way who was asked, what was sent, and what the opinion
actually changed.

Two entry points share the same state and the same records:

- **The person in the session**: the "consult" button in the composer opens a
  lightweight confirm area (subject / model / materials / preview), and the answer
  lands in a collapsible in-session card. You never leave the conversation.
- **The working model**: one tool, `advisor_consult`. The model that is already
  working can call it to send the same decision out.

It is not an automatic reviewer and not a gate in a pipeline:

- **Nothing fires on its own.** No timer, no call per step, no second-round
  follow-up. One consultation is one plugin-initiated model call, which is what
  makes the cost attributable.
- **No provider is baked in.** It follows the session's current model by default;
  installing a plugin should not send a session's content to a provider the user
  never chose.
- **"Don't change anything" is a valid answer.** "No new advice" only means this
  round found nothing new — **it does not mean the task was verified.**

## Direct advisor–executor dialogue (development branch)

Choose the advisor model in settings, then authorize 1–5 exchanges for one task. Ask the advisor for a plan; its executor brief is included in the assignment preview. Once assigned, the working model can call `advisor_work_discuss` to plan, clarify disagreement or review evidence. Replies return directly as tool results, while the user sees both sides in the task workspace.

The panel shows the current role, proposed changes, next instructions, and evidence-backed subjective ratings for correctness, acceptance coverage and evidence quality. Unknown ratings remain null; ratings never establish acceptance. Pause stops new advisor exchanges and local waiting, not work the executor has already begun. Task/model changes require a fresh grant, and both task round limits and the existing consultation budget apply.

This is bounded, executor-initiated tool dialogue, not unattended scheduling. The executor must actually call the tool; the initial assignment still requires user confirmation. Real DSH dual-model execution is not yet validated. See [dialogue implementation and acceptance](docs/dialogue-review.md).

## Work loop (development branch)

The conversation workspace now supports **opinion → scoped task → confirmed assignment → execution report → recheck → human acceptance**. This is a development-branch feature, not part of the `v0.2.1` tag.

- Manual consultations can propose up to three actions in the same response. Edit scope, priority and acceptance criteria before creating a task. Existing free-text opinions and direct task creation also work.
- Preview the exact task package before handing it to the current session's working model. `advisor_work_report` records changes, actual checks and blockers. Delivery is not completion; reported completion only means awaiting review.
- Long tasks can save meaningful progress checkpoints, next steps and per-check evidence. `advisor_work_context` restores only the invoking session’s queue or task details. Reassignment includes the latest human decision and explicitly historical report.
- Recheck with the advisor through the usual material preview and explicit confirmation. Only a human decision with evidence records acceptance.
- Search and filter tasks, reopen work, use review, research and document-handoff presets, and export Markdown. Original opinions, reports and human decisions survive clearing consultation history.
- Tasks persist separately at `<DSH_HOME>/dsh-advisor/work/<SHA-256-of-session-ID>.json`. Ambiguous deliveries are never automatically retried.

Organizing tasks does not call a model. Dispatch can incur normal host model/tool costs; advisor rechecks consume separate consultation calls. This is a session-local work loop, not a cross-project scheduler. See [implementation, screenshots and host acceptance requirements](docs/workflow-review.md).

## Desktop edition (v0.2)

v0.1 was a tool only. v0.2 makes it a desktop plugin you can look at. Four things
stay visible at all times: **why a consultation happened, who is being asked,
what was sent, and what the opinion changed.**

### 1. Settings

Settings are grouped by model, calling policy, material scope and delivery. Use **Save changes** to apply edits or **Discard changes** to restore the saved values. The master switch and session permission apply immediately. Connection checks use saved settings and are disabled while edits are pending.

| Section | Behavior |
| --- | --- |
| Enable | Hide conversation surfaces and refuse new consultations when off. Retain history; existing requests are not automatically cancelled. |
| Model | Follow the host’s current selection or choose a dedicated provider and model. Incomplete selections never fall back to a different model. |
| Policy | Manual only / Ask each time / Allow automatic calls. Automatic mode applies across sessions. Manual mode can grant one session a temporary exception for up to 24 hours. |
| Materials | Always include the question. Control excerpts, plan, changes and test output, then narrow the scope for each consultation. |
| Delivery | Show only or send to the working model. Delivery does not mean verification. |
| Advanced | Token limit, wait limit in seconds, session allowance and history retention. A wait limit or allowance of zero means unlimited. |
| Connection check | Explicitly sends a real model request and reports the result and elapsed time. |

### 2. Question → preview → confirmation

Use the composer’s consult button, write a specific question, choose a review focus and optionally paste an excerpt. The next step shows the exact material text, target model and missing/truncated/earlier-turn warnings without calling the advisor. Only **Confirm and send** starts a consultation. Editing requires a fresh preview. If materials or the model change before sending, the host refuses the request and the question remains available to revise.

### 3. Conversation workspace

The header entry displays active consultations or opinions awaiting review. Open the workspace to read the full opinion, materials, actual state and errors. Its body scrolls independently. Cancel, copy and ask again are available as appropriate. Truncation, no advice, timeout, failure and cancellation remain distinct; no simulated progress is shown.

Cancelling ends the local wait, without proving the provider stopped. No advice does not mean the task was verified.

### 4. Separate review form

**Ask the model to verify** sends the opinion to the working model. **Record a review** opens a form within the card for the assessment, disposition and supporting evidence. Non-pending assessments require evidence. Human annotations use “Marked valid/invalid” rather than claiming the working model verified them, and never consume the main composer’s draft.

Verification, disposition and delivery are independent facts. Unsaved review text survives closing and reopening the panel in the current page runtime.

### 5. Materials and history

Records retain material digests and file fingerprints; changed materials are marked for re-checking. Search questions, opinions or models, or filter by review status. Refreshing while reading an older opinion keeps that record selected.

History is stored per session at `<DSH_HOME>/dsh-advisor/sessions/<sessionId>.json`; settings are stored at `<DSH_HOME>/dsh-advisor/settings.json`. Clearing history requires confirmation, retains usage counts and does not cancel active requests. Drafts are retained only within the current page, not across reloads.

See the [interaction validation report](docs/ui-interaction-review.md) for screenshots, nine browser scenarios and the remaining real-host verification boundary.

## Install

Requires Node `^22.19.0 || >=24.0.0` and DSH `^0.2.0-rc.1`.

```sh
# DSH Studio desktop app and Web CLI take the same command; name your profile
dsh plugin --profile web add github:qiao-obs/dsh-advisor
```

Replace `web` with the profile you use (the desktop app's is usually `desktop`).
Restart DSH and reload the page afterwards.

Pin a version:

```sh
dsh plugin --profile web add github:qiao-obs/dsh-advisor#v0.2.1
```

Install from a local directory:

```sh
dsh plugin --profile desktop add file:D:/path/to/dsh-advisor
```

Remove:

```sh
dsh plugin --profile web remove dsh-advisor
```

Then open **Settings → Advisor**, choose the advisor model (following the session
model is usually right), and use the "consult" button in the composer.

Pin a version:

```sh
dsh plugin --profile web add github:qiao-obs/dsh-advisor#v0.1.1
```

Remove:

```sh
dsh plugin --profile web remove dsh-advisor
```

### Version compatibility

`engines.dsh` is `^0.2.0-rc.1`. The host evaluates it with
`semver.satisfies(runtime, range, { includePrerelease: true })` and rejects the
install with `incompatible-version` when it does not hold. To wave it through:

```sh
dsh plugin allow-version dsh-advisor@0.2.1 --profile web
```

## Configuration

**Since v0.2 the everyday settings need no file editing**: what you change under
Settings → Advisor is persisted to `<DSH_HOME>/dsh-advisor/settings.json` and
survives a restart.

`cordis.patch.yml` keeps the install-time defaults and the tool-side budget:

```yaml
- insert:
    - id: dsh-advisor
      name: dsh-advisor
      config:
        maxAdviceTokens: 1000         # output cap per consultation (~4000 chars)
        maxConsultationsPerRun: 8     # hard ceiling on consultations for this run
        consultDeadlineMs: 60000      # total budget for one consultation
        authorizedScopes: [plan, diff, test, general]
        injectAdvice: true            # false = pay for the call, withhold the text
        outputDir: null               # null = write no records
```

**`provider` / `model` are unset by default.** Setting them pins the model;
leaving them unset means the session's current default is used. That trade is
deliberate: installing a plugin should not send a session's work to a provider
its user never picked.

Two layers, no overwriting:

| Layer | Governs | Changed by |
| --- | --- | --- |
| `settings.json` | advisor model, material scope, mode, delivery, timeout / caps / retention | the user, in the settings page |
| `cordis.patch.yml` / env | install defaults, tool-side budget and consent, run record directory | whoever installs it |

### Environment variables

The same keys are accepted from the environment. Precedence: plugin config >
context config > environment.

| Variable | Field |
| --- | --- |
| `ADVISOR_PROVIDER` | `provider` |
| `ADVISOR_MODEL` | `model` |
| `ADVISOR_MAX_ADVICE_TOKENS` | `maxAdviceTokens` |
| `ADVISOR_MAX_CONSULTATIONS` | `maxConsultationsPerRun` |
| `ADVISOR_DEADLINE_MS` | `consultDeadlineMs` |
| `ADVISOR_AUTHORIZED_SCOPES` | `authorizedScopes` (comma separated) |
| `ADVISOR_INJECT_ADVICE` | `injectAdvice` (only `false` turns it off) |
| `ADVISOR_OUTPUT_DIR` | `outputDir` |
| `ADVISOR_RUN_ID` | `runId` |

An empty string counts as unset. **A value that does not parse is dropped, not
written as `undefined`** — an explicit `undefined` wins over the default in
object spread, and that is how a ceiling silently stops existing.

## Tools

With profile storage available, the plugin registers `advisor_consult`, `advisor_work_report`, read-only `advisor_work_context`, and task-authorized `advisor_work_discuss`. The context tool restores the current session’s queue or a selected task without dispatching anything. The report tool accepts a user-dispatched task ID, assignment ID, outcome, summary and evidence, and uses the host's actual execution session. Progress reports require a concrete next step; optional checks carry reported passed/failed/not-run states with evidence. The context and report tools cannot dispatch work, call the advisor or mark human acceptance. Without profile storage only the original consultation tool is registered.


```jsonc
{
  "name": "advisor_consult",
  "parameters": {
    "question": "The one decision to review. Say what you are about to do, and why.",
    "focus": "plan | diff | test | general",
    "deadlineMs": "Optional budget for this consultation"
  },
  "required": ["question"]
}
```

Returns `{ outcome, consultationId, advice, cancelled, timedOut, adviceWithheld, truncated, budgetRemaining }`.

`outcome` is one of:

| Value | Meaning |
| --- | --- |
| `advised` | usable advice came back (**including advice cut off by the output budget** — see `truncated`) |
| `no_advice` | the advisor answered `NO_ADVICE`; that is a normal completion |
| `refused_no_consent` | this `focus` was not pre-authorized and there is no human seam (headless). **No request was issued** |
| `budget_exhausted` | the run ceiling was reached. **No request was issued, nothing was spent** |
| `failed` | not configured, the stream ended with `aborted`/`error`, cancelled, timed out, or unusable content |

`cancelled` and `timedOut` are reported separately and never impersonate each
other: a caller cancelling is not a timeout, and a timeout is not a cancel.

`truncated` is reported on its own: `true` means the advisor hit its output
budget (`finish.kind === 'max-tokens'`) mid-answer. **`advice` still holds the
part it actually said** — not a character is dropped — and the caller should
treat the end as missing, not as its conclusion. It is not `failed` because
being cut off says nothing about whether there was anything to say.
`aborted`/`error` still end as `failed`: there is no "how far it got" to keep.

### Consent

`authorizedScopes` is the pre-authorized list of `focus` values. Values on the
list pass straight through; anything else goes to the host's `userQuestions`
seam to ask a human.

A headless host has no `userQuestions`, so an unauthorized `focus` always ends as
`refused_no_consent` with **no request issued**. That is also why the tool schema
advertises only the focuses this run can actually reach: offering an option that
consent will always refuse is a trap, not a consent check.

### Records

Only written when `outputDir` is set, into `<outputDir>/<runId>/`:

- `advisor-events.jsonl` — one line per decision point (budget refusal, consultation returned)
- `advisor-calls.jsonl` — one completion record per consultation

**Records contain no advice text**, and deliberately no full question text (only
its length). They answer "why was this made and what did it cost", not "what did
it say". Three facts about usage are kept apart:

- `usageRaw` — the numbers as received; a zero stays a zero
- `usageCompleteness` — `complete` / `partial` / `missing`
- `usageOrigin` — `unknown` / `provider-reported` / `adapter-default` / `adapter-estimated`

`unknown` is the default. The kernel's `TokenUsage` carries no provenance field,
so a reading that arrives through it has no evidence attached *by construction*;
"completed with content" is not proof the provider reported the numbers.
**An unknown price is not treated as zero.**

## Tests

```sh
npm test
```

Logic tests are offline — no provider, no network, no cost. Main coverage:

| File | Covers |
| --- | --- |
| `tests/plugin.test.mjs` | registration surface, call discipline, budget, cancel/timeout/unload, unconfigured mount, delivering a truncated answer |
| `tests/advice.test.mjs` | the advice protocol, the real regression corpus, usage classification |
| `tests/config.test.mjs` | config precedence, manifest and patch self-consistency |
| `tests/materials.test.mjs` | material collection: current plan vs. an old todo list, over-budget truncation, reproducibility, unreadable means "absent with a reason", settings and explicit opt-out win |

| `tests/workflow.test.mjs` | durable tasks, assignment deduplication, timeout/unload, session isolation, reports, human acceptance, revision conflicts, rechecks and action candidates |

**166/166** logic tests and **16/16** Chromium scenarios pass. Browser scenarios run real client components and RPC handlers with a simulated host and fake model. See [dialogue validation](docs/dialogue-review.md) for reproduction and limitations. The older real-desktop acceptance record in `docs/acceptance-v0.2.md` does not verify this branch's new work loop.

## Known limitations

- The new assignment, reporting tool and recheck workflow still need validation in a real DSH profile.

- **The older release was tested in the DSH desktop app** (profile `desktop`, host
  0.2.1-rc.3). Web CLI and headless share the same client bundle but have not
  been walked through item by item there.
- **The tool-side `userQuestions` consent branch still has not run on a real
  host**: what is covered is the "no seam → refuse" half. The v0.2 user-side
  consultation takes a different path (the user presses "start" in the confirm
  area) and does not depend on that seam.
- **There is no real pricing.** The host returns `NO_COST`
  (`{input:0,output:0,...}`) for providers it does not know; that is the absence
  of a fact, not a rate. The plugin therefore reports tokens and never money, and
  never turns an unknown into a zero.
- **`NO_ADVICE` is not followed up automatically.** If the advisor says there is
  nothing to say, the consultation ends; sending more material is an explicit act
  by the user or the working model.
- **A cut-off answer is half an answer.** Hitting `maxAdviceTokens` (default
  1000, ~4000 characters) still returns the text and sets `truncated`, but the
  end is missing. The card says "cut off — incomplete advice" for exactly that
  reason.
- **No retries.** A failed request is `failed`; whether to try again belongs to
  the user or the working model.
- **`injectAdvice: false` still costs money**: it performs the call and withholds
  the text, which exists to measure cost in isolation.
- **Cancel and timeout share a `cancelGraceMs` window** (default 300 ms): after a
  deadline the stream gets a moment to end itself; if it does not, the
  consultation is `timed-out` and `waitEndedAs` records how the wait ended.
- **Version binding only covers the paths that were actually sent.** Editing a
  file that was never part of the materials will not mark the card stale — which
  is correct, and easy to misread as "everything is watched".
- **"Based on an older version" never re-runs anything.** It only marks; asking
  again is a human decision.

## Design notes

The code comments carry the reasoning per decision. Four of them shape behaviour:

1. **The tool is registered, never scheduled.** Automatic consultation makes cost
   unattributable and turns "ask again" into a default action.
2. **No provider is chosen.** See `provider` above.
3. **Consent is a hard gate, not a warning.** If consent cannot be obtained, no
   request is issued — rather than issuing one and apologising later.
4. **Don't infer; say you don't know.** Usage provenance, timeout versus cancel,
   and whether text is usable are each decided on directly observable evidence.

## Provenance and licence

MIT, see [LICENSE](./LICENSE).

The core (`lib/advisor.js`) started as a probe: it existed to find out what DSH's
`llm` / `tools` services and consent seam actually permit, using offline fixtures
and real calls, and every rule in it is something a measurement forced. Comments
marked `mNNNNN` point at an entry in that development record; they are kept so a
rule can be traced to the observation that produced it, and reading the code does
not require them. The published package has no runtime dependency on that record:
no code path reads it.

`tests/fixtures/advice-regressions.json` holds three real advisor responses that
the old sentence-counting rule rejected wholesale. They are kept because **a
parser change should be judged on the text that actually broke it, not on a
hand-written imitation.** Their content discusses a hypothetical log-masking
function and contains no credentials, host names, or user data.
