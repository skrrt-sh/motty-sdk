import { MottyError } from '@mottyjs/core';
import type { ReadonlyJson } from '@mottyjs/core/host';
import type {
  Answer,
  ChoiceAnswer,
  DecisionOutput,
  ScoreAnswer,
} from '@mottyjs/decision/wire';
import { type ChatReply, isList } from './chat-reply.ts';
import { copied } from './copied.ts';
import { Unscripted } from './unscripted.ts';

export type DecisionReply =
  | MottyError
  | {
      readonly [question: string]:
        | number
        | { readonly [option: string]: number };
    };

type Fields = { readonly [key: string]: ReadonlyJson };

const none: Fields = {};

function isProbability(value: ReadonlyJson | undefined): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function fields(value: ChatReply | ReadonlyJson | undefined) {
  if (typeof value !== 'object' || value === null) return undefined;
  if (value instanceof MottyError || isList(value)) return undefined;
  return value;
}

// Each number is rounded on its own, so a real answer can sum a little off
// one: Laya's own was 0.9999.
const rounding = 0.001;

// A choice sums to one, as the API's does: the options left out share what
// the script leaves over. An option that was not asked about is a slip in the
// script, and one naming no option says nothing of which was chosen.
function chosen(
  scripted: Fields | undefined,
  criteria: Fields | undefined,
): ChoiceAnswer | string | undefined {
  if (scripted === undefined || criteria === undefined) return undefined;
  const options = Object.keys(criteria);
  const probabilities: ChoiceAnswer['probabilities'] = {};
  const left: string[] = [];
  let best: [option: string, probability: number] | undefined;
  let sum = 0;
  for (const option of options) {
    const probability = scripted[option];
    if (probability === undefined) {
      probabilities[option] = 0;
      left.push(option);
      continue;
    }
    if (!isProbability(probability)) return undefined;
    probabilities[option] = probability;
    sum += probability;
    if (best === undefined || probability > best[1]) {
      best = [option, probability];
    }
  }
  const named = options.length - left.length;
  if (named === 0 || named !== Object.keys(scripted).length) return undefined;
  const over = 1 - sum;
  if (over < -rounding || (left.length === 0 && over > rounding)) {
    return `its probabilities sum to ${Number(sum.toFixed(4))}, not to one`;
  }
  if (over > rounding) {
    const share = over / left.length;
    for (const option of left) {
      probabilities[option] = share;
      if (best === undefined || share > best[1]) best = [option, share];
    }
  }
  if (best === undefined) return undefined;
  // How far the likeliest sits above an even split, as the API reports it.
  // One option has no split to sit above, and the API calls it certain; a
  // sum a rounding short of one must not fall below the API's floor.
  const even = 1 / options.length;
  return {
    type: 'choice',
    choice: best[0],
    probabilities,
    confidence: even === 1 ? 1 : Math.max(0, (best[1] - even) / (1 - even)),
  };
}

// A score between two levels is shared by them, so the levels' weighted mean
// is the score, as the API's is.
function scored(
  score: number,
  criteria: ReadonlyJson | undefined,
): ScoreAnswer | undefined {
  if (!isList(criteria) || !(score >= 0 && score <= criteria.length - 1)) {
    return undefined;
  }
  const below = Math.floor(score);
  const above = score - below;
  const legend: ScoreAnswer['legend'] = {};
  const probabilities: ScoreAnswer['probabilities'] = {};
  let spread = 0;
  for (const [index, level] of criteria.entries()) {
    // The API takes a level as text or structured, and gives it back so.
    const given = copied(level);
    if (typeof given !== 'string' && (typeof given !== 'object' || !given)) {
      return undefined;
    }
    legend[index] = given;
    probabilities[index] =
      index === below ? 1 - above : index === below + 1 ? above : 0;
    spread += Math.abs(index - (criteria.length - 1) / 2) / criteria.length;
  }
  // The mean distance from the likeliest level, against that of an even
  // spread from the middle one, as the API reports it. One level has no
  // spread, and the API calls it certain.
  return {
    type: 'score',
    score,
    legend,
    probabilities,
    confidence: spread === 0 ? 1 : 1 - Math.min(above, 1 - above) / spread,
  };
}

function answerTo(
  question: Fields | undefined,
  scripted: ReadonlyJson | undefined,
): Answer | string | undefined {
  const { type, criteria } = question ?? none;
  if (type === 'choice') return chosen(fields(scripted), fields(criteria));
  if (typeof scripted !== 'number') return undefined;
  if (type === 'score') return scored(scripted, criteria);
  return type === 'noul' && isProbability(scripted)
    ? { type, noul: scripted }
    : undefined;
}

// The whole reply the decision API gives, made from the kind of each question
// asked: the script names only what the test cares about.
export function decided(
  model: string,
  reply: ChatReply,
  input: ReadonlyJson,
): DecisionOutput {
  if (reply instanceof MottyError) throw reply;
  const scripted = fields(reply) ?? none;
  const { questions } = fields(input) ?? none;
  const answers: { [id: string]: Answer } = {};
  for (const [id, question] of Object.entries(fields(questions) ?? none)) {
    const answer = answerTo(fields(question), scripted[id]);
    if (answer === undefined || typeof answer === 'string') {
      throw new Unscripted(
        `No reply the decision API could give was scripted for the question ${id} asked of ${model}${answer === undefined ? '' : `: ${answer}`}`,
      );
    }
    answers[id] = answer;
  }
  return { model, answers, usage: { input_tokens: 0, output_tokens: 0 } };
}
