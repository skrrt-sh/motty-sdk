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

function mayBeNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

// What Laya adds and Jev leaves out, so each may be absent; one that is
// there is what an author is typed to read. Named is the first that is not.
function mistypedIn(question: Question, answer: Fields): string | undefined {
  const {
    answer_confidence: sure,
    action,
    low_confidence: low,
    abstention,
    abstention_threshold: threshold,
  } = answer;
  const { act_probability: act } = isFields(action) ? action : {};
  if (!mayBeNumber(sure)) return 'answer_confidence';
  if (action !== undefined && typeof act !== 'number') return 'action';
  if (low !== undefined && low !== true) return 'low_confidence';
  if (
    abstention !== undefined &&
    abstention !== 'passed' &&
    abstention !== 'abstained' &&
    abstention !== 'unevaluated'
  ) {
    return 'abstention';
  }
  if (!mayBeNumber(threshold)) return 'abstention_threshold';
  // Jev gives a noul no confidence, so Laya's own stands where Jev's would.
  const field = question.type === 'noul' ? 'confidence' : 'x_jev_confidence';
  return mayBeNumber(answer[field]) ? undefined : field;
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
    case 'score':
      if (typeof score !== 'number') return 'has no score';
      if (
        !isFields(probabilities) ||
        !Object.values(probabilities).every(isProbability)
      ) {
        return 'lacks a probability for each level';
      }
      if (!isFields(legend) || !Object.values(legend).every(isStructured)) {
        return 'has no legend';
      }
      break;
    case 'noul':
      if (!isProbability(noul)) return 'has no probability';
      break;
    default:
      return question satisfies never;
  }
  if (question.type !== 'noul' && typeof confidence !== 'number') {
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
