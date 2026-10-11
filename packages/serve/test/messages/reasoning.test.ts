import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import {
  reasoningOf,
  reasoningTo,
  unsaid,
} from '../../src/messages/reasoning.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('a request with no thinking and no effort asks for no reasoning', () => {
  expect(reasoningOf(undefined, undefined)).toEqual({
    kept: {},
    verbatim: {},
    shown: false,
  });
});

test('a thinking budget is the reasoning budget, shown to the caller', () => {
  expect(
    reasoningOf({ type: 'enabled', budget_tokens: 10000 }, undefined),
  ).toEqual({
    reasoning: { budgetTokens: 10000 },
    kept: { thinking: { type: 'enabled' } },
    verbatim: {},
    shown: true,
  });
});

test('adaptive thinking keeps its mode and takes the effort', () => {
  expect(
    reasoningOf({ type: 'adaptive', display: 'summarized' }, 'xhigh'),
  ).toEqual({
    reasoning: { effort: 'xhigh' },
    kept: { thinking: { type: 'adaptive', display: 'summarized' } },
    verbatim: {},
    shown: true,
  });
});

test('omitted display excludes reasoning and mutes progress', () => {
  expect(
    reasoningOf(
      { type: 'enabled', budget_tokens: 2048, display: 'omitted' },
      undefined,
    ),
  ).toEqual({
    reasoning: { budgetTokens: 2048, exclude: true },
    kept: { thinking: { type: 'enabled' } },
    verbatim: {},
    shown: false,
  });
});

test('disabled thinking is no effort, and the effort sent stays a hint', () => {
  expect(reasoningOf({ type: 'disabled' }, 'low')).toEqual({
    reasoning: { effort: 'none' },
    kept: { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
    verbatim: {},
    shown: false,
  });
});

test('effort alone is the reasoning effort, kept as sent alone', () => {
  expect(reasoningOf(undefined, 'max')).toEqual({
    reasoning: { effort: 'max' },
    kept: { output_config: { effort: 'max' } },
    verbatim: {},
    shown: false,
  });
});

test('a thinking mode not known here travels as it was sent', () => {
  expect(reasoningOf({ type: 'between_tools' }, undefined)).toEqual({
    kept: {},
    verbatim: { thinking: { type: 'between_tools' } },
    shown: false,
  });
  expect(reasoningOf({ type: 'between_tools' }, 'medium')).toEqual({
    reasoning: { effort: 'medium' },
    kept: { output_config: { effort: 'medium' } },
    verbatim: { thinking: { type: 'between_tools' } },
    shown: false,
  });
});

test('malformed thinking and an unknown effort are rejected', () => {
  expect(() => reasoningOf('enabled', undefined)).toThrow(InvalidRequest);
  expect(() => reasoningOf({ type: 'enabled' }, undefined)).toThrow(
    InvalidRequest,
  );
  expect(() => reasoningOf({ budget_tokens: 1 }, undefined)).toThrow(
    InvalidRequest,
  );
  expect(() => reasoningOf(undefined, 'minimal')).toThrow(InvalidRequest);
});

test('no reasoning sends no thinking', () => {
  const left = leaving('messages');
  expect(reasoningTo(left, undefined, undefined, undefined)).toEqual({});
  expect(reasoningTo(left, {}, undefined, undefined)).toEqual({});
  expect(left.leftOut()).toEqual([]);
});

test('an order not to reason is the lowest effort with no thinking field, and is reported', () => {
  const left = leaving('messages');
  expect(reasoningTo(left, { effort: 'none' }, undefined, undefined)).toEqual({
    effort: 'low',
  });
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning.none',
      detail:
        'Anthropic Messages has no field for an order not to reason, sent as low effort',
    },
  ]);
});

test('an order not to reason beside a mute or a budget still sends no adaptive thinking', () => {
  expect(
    reasoningTo(
      leaving('messages'),
      { effort: 'none', exclude: true },
      undefined,
      undefined,
    ),
  ).toEqual({ effort: 'low' });
  expect(
    reasoningTo(
      leaving('messages'),
      { effort: 'none', budgetTokens: 2048 },
      undefined,
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
    effort: 'low',
  });
});

