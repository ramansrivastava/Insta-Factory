# Instagram Creator OS

Turn a raw content idea into several structurally distinct hook options plus a full
Instagram Reel script — written in **your** voice, not a dropdown "tone".

> **Status: Phase 3 (the core loop).** The v1 loop works end to end: `npm run
> generate -- --idea "..."` takes a raw idea and returns N structurally distinct
> hooks plus a full sectioned Reel script, in your voice, through two sequential
> LLM calls. It runs offline on the mock provider with no API key. The Layer-1
> eval now scores seven real dimensions. Still to come: the HTTP API and UI
> (Phase 4) — see `.factory/strategy/current.md` for the full build plan.

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

### Run the core loop

```bash
npm run generate -- --idea "why two sessions a week beats a five-day split"
```

That is the whole product: one command, raw idea in, hooks plus a full script
out. It prints the hooks (each labelled with its angle and a one-line rationale),
the script section by section with any on-screen text, the claims the script
makes paired with the span of your idea each is grounded in, and the Layer-1
check results.

```bash
npm run generate                                   # built-in sample idea
npm run generate -- --idea "..." --hooks 3         # 3-6 hooks (one per angle)
npm run generate -- --idea "..." --json            # machine-readable
echo "my idea" | npm run generate -- --idea -      # read the idea from stdin
```

With no API key this runs on the mock provider, which answers from
`fixtures/llm/` **regardless of the idea you pass**. The output is real and
complete, but it is the fixture's content, so `groundedness` will correctly fail
for any idea other than the built-in sample — the CLI says so when it happens.
Set `ANTHROPIC_API_KEY` for output that actually responds to your idea.

### Regenerate one half

Hooks and the script are two separate model calls, so either can be re-run on
its own. In the UI each half has its own **Regenerate** button with an optional
one-line steer ("make them blunter", "lead with the mistake"); regenerating the
hooks hands the model the ones you have already seen, so round two is a
different set rather than the same lines reordered. From the CLI:

```bash
npm run --silent generate -- --hooks-only --json > hooks.json   # hooks, no script
npm run generate -- --script-only --hooks-file hooks.json       # script for those hooks
npm run generate -- --hooks-only --hooks-file hooks.json \
  --steer "make them blunter"                                   # different hooks
```

The steer is appended after the cacheable voice prefix, so pressing regenerate
repeatedly does not re-pay for the profile. Every regeneration is its own trace
record carrying `parent_generation_id`, which is what makes "she had to ask
twice" countable in `npm run generations:summary`.

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
lib/prompts/
  system.ts              Cacheable prefix: role framing + traits + examples
  hooks.ts               Call 1 — exactly N hooks, one per distinct angle
  script.ts              Call 2 — sectioned script, voice reminder per section
lib/generate/
  pipeline.ts            generate({idea, profile, hookCount}) — both calls
  checks.ts              Layer-1 deterministic checks (the five gates)
  sample.ts              The idea the mock fixtures are written against
types/voice.ts           Zod voice-profile schema (10-example hard cap)
types/generation.ts      Zod hook/script/claim schemas; the hook-angle enum
data/                    voice-profile.example.json (committed seed)
fixtures/llm/            Mock adapter fixtures, keyed by request kind
fixtures/generation/     Check fixtures (incl. a deliberately ungrounded script)
scripts/smoke.sh         End-to-end smoke test (build → start → /api/health)
scripts/eval/run.mjs     Layer-1 deterministic eval harness
scripts/generate.mjs     `npm run generate` — the core loop from the CLI
                         (plus --hooks-only / --script-only for half a run)
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
to stderr, so stdout stays machine-parseable). Seven live dimensions:

- `schema_validity` — a structured request round-trips through the configured
  adapter and validates against its Zod schema.
- `smoke_passes` — `scripts/smoke.sh` exits 0.
- `hook_count` — the loop returned exactly the number of hooks asked for.
- `hook_distinctiveness` — every hook takes a different angle.
- `banned_phrases` — no phrase from the profile's banned list appears anywhere.
- `section_completeness` — the script has a hook, a body and a CTA.
- `groundedness` — no number, multi-word name, or `claims[].grounded_in` span in
  the script that the idea does not actually contain.

The five product dimensions come from a single run of the real pipeline on the
mock adapter — the same code path the CLI uses, not a parallel implementation.
They are **gates, not scores**: each is 1 or 0, and each says exactly what
failed. Whether the writing is any *good* is Layer 2's job (Phase 7); the only
ground truth for that is Layer 3's accept/edit/discard data (Phase 6).

`EVAL_SKIP_SMOKE=1 npm run eval` runs the fast checks only, skipping the build.

## Scope of v1

One loop: **raw idea in → multiple hook options + full script/outline out, in the
user's voice.** Content calendar, asset tracking, and analytics are explicitly
out of scope.
