import type { Json, ReadonlyJson } from '@mottyjs/core/host';

// Text, or structured data the model reads as it is. The API takes no bare
// number, boolean or null here.
export type Structured =
  | string
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };

export type ChoiceQuestion<Option extends string = string> = {
  readonly type: 'choice';
  readonly instructions: Structured;
  // Null for an option whose name says enough.
  readonly criteria: { readonly [Name in Option]: Structured | null };
};

export type ScoreQuestion = {
  readonly type: 'score';
  readonly instructions: Structured;
  // Ordered from the low end to the high; a level's number is its index.
  readonly criteria: readonly Structured[];
};

export type NoulQuestion = {
  readonly type: 'noul';
  readonly instructions: Structured;
  readonly criteria?: {
    readonly true?: Structured;
    readonly false?: Structured;
  };
};

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type Questions = { readonly [id: string]: Question };

// The API's request body without the model's name: that travels beside the
// input, and the adapter writes the provider's own name into the body.
export type DecisionInput<Asked extends Questions = Questions> = {
  readonly state: Structured;
  readonly questions: Asked;
};

// What Laya adds under its own names; Jev sends none of it. The abstention pair
// comes only when the host set Laya's min_confidence, and low_confidence only
// on an answer that fell below it.
type Added = {
  answer_confidence?: number;
  action?: { act_probability: number };
  low_confidence?: true;
  abstention?: 'passed' | 'abstained' | 'unevaluated';
  abstention_threshold?: number;
};

// Laya's confidence is another measure than Jev's, so Laya also sends Jev's.
export type ChoiceAnswer<Option extends string = string> = Added & {
  type: 'choice';
  choice: Option;
  probabilities: { [Name in Option]: number };
  confidence: number;
  x_jev_confidence?: number;
};

// The legend and the probabilities are keyed by level number, as text. A
// legend entry is the level as the question gave it, so it may be structured.
export type ScoreAnswer = Added & {
  type: 'score';
  score: number;
  legend: { [level: string]: string | Json[] | { [key: string]: Json } };
  probabilities: { [level: string]: number };
  confidence: number;
  x_jev_confidence?: number;
};

// The probability of yes. Only Laya sends a confidence with it.
export type NoulAnswer = Added & {
  type: 'noul';
  noul: number;
  confidence?: number;
};

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerTo<Asked extends Question> =
  Asked extends ChoiceQuestion<infer Option>
    ? ChoiceAnswer<Option>
    : Asked extends ScoreQuestion
      ? ScoreAnswer
      : NoulAnswer;

export type Answers<Asked extends Questions = Questions> = {
  [Id in keyof Asked]: AnswerTo<Asked[Id]>;
};

export type DecisionOutput<Asked extends Questions = Questions> = {
  model: string;
  answers: Answers<Asked>;
  usage: { input_tokens: number; output_tokens: number };
};
