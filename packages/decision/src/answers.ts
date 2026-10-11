import { InvalidOutput } from '@mottyjs/core';
import type { Answers, Question, Questions } from './wire.ts';

type Fields = { readonly [key: string]: unknown };

export function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function isStructured(value: unknown): boolean {
  return (
    typeof value === 'string' || (typeof value === 'object' && value !== null)
  );
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number';
}

// What Laya adds and Jev leaves out, so each may be absent; one that is
// there is what an author is typed to read.
const added: { readonly [field: string]: (value: unknown) => boolean } = {
  answer_confidence: isNumber,
  action: (action) => {
    const { act_probability: act } = isFields(action) ? action : {};
    return isNumber(act);
  },
  low_confidence: (low) => low === true,
  abstention: (abstention) =>
    abstention === 'passed' ||
    abstention === 'abstained' ||
    abstention === 'unevaluated',
  abstention_threshold: isNumber,
  confidence: isNumber,
  x_jev_confidence: isNumber,
};

// Named is the first that is not. Jev gives a noul no confidence of its own,
// so one of any type is passed over.
function mistypedIn(question: Question, answer: Fields): string | undefined {
  return Object.entries(added).find(
    ([field, typed]) =>
      answer[field] !== undefined &&
      !typed(answer[field]) &&
      (field !== 'x_jev_confidence' || question.type !== 'noul'),
  )?.[0];
}

function mistakeIn(question: Question, answer: Fields): string | undefined {
  const { type, choice, score, noul, probabilities, legend, confidence } =
    answer;
  if (type !== question.type) return `is not a ${question.type}`;
  switch (question.type) {
    case 'choice': {
      const options = Object.keys(question.criteria);
      if (typeof choice !== 'string' || !options.includes(choice)) {
        return 'chooses no option of the question';
      }
      if (
        !isFields(probabilities) ||
        !options.every((option) => isProbability(probabilities[option]))
      ) {
        return 'lacks a probability for each option';
      }
      break;
    }
    case 'score': {
      const levels = question.criteria;
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        return 'has no score';
      }
      if (score < 0 || score > levels.length - 1) {
        return 'has a score outside the levels of the question';
      }
      if (
        !isFields(probabilities) ||
        !levels.every((_, level) => isProbability(probabilities[level])) ||
        !Object.values(probabilities).every(isProbability)
      ) {
        return 'lacks a probability for each level';
      }
      if (!isFields(legend) || !Object.values(legend).every(isStructured)) {
        return 'has no legend';
      }
      break;
    }
    case 'noul':
      if (!isProbability(noul)) return 'has no probability';
      break;
    default:
      return question satisfies never;
  }
  if (question.type !== 'noul' && !Number.isFinite(confidence)) {
    return 'has no confidence';
  }
  const field = mistypedIn(question, answer);
  return field === undefined ? undefined : `has the wrong type of ${field}`;
}

// The host passes the output on unread, so what an author is typed to read is
// checked here, question by question.
export function assertAnswers<Asked extends Questions>(
  questions: Asked,
  answers: unknown,
): asserts answers is Answers<Asked> {
  if (!isFields(answers)) {
    throw new InvalidOutput('The decision model returned no answers');
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
    const mistake = isFields(answer)
      ? mistakeIn(question, answer)
      : 'is missing';
    if (mistake !== undefined) {
      throw new InvalidOutput(
        `The decision model's answer to "${id}" ${mistake}`,
      );
    }
  }
}
