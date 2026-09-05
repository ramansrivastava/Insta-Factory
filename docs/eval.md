# How this project is evaluated

Three layers, in increasing order of cost and decreasing order of certainty.
Each answers a different question, and none of them answers the others'.

| Layer | What it is | What it tells you | What it cannot tell you |
| --- | --- | --- | --- |
| 1 — deterministic checks | `lib/generate/checks.ts`, run on every generation and by `npm run eval` | Whether the output is structurally valid and grounded | Whether it is any good |
| 2 — rubric judge over a golden set | `scripts/eval/judge.mjs` over `fixtures/golden/` | Whether a change made the output clearly *worse* | Whether one good run is better than another |
| 3 — accept / edit / discard | Phase 6's `data/generations/*.jsonl` plus `POST /api/feedback` | Whether the creator actually used it | Anything at all until enough of it accumulates |

Layer 3 is the only ground truth here. Layers 1 and 2 exist so that a
regression is caught in seconds instead of in a week of the creator quietly
rewriting every draft.

## Layer 1 — deterministic checks

Five gates, no network, no model, no flakiness. Each is a yes or a no:

- `hook_count` — exactly the number of hooks that were asked for
- `hook_distinctiveness` — every hook takes a different angle
- `banned_phrases` — nothing on the creator's banned list appears
- `section_completeness` — the script has a hook, a body and a CTA
- `groundedness` — no number, multi-word name, or attributed claim appears that
  the creator's idea does not contain

These run inside `generate()`, so every real generation leaves a per-check
record behind, not just the ones a harness looks at. `npm run eval` adds
`schema_validity` (the LLM seam returns schema-valid structured output) and
`smoke_passes` (the app builds, starts and answers).

**What Layer 1 does not tell you:** anything about quality. A fluent, on-topic,
perfectly structured script that sounds like nobody in particular passes all
five. That failure — correct topic, wrong person — is the one this product
exists to avoid, and it is invisible here.

## Layer 2 — the golden set and the judge

`npm run eval -- --with-judge`, or `npm run eval:judge` on its own.

### The golden set

Twelve fixed ideas in `fixtures/golden/cases/`, three each across the four
formats this creator posts: tutorial, storytime, contrarian take, product.
Split **eight tuning / four held out**.

The held-out four are never used to tune prompts. That rule is a convention,
not something code enforces — the moment a prompt is edited to make a held-out
case score better, the eval stops measuring generalisation and starts
re-validating the examples it was fitted to. `--split held_out` exists so the
distinction is at least visible in every report.

This is a **regression suite, not a benchmark**. There is no ground-truth right
script for a raw idea, so no case encodes a correct answer. What each case
encodes is coverage plus a stable input, so that a prompt edit which quietly
breaks storytime while improving tutorials is visible instead of averaging out.

Each case also commits an `offline` block — hand-written hooks, script and
judge verdict. With `LLM_PROVIDER=mock` (which is the default without an API
key) the whole layer runs from those, so CI is green and deterministic without
a key. They are terse stand-ins whose only job is to make the harness
exercisable offline. **They are not reference outputs. Never tune a prompt to
reproduce one, and never read an offline run as evidence about the model.**

### The judge

One structured call per generation, scoring four narrow dimensions 1–5:

| Dimension | Asks |
| --- | --- |
| `voice_fidelity` | Does this read as if the creator wrote it, not as competent copy about their topic? |
| `hook_distinctiveness` | Are these different ways in, or one hook reworded? |
| `script_completeness` | Could this be filmed as-is? |
| `instruction_adherence` | Did it stay inside the idea, adding nothing? |

Each dimension carries its own criteria, an explicit statement of what it is
*not* asking, and two calibrating examples — one worth 5, one worth 2. The
rubric is `lib/eval/rubric.ts`; the prompt is `lib/eval/judge-prompt.ts`.

### The four design decisions, and why

