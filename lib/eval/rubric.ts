import { JUDGE_DIMENSIONS, type JudgeDimension } from "../../types/judge.ts";

/**
 * The judge rubric.
 *
 * Four narrow dimensions, each with its own stated criteria and two calibrating
 * examples — one that earns a 5 and one that earns a 2. The calibration is the
 * load-bearing part: without anchors, judges drift toward the middle of any
 * scale and score generously, and two runs of the same prompt a week apart stop
 * being comparable. With anchors the question becomes "which of these two is
 * this closer to", which is a comparison rather than an act of taste.
 *
 * Each `criteria` block deliberately says what is NOT being asked. The failure
 * mode of an LLM judge is answering a broader, easier question than the one
 * posed — "is this good writing?" instead of "does this match this profile?" —
 * and the exclusions are what hold it to the narrow one.
 */

export interface DimensionRubric {
  dimension: JudgeDimension;
  /** Shown in reports and in `docs/eval.md`. */
  question: string;
  criteria: string[];
  notAsking: string;
  /** What a 5 looks like, and why it is a 5. */
  exemplarFive: { example: string; because: string };
  /** What a 2 looks like, and why it is a 2. */
  exemplarTwo: { example: string; because: string };
}

export const RUBRIC: Record<JudgeDimension, DimensionRubric> = {
  voice_fidelity: {
    dimension: "voice_fidelity",
    question:
      "Does this read as if the creator in the profile wrote it, rather than as competent copy about their topic?",
    criteria: [
      "Sentence rhythm matches the profile: line lengths, fragments, where a thought breaks.",
      "Vocabulary register matches. A profile that says casual should not produce marketing prose.",
      "Openers resemble the profile's stated opener patterns rather than a generic attention grab.",
      "Signature phrases appear where they fit naturally, and are not stuffed in everywhere.",
      "Nothing from the banned list appears, in any casing.",
    ],
    notAsking:
      "You are NOT asked whether the writing is good, persuasive, or well structured. Polished copy that sounds like nobody in particular scores low here.",
    exemplarFive: {
      example:
        "You don't need five days a week. You need two you'll actually keep. Here's the boring part: the first six weeks feel like nothing is happening.",
      because:
        "Opens with a flat contradiction, then a beat — one of the profile's stated opener patterns. Short declaratives, a signature phrase used where it belongs, second person singular, no hype.",
    },
    exemplarTwo: {
      example:
        "Ready to transform your fitness journey? Consistency is the key that unlocks real, lasting results — and today we're breaking down exactly how to get there.",
      because:
        "Fluent and entirely anonymous. Rhetorical question opener, marketing register, none of the profile's rhythm. This is the default failure: correct topic, wrong person.",
    },
  },

  hook_distinctiveness: {
    dimension: "hook_distinctiveness",
    question:
      "Are these genuinely different ways into the same idea, or one hook reworded?",
    criteria: [
      "Each hook makes a different promise to the viewer, not just a different sentence.",
      "The stated angle matches what the hook actually does.",
      "No two hooks would be interchangeable as the first line of the same video.",
      "Variety comes from the angle, not from swapping synonyms or reordering clauses.",
    ],
    notAsking:
      "You are NOT asked which hook is best, or whether any of them would perform well. Predicting engagement is outside what you can know.",
    exemplarFive: {
      example:
        "(1) You don't need five days a week. (2) The program isn't the problem — the version of you who had six free hours is. (3) Here's the boring part nobody tells you about training twice a week.",
      because:
        "A contradiction, a reframe of the viewer's own failure, and an opened curiosity gap. Three different promises; each would start a different video.",
    },
    exemplarTwo: {
      example:
        "(1) Two sessions a week beats a five-day split. (2) A five-day split loses to two sessions a week. (3) Why two weekly sessions outperform five-day splits.",
      because:
        "One claim stated three ways. The labels may differ but the promise to the viewer is identical, so the creator has no real choice to make.",
    },
  },

  script_completeness: {
    dimension: "script_completeness",
    question:
      "Could the creator film this as-is, or would they have to write the missing parts themselves?",
    criteria: [
      "There is a hook, substance in the middle, and a specific close.",
      "The body delivers the thing the hook promised — not a restatement of the premise.",
      "The sections connect; each earns the next rather than restarting.",
      "The CTA asks for one concrete thing, not a generic follow-for-more.",
      "Nothing is left as a placeholder or an instruction to the creator.",
    ],
    notAsking:
      "You are NOT asked whether the required section labels are present — code already checks that deterministically. Judge whether the content under them is filmable.",
    exemplarFive: {
      example:
        "Hook lands the contradiction; setup names the abandoned five-day plan; body explains what two full-body sessions actually contain and why the third week is where plans die; payoff says what changes for the viewer; close asks them to put two days in the calendar tonight.",
      because:
        "Every section does its own job, the body pays off the hook's promise, and the ask is one specific action.",
    },
    exemplarTwo: {
      example:
        "Hook: two sessions beat five. Body: consistency matters more than volume, and this is something a lot of people get wrong. Close: follow for more training tips.",
      because:
        "The body restates the hook as a platitude and delivers nothing filmable, and the close is the generic ask. The labels are all present and the script is still unusable.",
    },
  },

  instruction_adherence: {
    dimension: "instruction_adherence",
    question:
      "Did the output stay inside the constraints it was given — the creator's idea, and nothing added?",
    criteria: [
      "Every factual assertion traces to something the idea supplies.",
      "No statistic, study, percentage, brand, person or place appears that the idea did not contain.",
      "Claims attribute to a span the idea actually contains, rather than to an invented paraphrase.",
      "Structure, pacing and framing may be added freely — those are not additions of fact.",
      "The requested number of hooks is present and the requested format is respected.",
    ],
    notAsking:
      "You are NOT asked whether the added detail would be true in general. A correct statistic the creator never mentioned is still a violation — it puts a claim in their mouth they cannot stand behind.",
    exemplarFive: {
      example:
        "The idea says people quit because they plan for six free hours a week. The script elaborates on the abandoned plan, the third week, and the two sessions — and introduces no number, name or study beyond those.",
      because:
        "Everything added is structure and pacing. Nothing added is fact.",
    },
    exemplarTwo: {
      example:
        "The idea mentions no research. The script opens with 'studies show 73% of people quit their program within six weeks' and cites a university sleep lab.",
      because:
        "A fabricated statistic and a fabricated source. Plausible, well written, and the single worst failure this product can produce.",
    },
  },
};

/** Rubrics in the canonical dimension order, for rendering. */
export const RUBRICS: DimensionRubric[] = JUDGE_DIMENSIONS.map(
  (dimension) => RUBRIC[dimension],
);

/** The rubric as prompt text. Deterministic — same rubric in, same bytes out. */
export function renderRubric(rubric: DimensionRubric): string {
  return [
    `## ${rubric.dimension}`,
    rubric.question,
    "",
    "Score 1–5 against these criteria:",
    ...rubric.criteria.map((line) => `  - ${line}`),
    "",
    rubric.notAsking,
    "",
    `CALIBRATION — a 5 looks like: ${rubric.exemplarFive.example}`,
    `  why it is a 5: ${rubric.exemplarFive.because}`,
    "",
    `CALIBRATION — a 2 looks like: ${rubric.exemplarTwo.example}`,
    `  why it is a 2: ${rubric.exemplarTwo.because}`,
  ].join("\n");
}

export function renderAllRubrics(): string {
  return RUBRICS.map(renderRubric).join("\n\n");
}
