# Instagram Creator OS

Turn a raw content idea into several structurally distinct hook options plus a full
Instagram Reel script — written in **your** voice, not a dropdown "tone".

> **Status: Phase 2 (voice profile).** The app boots, the LLM seam is in place
> behind a provider-agnostic interface, and the smoke test and Layer-1 eval both
> run green offline. The voice profile — schema, storage and trait distillation —
> now exists and is documented below. The idea → hooks + script generator itself
> lands in Phase 3; see `.factory/strategy/current.md` for the full build plan.

---

## Quickstart (under 5 minutes, no API key needed)

Requires **Node 20+** (developed on Node 26) and npm.

```bash
git clone <this-repo> && cd instagram-creator-os
npm install
cp .env.example .env      # optional — the defaults already work
npm run dev
```

Open <http://localhost:3000>. You should see the app reporting its resolved
provider and model. The health endpoint is at
<http://localhost:3000/api/health> and returns:

```json
{ "ok": true, "provider": "mock", "model": "mock-fixture-model" }
```

**No `ANTHROPIC_API_KEY` is required.** With no key present the app resolves to
the deterministic `mock` provider, which serves fixture responses from
`fixtures/llm/` with zero network calls. Every command below — build, tests,
smoke test, eval — passes on a clean checkout with no credentials.

### Verify everything works

```bash
npm run typecheck    # tsc --noEmit, strict mode
npm test             # vitest
npm run build        # next build --turbopack
npm run smoke        # build + start + assert /api/health responds
npm run eval         # Layer-1 deterministic eval, emits JSON on stdout
```

The production build runs on **Turbopack** (`next build --turbopack`). The
webpack builder was observed crashing non-deterministically during content
hashing (`TypeError: Cannot read properties of undefined (reading 'length')` in
webpack's `WasmHash`), which took down `npm run smoke` and `npm run eval` with
it. Turbopack does not use that code path. The webpack builder is still
reachable as `npm run build:webpack` for comparison/debugging.

---

## Using the real Anthropic API

Put a key in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5
```

Never commit a populated `.env` — it is gitignored, and `.env.example` is the
committed template.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | *(unset)* | Anthropic credential. Absent ⇒ mock provider. |
| `LLM_PROVIDER` | `mock` | `anthropic` or `mock`. `anthropic` without a key falls back to `mock` with a warning rather than crashing. |
| `LLM_MODEL` | `claude-sonnet-5` | Model for the Anthropic adapter. Ignored by the mock. |

---

## Project layout

```
app/                     Next.js 15 App Router — UI and API routes
  api/health/route.ts    {ok, provider, model}
lib/llm/
  types.ts               LlmAdapter contract: generateStructured<T>()
  index.ts               getAdapter() / resolveProvider() / resolveModel()
  errors.ts              Typed errors (LlmRefusalError, LlmConfigError, ...)
  probe.ts               Tiny structured request used by tests and the eval
  adapters/anthropic.ts  Official @anthropic-ai/sdk, structured output
  adapters/mock.ts       Deterministic fixture responses, zero network
lib/voice/
  store.ts               load/save/validate data/voice-profile.json
  distill.ts             One structured call: samples → distilled traits
  banned.ts              Case/punctuation-insensitive banned-phrase matching
types/voice.ts           Zod voice-profile schema (10-example hard cap)
data/                    voice-profile.example.json (committed seed)
fixtures/llm/            Mock adapter fixtures, keyed by request kind
scripts/smoke.sh         End-to-end smoke test (build → start → /api/health)
scripts/eval/run.mjs     Layer-1 deterministic eval harness
scripts/voice/distill.mjs  `npm run voice:distill`
tests/                   Vitest unit tests
```

### The LLM seam

All generation goes through `LlmAdapter.generateStructured()`. Zod schemas are
the single source of truth and are converted to JSON Schema for the provider's
structured-output mode — there is no freeform text parsing anywhere.

Two deliberate constraints in the Anthropic adapter:

- **No sampling parameters.** `temperature`, `top_p` and `top_k` are never sent;
  current models reject them alongside structured output.
- **No assistant prefill.** Output shape is enforced by the schema, not by
  seeding the assistant turn.

---

## The voice profile

Generation is conditioned on `data/voice-profile.json`: distilled, hand-editable
traits (`tone`, `sentence_rhythm`, `opener_patterns`, `recurring_phrases`,
`banned_phrases`, `emoji_usage`, `vocabulary_register`) plus a **small** tagged
set of real captions and scripts.

```bash
cp data/voice-profile.example.json data/voice-profile.json   # start from the seed
```

The example profile is committed so the core loop is runnable on checkout. Your
own `data/voice-profile.json` is gitignored — it is personal data.

**Examples are capped at 10, with a warning above 6.** That is a design
constraint, not an arbitrary limit: more few-shot examples can *degrade* output
(arXiv 2509.13196), and models tend to copy surface word choice while missing
structural voice (arXiv 2509.14543). Distilled explicit traits plus a few
curated examples beat a large raw dump, and the cap lives in the schema so it
cannot be quietly regressed.

### Distilling traits from your own writing

```bash
# paste 3-5 captions or scripts on stdin, separated by a line of ---
npm run voice:distill

# or point it at files
npm run voice:distill -- sample1.txt sample2.txt sample3.txt
```

One structured LLM call through the same adapter seam, so it runs offline on the
mock with no API key. The result is written to `data/voice-profile.draft.json`
for you to read and edit — **it is never applied to your live profile
automatically**. Copy it over `data/voice-profile.json` when you are happy with
it. Any examples already in your profile are carried into the draft.

---

## Eval

`npm run eval` runs the Layer-1 deterministic checks and prints
`{"results":[{name, score, weight, passed, details}]}` on stdout (progress goes
to stderr, so stdout stays machine-parseable). Phase 1 ships two live
dimensions:

- `schema_validity` — a structured request round-trips through the configured
  adapter and validates against its Zod schema.
- `smoke_passes` — `scripts/smoke.sh` exits 0.

`EVAL_SKIP_SMOKE=1 npm run eval` runs the fast checks only, skipping the build.

Phases 3–5 add `hook_count`, `hook_distinctiveness`, `banned_phrases`,
`section_completeness` and `groundedness` as those checks become meaningful.

## Scope of v1

One loop: **raw idea in → multiple hook options + full script/outline out, in the
user's voice.** Content calendar, asset tracking, and analytics are explicitly
out of scope.