test('an effort is adaptive thinking, shown, at the nearest level', () => {
  const left = leaving('messages');
  expect(
    reasoningTo(left, { effort: 'minimal' }, undefined, undefined),
  ).toEqual({
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: 'low',
  });
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning.minimal',
      detail: 'Anthropic Messages has no field for minimal effort, sent as low',
    },
  ]);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const asked = leaving('messages');
    expect(reasoningTo(asked, { effort }, undefined, undefined)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort,
    });
    expect(asked.leftOut()).toEqual([]);
  }
});

test('an effort with reasoning muted is adaptive thinking, omitted', () => {
  expect(
    reasoningTo(
      leaving('messages'),
      { effort: 'high', exclude: true },
      undefined,
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'adaptive', display: 'omitted' },
    effort: 'high',
  });
});

test('a budget is manual thinking, shown', () => {
  expect(
    reasoningTo(
      leaving('messages'),
      { budgetTokens: 4096 },
      undefined,
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' },
  });
});

test('a budget with reasoning muted is manual thinking, omitted', () => {
  expect(
    reasoningTo(
      leaving('messages'),
      { budgetTokens: 4096, exclude: true },
      undefined,
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'enabled', budget_tokens: 4096, display: 'omitted' },
  });
});

test('a mute alone asks for no thinking, so there is none to show', () => {
  const left = leaving('messages');
  expect(reasoningTo(left, { exclude: true }, undefined, undefined)).toEqual(
    {},
  );
  expect(left.leftOut()).toEqual([]);
});

test('a budget and an effort are manual thinking beside the effort', () => {
  expect(
    reasoningTo(
      leaving('messages'),
      { budgetTokens: 4096, effort: 'high' },
      undefined,
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' },
    effort: 'high',
  });
  expect(
    reasoningTo(
      leaving('messages'),
      { budgetTokens: 4096, effort: 'high', exclude: true },
      undefined,
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'enabled', budget_tokens: 4096, display: 'omitted' },
    effort: 'high',
  });
});

test("the caller's own mode and display are written back as said", () => {
  const left = leaving('messages');
  expect(
    reasoningTo(
      left,
      { effort: 'medium' },
      { type: 'adaptive', display: 'updates' },
      undefined,
    ),
  ).toEqual({
    thinking: { type: 'adaptive', display: 'updates' },
    effort: 'medium',
  });
  expect(reasoningTo(left, {}, { type: 'adaptive' }, undefined)).toEqual({
    thinking: { type: 'adaptive' },
  });
  expect(
    reasoningTo(left, { exclude: true }, { type: 'adaptive' }, undefined),
  ).toEqual({ thinking: { type: 'adaptive', display: 'omitted' } });
  expect(
    reasoningTo(left, { budgetTokens: 2048 }, { type: 'enabled' }, undefined),
  ).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
  expect(left.leftOut()).toEqual([]);
});

test('an effort this family`s caller sent alone is sent alone', () => {
  const left = leaving('messages');
  expect(
    reasoningTo(left, { effort: 'xhigh' }, undefined, { effort: 'xhigh' }),
  ).toEqual({ effort: 'xhigh' });
  expect(left.leftOut()).toEqual([]);
});

test('thinking this family`s caller turned off in its own words stays turned off, unreported', () => {
  const left = leaving('messages');
  expect(
    reasoningTo(left, { effort: 'none' }, { type: 'disabled' }, undefined),
  ).toEqual({ thinking: { type: 'disabled' } });
  expect(
    reasoningTo(
      left,
      { effort: 'none' },
      { type: 'disabled' },
      {
        effort: 'low',
      },
    ),
  ).toEqual({ thinking: { type: 'disabled' } });
  expect(left.leftOut()).toEqual([]);
});

