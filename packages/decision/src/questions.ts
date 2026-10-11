import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from './wire.ts';

// The API refuses a question past its limits on every request, so one is
// refused here once, when the motty loads.
export function choice<Option extends string>(
  question: Omit<ChoiceQuestion<Option>, 'type'>,
): ChoiceQuestion<Option> {
  const options = Object.keys(question.criteria).length;
  if (options < 1 || options > 255) {
    throw new Error(
      `A choice has from one to 255 options, and this one has ${options}`,
    );
  }
  return { type: 'choice', ...question };
}

export function score(question: Omit<ScoreQuestion, 'type'>): ScoreQuestion {
  const levels = question.criteria.length;
  if (levels < 1 || levels > 10) {
    throw new Error(
      `A score has from one to ten levels, and this one has ${levels}`,
    );
  }
  return { type: 'score', ...question };
}

export function noul(question: Omit<NoulQuestion, 'type'>): NoulQuestion {
  return { type: 'noul', ...question };
}
