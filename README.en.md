# DSH Advisor

> Ask a second model one question — when the working session is not sure. One
> tool. It stays silent until it is called.

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

## Desktop edition (v0.2)

v0.1 was a tool only. v0.2 makes it a desktop plugin you can look at. Four things
stay visible at all times: **why a consultation happened, who is being asked,
what was sent, and what the opinion changed.**

### 1. Settings (Settings → Advisor)

It reuses the host settings system rather than shipping its own page:

| Block | Content |
| --- | --- |
| **Enable the advisor** | Master switch, on by default. When off, the composer entry, the card and the header chip all disappear, `consult.start` is refused (`reason:'disabled'`) and **no model request is ever made**; stored consultations stay readable. |
| Status | No model / **usable** / misconfigured. **"Usable" only means it can run, not that it is running.** It also shows the model that would actually be used. |
| Mode | Only when I ask (default) / after the model suggests it, I confirm / authorised for this session. The last two need one explicit grant; after that there are no repeated prompts. |
| Advisor model | Follow the session model by default, or pick a provider + model from the host's real catalogue. |
| Material scope | This question / selection / current plan / current changes / test output, toggled per item. **The full text can be previewed before sending.** |
| Delivery | Show to me only / return to the working model for verification. |
| Advanced | Advice token ceiling, per-consultation timeout, per-session call cap, per-session record retention. |
| Connection check | **A request is only sent when the user presses it** — an 8-token ping that reports the actual model and round trip. |

### 2. In-session entry

A "consult" button at the left of the composer. Consulting with a code selection
focuses on that selection by default; the whole history is not silently attached.
The confirm area expands in place above the composer with the subject, the model,
a material summary, and "preview / start / cancel".

### 3. Visible progress

A collapsible in-session card whose states all come from real events — **no
invented percentage**. It sits below the composer, so it starts **collapsed to a
single summary line** (state + first 30 characters of the question) and caps
itself at `38vh` with internal scrolling when expanded, instead of pushing the
conversation off screen:

`awaiting confirmation` → `request sent (waiting N s · cancel)` → `returned` /
`cut off — incomplete advice` / `the advisor raised nothing new` / `timed out` /
`failed` / `cancelled`

A low-noise chip in the session header: `Advisor: manual`, `Advisor working`,
`2 consultations in this session`.

Every terminal state carries a caveat that only claims what the evidence
supports:

- cut off → "The text is kept but the ending is missing; do not read it as a complete review."
- nothing new → "This does not mean the task was verified."
- cancelled → "This only ended the local wait; it is not evidence that the provider stopped generating."
- failed → the provider's real reason (for example `UNKNOWN_MODEL pi-ai provider "llmgo" has no configured model "no-such-model-v0"`).

### 4. Result surface

A one-or-two-line conclusion first, the full opinion and its evidence on expand.
Each finding answers four things: **what is wrong / what the evidence is (and which
part is an assumption) / how to verify it / whether it widens the scope.**

Actions: `have the model verify` / `mark handled` / `the model says it does not
hold` / `leave it for now` / `view the raw opinion`. There is deliberately **no
vague one-click accept.**

Three facts are recorded separately instead of collapsing into "accepted":

- `verification`: unconfirmed / confirmed by the model / rejected by the model / inconclusive
- `disposition`: none / handled per the advice / deferred
- `delivered` / `not delivered`

**Rejecting an opinion after checking it is a successful outcome** — it proves the
advice was read and judged.

### 5. Material version binding

Each consultation stores a content digest (`sha256:`, first 32 hex chars) of the
paths it actually sent. When the card is shown again, only those paths are
re-hashed; if one moved it says

> Based on an older version — needs re-checking
> Changed materials: D:/DeepSeekHarness/工作区/.tmp/staleness-probe.txt

Not the whole workspace: hashing everything would flag "changed" whenever anything
anywhere moved, which trains people to ignore the marker.

### 6. History and session isolation

"History (N)" on the card replays every record of this session, newest first.
Records live in `<DSH_HOME>/dsh-advisor/sessions/<sessionId>.json` — **one file
per session**, so switching sessions cannot mix them. Settings live in
`<DSH_HOME>/dsh-advisor/settings.json` and survive a restart; with the plugin off
there are no automatic calls at all (there were none to begin with).

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

## The tool

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

Three suites, all offline — no provider, no network, no cost:

| File | Covers |
| --- | --- |
| `tests/plugin.test.mjs` | registration surface, call discipline, budget, cancel/timeout/unload, unconfigured mount, delivering a truncated answer |
| `tests/advice.test.mjs` | the advice protocol, the real regression corpus, usage classification |
| `tests/config.test.mjs` | config precedence, manifest and patch self-consistency |
| `tests/materials.test.mjs` | material collection: current plan vs. an old todo list, over-budget truncation, reproducibility, unreadable means "absent with a reason", settings and explicit opt-out win |

99 tests, all green. **The UI has no automated tests**: v0.2 was accepted by
clicking through it in the real desktop app, on the grounds that the plugin's
states come from host events and a fake DOM can only assert against the mock you
just wrote. The acceptance record is in `docs/acceptance-v0.2.md`.

## Known limitations

- **The tested environment is the DSH desktop app** (profile `desktop`, host
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
