# Instagram Creator OS — Factory Config

<!-- Parsed by `factory init` into .factory/config.json. Section headings are significant. -->
<!-- Values under a heading must be a single line, a fenced block, or a bullet list. -->

## Goal

Build an Instagram Creator OS whose v1 core loop is idea-in -> hooks + script out: the user supplies a raw content idea, and the system drafts multiple distinct hook options plus a full script/outline for the video, written in the user's own voice. v1 is complete when a creator can enter a raw idea and receive usable hook variants and a full script without hand-editing the output into their voice. Content calendar, asset tracking, and analytics are explicitly OUT OF SCOPE for v1.

## Scope

### Modifiable

- src/**
- app/**
- lib/**
- server/**
- client/**
- api/**
- components/**
- packages/**
- prompts/**
- config/**
- scripts/**
- tests/**
- test/**
- docs/**
- data/**
- fixtures/**
- public/**
- static/**
- assets/**
- migrations/**
- types/**
- examples/**
- *.py
- *.ts
- *.tsx
- *.js
- *.jsx
- *.json
- *.toml
- *.yaml
- *.yml
- *.md
- *.txt
- *.cfg
- *.ini
- *.sql
- *.sh
- *.css
- *.html
- .gitignore
- .env.example
- Dockerfile
- docker-compose.yml
- Makefile

### Read Only

- .factory/**
- .claude/**
- skills/**
- eval/**

## Fixed Surfaces

<!-- Enforced by `factory guard`: any commit touching these forces a revert. -->

- eval/**
- skills/**
- .claude/**

## Guards

- Do not delete or overwrite existing tests — tests may be extended, never removed
- Do not modify files outside the declared Modifiable scope
- Do not introduce secrets, API keys, tokens, or credentials into the repository — use .env with a committed .env.example
- Do not lower the eval threshold — the bar only goes up
- Do not skip the eval step — every change is scored before it can be kept
- Do not merge PRs — leave them open for human review
- Do not modify eval/, skills/, or .claude/ — these are factory infrastructure
- Do not commit generated media, model weights, or large binary artifacts

## Constraints

- v1 delivers exactly one loop: raw idea in -> multiple hook options + full script/outline out, in the user's voice. Do not build calendar, asset tracking, or analytics features.
- Voice fidelity is a first-class requirement, not a stretch goal: the system must accept some representation of the user's voice (samples, style profile, or prior captions) and condition generation on it.
- Every generation path must be runnable end-to-end from the primary entry point without manual glue steps.
- LLM provider credentials are read from the environment; never hardcode them and never commit a populated .env.
- Prefer one obvious entry point over several partial ones — a new contributor should be able to run the core loop from the README in under five minutes.

## Eval

### Command

<!-- eval/score.py is the generated harness; it emits {"results": [...]} JSON on stdout. -->
<!-- Tech stack (Next.js/TypeScript) was fixed at Phase 1. As of Phase 7, real project-eval -->
<!-- dimensions are wired via the `## Project Eval` section below (golden-set + judge layer), -->
<!-- moving the eval profile off the fallback tier. -->

```
python3 eval/score.py
```

### Threshold

0.6

## Eval Spec

- Build and run the project's primary entry point without errors

## Smoke Test

<!-- Stack-agnostic contract: scripts/smoke.sh must build/start the primary entry point and exit 0. -->
<!-- The Builder creates it during scaffolding and updates it if the entry point changes. -->

bash scripts/smoke.sh

## Target Branch

master

## Hypothesis Budget

- min_growth: 2
- max_new: 2

## Project Eval

<!-- Layer 2: the twelve-case golden set in fixtures/golden/, run through the real pipeline -->
<!-- and graded by scripts/eval/judge.mjs. Each command below uses --score-only, which prints -->
<!-- exactly one line, {"score": <0.0-1.0>, "details": "<string>"} — the flat shape the -->
<!-- factory's project-eval runner requires (it execs the command directly, no shell/pipes, -->
<!-- and parses stdout as that exact object). The bare (non --score-only) {"results":[...]} -->
<!-- wrapper shape is still used by `node scripts/eval/run.mjs --with-judge` for local/manual runs. -->
<!-- Every score is a pass RATE over the golden set, never a quality average: the judge is a -->
<!-- triage signal that catches clearly-broken output, and it is never used to rank one run -->
<!-- above another. See docs/eval.md. -->

- name: hook_distinctiveness
  command: node scripts/eval/judge.mjs --dimension hook_distinctiveness --score-only
  parse: json
  weight: 0.25
  description: every hook in a set takes a different angle, on all twelve golden cases
- name: voice_match
  command: node scripts/eval/judge.mjs --dimension voice_match --score-only
  parse: json
  weight: 0.25
  description: no banned phrase appears, and the judge's voice_fidelity clears its 3/5 floor, on all twelve golden cases
- name: script_completeness
  command: node scripts/eval/judge.mjs --dimension script_completeness --score-only
  parse: json
  weight: 0.25
  description: every generated script carries a hook, a body and a CTA
- name: groundedness
  command: node scripts/eval/judge.mjs --dimension groundedness --score-only
  parse: json
  weight: 0.25
  description: no number, name or attributed claim appears that the creator's idea does not support

<!-- All four at once, plus the judge's own four dimensions (local/manual run, not used by the factory runner): -->

```
node scripts/eval/run.mjs --with-judge
```

## Eval Weights

<!-- The project dimensions above now measure whether the product works, so they carry real -->
<!-- weight. The threshold in ## Eval is unchanged at 0.6. -->

- hygiene: 0.35
- growth: 0.35
- project: 0.3

## Notes

- `## Project Eval` was wired at Phase 7: four dimensions over a twelve-case golden set (eight tuning, four held out), three of them deterministic and one backed by a rubric judge. `factory discover` + `factory init` were re-run after this section landed to move the eval profile off the fallback tier onto them.
- The judge is configured separately from the generator (`JUDGE_MODEL`, not `LLM_MODEL`) so a model never grades its own output, and its scores gate on a floor rather than ranking. Offline (`LLM_PROVIDER=mock`) both the generation and the judge answer from committed fixtures, so the project eval runs deterministically in CI without an API key.
- No `## Research Configuration` was present in .factory/strategy/current.md at config time, so Research Target, Mutable/Fixed Surfaces (research), Inner Loop, and Outer Loop sections are intentionally omitted.
