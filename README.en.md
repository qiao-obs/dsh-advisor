# DSH Advisor

> Ask a second model one question — when the working session is not sure. One
> tool. It stays silent until it is called.

[中文](./README.md) · **English**

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9.svg?style=flat-square)
![Node >=22](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?style=flat-square)

---

## What it is

`dsh-advisor` adds one tool, `advisor_consult`, to a DeepSeek Harness session.
The model that is already working can call it to send **one specific decision**
to a second model and get an opinion back.

It is not an automatic reviewer and not a gate in a pipeline:

- **Nothing fires on its own.** No timer, no call per step, no second-round
  follow-up. One tool call is one plugin-initiated model call, which is what
  makes the cost attributable.
- **No provider is baked in.** The plugin does nothing until the working model
  calls it, and then it consults **the model this session already selected**.
- **"Don't change anything" is a valid answer.** The most useful thing an
  advisor does is often to give a reason to stop, not a reason to keep going.

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
dsh plugin allow-version dsh-advisor@0.1.1 --profile web
```

## Configuration

It works as installed: with no `provider` set, the plugin reads the session's own
default model.

To change behaviour, edit `cordis.patch.yml` in the profile (under
`~/.dsh/profiles/<name>/`):

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

## Known limitations

- **The full chain has only been exercised on a headless host.** The web and
  desktop-app surfaces are untested.
- **The `userQuestions` consent branch has never run on a real host**: headless
  has no such service, so what is covered is the "no seam → refuse" half.
- **There is no real pricing.** The host returns `NO_COST`
  (`{input:0,output:0,...}`) for providers it does not know; that is the absence
  of a fact, not a rate. The plugin therefore reports tokens and never money, and
  never turns an unknown into a zero.
- **`NO_ADVICE` is not followed up.** If the advisor says there is nothing to
  say, the consultation ends.
- **A cut-off answer is half an answer.** Hitting `maxAdviceTokens` (default
  1000, ~4000 characters) still returns the text and sets `truncated`, but the
  end is missing: the sentence that was going to qualify everything before it
  may be exactly what the budget removed. The first real consultation after a
  clean install hit this — the old 400-token default threw away 1776 characters
  of usable advice. Nothing is thrown away now, but "not finished" is still
  something only the caller can handle.
- **No retries.** A failed request is `failed`; whether to try again is the
  working model's decision, not the plugin's.
- **`injectAdvice: false` still costs money**: it performs the call and withholds
  the text, which exists to measure cost in isolation.
- **Cancel and timeout share a `cancelGraceMs` window** (default 300 ms): after a
  deadline the stream gets a moment to end itself; if it does not, the
  consultation is `timed-out` and `waitEndedAs` records how the wait ended.

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