test('a hinted form the reasoning asked for does not take is reported, not dropped silently', () => {
  const off = leaving('messages');
  expect(
    reasoningTo(off, { effort: 'none' }, { type: 'adaptive' }, undefined),
  ).toEqual({ effort: 'low' });
  expect(off.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.none',
    'reasoning.hint',
  ]);

  const on = leaving('messages');
  expect(
    reasoningTo(on, { effort: 'high' }, { type: 'disabled' }, undefined),
  ).toEqual({ effort: 'high' });
  expect(on.leftOut()).toEqual([
    {
      setting: 'reasoning.hint',
      detail:
        'Anthropic Messages has no field for a hint of thinking the reasoning asked for does not take',
    },
  ]);

  const silent = leaving('messages');
  expect(
    reasoningTo(silent, undefined, { type: 'adaptive' }, undefined),
  ).toEqual({});
  expect(silent.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.hint',
  ]);
});

test('beside thinking in the author`s own words an effort is still sent, and a budget and a mute are reported', () => {
  const effort = leaving('messages');
  expect(
    reasoningTo(effort, { effort: 'high' }, undefined, undefined, {
      type: 'between_tools',
    }),
  ).toEqual({ effort: 'high' });
  expect(effort.leftOut()).toEqual([]);

  const budget = leaving('messages');
  expect(
    reasoningTo(
      budget,
      { effort: 'high', budgetTokens: 2048, exclude: true },
      undefined,
      undefined,
      { type: 'between_tools' },
    ),
  ).toEqual({ effort: 'high' });
  expect(budget.leftOut()).toEqual([
    {
      setting: 'reasoning.own',
      detail:
        "Anthropic Messages has no field for a reasoning option the request also states in the API's own words",
    },
  ]);

  const mute = leaving('messages');
  expect(
    reasoningTo(mute, { exclude: true }, undefined, undefined, {
      type: 'between_tools',
    }),
  ).toEqual({});
  expect(mute.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.own',
  ]);

  const silent = leaving('messages');
  expect(
    reasoningTo(silent, undefined, undefined, undefined, {
      type: 'between_tools',
    }),
  ).toEqual({});
  expect(silent.leftOut()).toEqual([]);
});

test('an order not to reason beside the author`s own thinking is the lowest effort, unless that thinking is off', () => {
  const kept = leaving('messages');
  expect(
    reasoningTo(kept, { effort: 'none' }, undefined, undefined, {
      type: 'between_tools',
    }),
  ).toEqual({ effort: 'low' });
  expect(kept.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.none',
  ]);

  const off = leaving('messages');
  expect(
    reasoningTo(off, { effort: 'none' }, undefined, undefined, {
      type: 'disabled',
    }),
  ).toEqual({});
  expect(off.leftOut()).toEqual([]);
});

test('a hint of thinking beside the author`s own thinking is reported', () => {
  const left = leaving('messages');
  expect(
    reasoningTo(left, { effort: 'high' }, { type: 'adaptive' }, undefined, {
      type: 'between_tools',
    }),
  ).toEqual({ effort: 'high' });
  expect(left.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.hint',
  ]);
});

test.each([
  [{ effort: 'high' } as const],
  [{ budgetTokens: 2048 }],
  [{ exclude: true }],
  [{ effort: 'none' } as const],
])(
  'a request that says %j is sent none of the connection`s reasoning fields',
  (reasoning) => {
    expect(
      unsaid(reasoning, {
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'low' },
        top_k: 40,
      }),
    ).toEqual({ top_k: 40 });
    expect(
      unsaid(reasoning, {
        output_config: { effort: 'low', task_budget: { total: 9000 } },
      }),
    ).toEqual({ output_config: { task_budget: { total: 9000 } } });
  },
);

test.each([[undefined], [{}], [{ exclude: false }]])(
  'a request whose reasoning is %j says nothing, and is sent the connection`s as stated',
  (reasoning) => {
    expect(
      unsaid(reasoning, {
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'low' },
      }),
    ).toEqual({
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'low' },
    });
  },
);