**Narrow multi-criteria rubrics, never a holistic score.** There is no "rate
this Reel 1–10" field and there should never be. Judges are markedly more
reliable answering a concrete question with stated criteria than giving a broad
subjective impression, and a blended number also destroys the one thing a judge
score is good for here: telling you *which* thing broke.

**Calibration anchors on every dimension.** Without anchors, judges drift to
the middle of a scale and score generously, and two runs a week apart stop
being comparable. With them the question becomes "which of these two is this
closer to" — a comparison rather than an act of taste.

**A different model grades than generates.** `JUDGE_MODEL` is its own variable
and defaults to a different model from `LLM_MODEL`. Self-preference bias is
well documented and invisible in the score: a judge marks its own family's
phrasing up and nothing in the number says so. A different *family* would be
better still; a different model is what this project can reach today, and both
`scripts/eval/judge.mjs` and `run.mjs` print a warning when the two match.

**Triage, not ranking.** Every score this layer reports is a floor pass rate:
how many of the twelve cases scored below 3/5. A run where every case scraped a
3 scores identically to one where every case earned a 5. That is deliberate —
there is nothing to hill-climb, because the moment a judge mean becomes a
target the prompts get tuned to the judge's taste instead of the creator's.
Means are printed for a human to read and are never what gets scored.

### Known biases being worked around

- **Self-preference** — mitigated by `JUDGE_MODEL`, and warned about when it
  is not.
- **Position and verbosity bias** — judges reward length, polish and
  confidence. The judge prompt says so explicitly, and the rubric's `notAsking`
  lines exclude "is this good writing" from every dimension.
- **Middle-anchoring** — mitigated by requiring quoted evidence per score, and
  by telling the judge that 3 is the floor of acceptable rather than a way to
  abstain.
- **Cross-dimension bleed** — all four dimensions are scored in one call for
  cost, so a judge's read of the voice can in principle colour its read of the
  structure. The per-dimension exclusions are the mitigation. If bleed shows up
  in real data, split this into four calls.
- **The judge cannot see the generation prompts** — on purpose. Showing it the
  instructions invites it to grade compliance with the prompt rather than the
  artefact the creator would have to film.

## The project eval

`factory.md`'s `## Project Eval` binds four dimensions to this layer:

| Dimension | Source |
| --- | --- |
| `hook_distinctiveness` | Layer 1, over all twelve golden cases |
| `script_completeness` | Layer 1, over all twelve golden cases |
| `groundedness` | Layer 1, over all twelve golden cases |
| `voice_match` | Layer 1's banned-phrase check **and** the judge's `voice_fidelity` floor |

Only `voice_match` is load-bearing on the judge, and only because voice is the
one thing here code cannot check: code can prove a banned phrase is absent, and
nothing more.

Each dimension scores as the share of golden cases on which it held, and every
failure names the case id — a rate says something regressed, the ids say where
to look.

## Layer 3 — accept, edit, discard

Every generation is appended to `data/generations/<date>.jsonl` with its
Layer-1 verdicts, timings and token usage. `POST /api/feedback` records what
the creator did with it: accepted, edited (with the edited text), or discarded.
`npm run generations:summary` reads it back.

This is the only measurement in the project with ground truth in it. Edit rate
per format is what eventually calibrates the judge floor — until then, the
floor is provisional, and the held-out four are the closest thing to an honest
read on whether a change generalised.

## Running it

```bash
npm run eval                      # Layer 1 only, fast, no golden set
npm run eval -- --with-judge      # + the golden set and the judge
npm run eval:judge                # the golden set on its own, with a per-case report
npm run eval:judge -- --split held_out
npm run eval:judge -- --case tutorial-grip-fix
npm run eval:judge -- --no-judge  # golden set through Layer 1 only
```

With no `ANTHROPIC_API_KEY` all of the above run on the mock provider and are
deterministic. With a key, generation uses `LLM_MODEL` and grading uses
`JUDGE_MODEL`.
