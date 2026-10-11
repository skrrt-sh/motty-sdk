import { expect, test } from 'bun:test';
import type {
  Answers,
  ChoiceQuestion,
  NoulQuestion,
  ScoreQuestion,
  Structured,
} from '../src/wire.ts';

test('answers are typed from the questions asked', () => {
  // Never called: what the types refuse here is checked by the compiler.
  const read = ({
    tier,
    risk,
    software,
  }: Answers<{
    tier: ChoiceQuestion<'quick' | 'deep'>;
    risk: ScoreQuestion;
    software: NoulQuestion;
  }>) => {
    const picked: 'quick' | 'deep' = tier.choice;
    const level: number = risk.score;
    const meant: Structured | undefined = risk.legend['0'];
    const yes: number = software.noul;
    const ported: number | undefined = tier.x_jev_confidence;
    const sure: number | undefined = software.confidence;
    const acted: number | undefined = risk.action?.act_probability;
    const flagged: true | undefined = tier.low_confidence;
    const gate: 'passed' | 'abstained' | 'unevaluated' | undefined =
      software.abstention;
    // @ts-expect-error
    const wrong: 'quick' | 'huge' = tier.choice;
    // @ts-expect-error
    const text: string | undefined = risk.legend['0'];
    // @ts-expect-error
    tier.probabilities.huge;
    // @ts-expect-error
    tier.noul;
    // @ts-expect-error
    software.x_jev_confidence;
    // @ts-expect-error
    risk.choice;
    return [
      picked,
      level,
      meant,
      yes,
      ported,
      sure,
      acted,
      flagged,
      gate,
      wrong,
      text,
    ];
  };

  expect(read).toBeFunction();
});
