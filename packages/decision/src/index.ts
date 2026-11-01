import { UnknownModel, type Usage } from '@mottyjs/core';
import { counted, hosted, type Json } from '@mottyjs/core/host';
import { assertAnswers, isFields } from './answers.ts';
import { type State, structured } from './state.ts';
import type { Answers, DecisionInput, Questions } from './wire.ts';

export { choice, noul, score } from './questions.ts';
export type { State } from './state.ts';
export type {
  Answer,
  Answers,
  AnswerTo,
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionInput,
  DecisionOutput,
  NoulAnswer,
  NoulQuestion,
  Question,
  Questions,
  ScoreAnswer,
  ScoreQuestion,
  Structured,
} from './wire.ts';

/** A model that answers typed questions with probabilities. */
export type DecisionModel = {
  readonly name: string;
  /**
   * Asks about a state, which is text or structured data, and gives one answer
   * per question under its id. It needs at least one question, counts toward
   * `limits.calls`, and fails with `UnknownModel` when the host serves no such
   * model.
   */
  decide<Asked extends Questions>(
    state: State,
    questions: Asked,
  ): Promise<Answers<Asked>>;
};

function usageOf(output: Json): Usage {
  const { usage } = isFields(output) ? output : {};
  if (!isFields(usage)) return {};
  const { input_tokens: input, output_tokens: written, cost } = usage;
  return {
    ...(typeof input === 'number' ? { input } : {}),
    ...(typeof written === 'number' ? { output: written } : {}),
    ...(typeof cost === 'number' ? { cost } : {}),
  };
}

/**
 * Names a decision model of the host, as its adapter's prefix, a slash and the
 * provider's own name.
 */
export function decision(name: string): DecisionModel {
  return Object.freeze({
    name,
    decide: async (state, questions) => {
      // The API refuses a request with no question, so none is sent.
      const asked = Object.keys(questions).length;
      if (asked < 1) {
        throw new Error(
          `A decision has at least one question, and this one has ${asked}`,
        );
      }
      const { decisions } = hosted();
      const input: DecisionInput = { state: structured(state), questions };
      const output = await counted(
        name,
        async (signal) => {
          if (decisions === undefined) {
            throw new UnknownModel(
              `The host serves no decision model, so none is named ${name}`,
            );
          }
          return decisions(name, input, signal);
        },
        usageOf,
      );
      const { answers } = isFields(output) ? output : {};
      assertAnswers(questions, answers);
      return answers;
    },
  });
}
