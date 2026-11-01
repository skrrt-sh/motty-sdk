import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from './wire.ts';

/**
 * Asks which of the options in `criteria` fits, from one to 255 of them. It
 * throws when the motty loads if the count is out of range, since the API would
 * refuse it on every request.
 */
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

/**
 * Asks for a level on a scale, from one to ten levels in `criteria` ordered
 * from low to high. The number of a level is its index, and a count out of
 * range throws when the motty loads.
 */
export function score(question: Omit<ScoreQuestion, 'type'>): ScoreQuestion {
  const levels = question.criteria.length;
  if (levels < 1 || levels > 10) {
    throw new Error(
      `A score has from one to ten levels, and this one has ${levels}`,
    );
  }
  return { type: 'score', ...question };
}

/**
 * Asks a yes or no question, and the answer holds the probability of yes in
 * `noul`.
 */
export function noul(question: Omit<NoulQuestion, 'type'>): NoulQuestion {
  return { type: 'noul', ...question };
}
