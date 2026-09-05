import type { StructuredRequest } from "../llm/types.ts";
import { renderExamples, renderTraits } from "../prompts/system.ts";
import { renderAllRubrics } from "./rubric.ts";
import type { VoiceProfile } from "../../types/voice.ts";
import type { Hook, Script } from "../../types/generation.ts";
import { JudgeVerdictSchema, type JudgeVerdict } from "../../types/judge.ts";

/**
 * Builds the single structured judge call.
 *
 * One call per generation, scoring all four dimensions at once. Four separate
 * calls would be cleaner in theory — a judge cannot let its read of the voice
 * bleed into its read of the structure if it never sees them together — but it
 * is four times the cost and latency over a twelve-case golden set, and the
 * rubric's per-dimension exclusions ("you are NOT asked...") already do most of
 * that separation. If cross-dimension bleed ever shows up in the data, split
 * this; until then it is a cost we have no evidence we need to pay.
 *
 * The judge sees the creator's profile, the idea, and the output. It does NOT
 * see the generation prompts. Showing it the instructions the generator was
 * given invites it to grade compliance with the prompt rather than the artefact
 * the creator would actually have to film.
 */

export const JUDGE_KIND = "judge";

const JUDGE_FRAMING = `You are evaluating one draft produced by a ghostwriting tool for a single Instagram creator. You are a strict, literal grader, not an editor and not an encouraging one.

Score exactly four dimensions, each 1–5, each against its own stated criteria. Rules that override everything else:

1. NO OVERALL SCORE. Do not blend the dimensions, do not average them, and do not let one strong dimension lift another. A draft can be perfectly structured and sound like nobody — that is a 5 and a 2, not two 3s.
2. USE THE CALIBRATION. Each dimension gives you an example worth 5 and an example worth 2. Ask which of the two the draft is closer to before you pick a number. Do not park on 3 because you are unsure; 3 is the floor of acceptable, not a way to abstain.
3. EVIDENCE FIRST. For each dimension quote or name the specific thing in the draft that decided the score. If you cannot point at something, the score is not defensible.
4. STAY IN YOUR DIMENSION. Each rubric says what it is not asking about. Fluent, likeable writing is not evidence for any dimension here.
5. DO NOT REWARD LENGTH, POLISH, OR CONFIDENCE. Longer is not better. Smoother is not better. A confident tone is not evidence of anything.`;

export interface JudgeRequestInput {
  idea: string;
  profile: VoiceProfile;
  hooks: readonly Hook[];
  script: Script;
  /** What was asked for, so `instruction_adherence` can check it was delivered. */
  hookCount: number;
}

function renderDraft(input: JudgeRequestInput): string {
  const hooks = input.hooks
    .map((hook, index) => `  ${index + 1}. [${hook.angle}] ${hook.text}`)
    .join("\n");

  const sections = input.script.sections
    .map((section) => {
      const onScreen = section.on_screen_text
        ? `\n     on-screen: ${section.on_screen_text}`
        : "";
      return `  <${section.kind}> ${section.text}${onScreen}`;
    })
    .join("\n");

  const claims =
    input.script.claims.length > 0
      ? input.script.claims
          .map(
            (claim, index) =>
              `  ${index + 1}. ${claim.text}\n     attributed to: "${claim.grounded_in}"`,
          )
          .join("\n")
      : "  (none)";

  return [
    "<creator_idea>",
    input.idea,
    "</creator_idea>",
    "",
    `<hooks requested="${input.hookCount}" returned="${input.hooks.length}">`,
    hooks,
    "</hooks>",
    "",
    "<script>",
    sections,
    "</script>",
    "",
    "<claims>",
    claims,
    "</claims>",
  ].join("\n");
}

export function buildJudgeRequest(
  input: JudgeRequestInput,
): StructuredRequest<JudgeVerdict> {
  return {
    kind: JUDGE_KIND,
    system: [
      // Stable across every case in the golden set, so the judge run reads its
      // own cache from case two onward. Nothing per-case is in here.
      { text: JUDGE_FRAMING, cacheable: true },
      { text: renderAllRubrics(), cacheable: true },
      { text: renderTraits(input.profile.traits), cacheable: true },
      { text: renderExamples(input.profile.examples), cacheable: true },
    ],
    messages: [
      {
        role: "user",
        content: `Here is the creator's idea and the draft the tool produced from it. Score the four dimensions.\n\n${renderDraft(input)}`,
      },
    ],
    schema: JudgeVerdictSchema,
    schemaName: "judge_verdict",
    maxTokens: 2048,
    effort: "high",
  };
}
