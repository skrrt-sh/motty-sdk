import { expect, test } from 'bun:test';
import {
  anthropicTakes,
  dashscopeTakes,
  moonshotTakes,
  openaiChatTakes,
  openaiTakes,
} from '../src/takes.ts';

test.each([
  'claude-sonnet-4-6',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-20250514',
  'claude-opus-4',
  'claude-3-haiku-20240307',
])(
  '%s takes a temperature, top-p and top-k, but not the first two together',
  (model) => {
    expect(anthropicTakes(model, undefined)).toMatchObject({
      temperature: [0, 1],
      topP: [0, 1],
      topK: true,
      together: false,
      presencePenalty: false,
      frequencyPenalty: false,
    });
  },
);

test('a Claude model that samples takes no temperature but one, a high top-p and no top-k while it thinks', () => {
  expect(anthropicTakes('claude-sonnet-4-6', true)).toMatchObject({
    temperature: 1,
    topP: [0.95, 1],
    topK: false,
  });
});

test('a Claude model told not to think samples as one that says nothing of it', () => {
  expect(anthropicTakes('claude-sonnet-4-6', false)).toEqual(
    anthropicTakes('claude-sonnet-4-6', undefined),
  );
});

test.each([
  'claude-opus-4-7',
  'claude-opus-4-10',
  'claude-opus-5',
  'claude-next',
])(
  '%s takes no temperature but one, no top-p but one and no top-k, thinking or not',
  (model) => {
    const fixed = {
      temperature: 1,
      topP: 0.99,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    };
    expect(anthropicTakes(model, undefined)).toEqual(fixed);
    expect(anthropicTakes(model, true)).toEqual(fixed);
    expect(anthropicTakes(model, false)).toEqual(fixed);
  },
);

test.each([
  ['claude-opus-4-5-20251101', ['low', 'medium', 'high']],
  ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
  ['claude-opus-4-7', true],
])('%s takes an effort, at the levels it has a word for', (model, effort) => {
  expect(anthropicTakes(model, true)).toMatchObject({ effort });
  expect(anthropicTakes(model, undefined)).toMatchObject({ effort });
});

test.each(['claude-sonnet-4-5', 'claude-opus-4-1'])(
  '%s takes no effort',
  (model) => {
    expect(anthropicTakes(model, true)).toMatchObject({ effort: false });
  },
);

test.each(['claude-opus-4-5', 'claude-haiku-4-5'])(
  '%s thinks only on a budget',
  (model) => {
    expect(anthropicTakes(model, true)).toMatchObject({ adaptive: false });
    expect(anthropicTakes(model, undefined)).toMatchObject({ adaptive: false });
  },
);

test.each(['claude-sonnet-4-6', 'claude-opus-4-7'])(
  '%s may be left to set its own thinking',
  (model) => {
    expect(anthropicTakes(model, true)?.adaptive).not.toBe(false);
    expect(anthropicTakes(model, undefined)?.adaptive).not.toBe(false);
  },
);

test('a version written with a dot is held to the rule of the one written with a dash', () => {
  expect(anthropicTakes('claude-opus-4.7', undefined)).toEqual(
    anthropicTakes('claude-opus-4-7', undefined),
  );
  expect(anthropicTakes('claude-opus-4.7', true)).toEqual(
    anthropicTakes('claude-opus-4-7', true),
  );
});

test.each([
  ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude-3-5-sonnet-20241022'],
  ['us-gov.anthropic.claude-opus-4-7-v1:0', 'claude-opus-4-7'],
])(
  '%s, named as a cloud serves it, is held to the rule of %s',
  (hosted, plain) => {
    expect(anthropicTakes(hosted, undefined)).toEqual(
      anthropicTakes(plain, undefined),
    );
    expect(anthropicTakes(hosted, true)).toEqual(anthropicTakes(plain, true));
  },
);

test.each(['gpt-4o', 'gpt-35-turbo', 'ft:gpt-3.5-turbo-0125:acme::9xYz'])(
  '%s samples whatever the request says of reasoning, and takes no effort',
  (model) => {
    expect(openaiTakes(model, undefined)).toEqual({
      temperature: [0, 2],
      topP: [0, 1],
      topK: false,
      presencePenalty: true,
      frequencyPenalty: true,
      together: true,
      effort: false,
    });
    expect(openaiTakes(model, true)).toEqual(openaiTakes(model, undefined));
    expect(openaiTakes(model, false)).toEqual(openaiTakes(model, undefined));
  },
);

test('a search model neither samples nor takes an effort, whatever the request says of reasoning', () => {
  const model = 'gpt-4o-search-preview';

  expect(openaiTakes(model, undefined)).toEqual({
    temperature: 1,
    topP: 1,
    topK: false,
    presencePenalty: false,
    frequencyPenalty: false,
    together: true,
    effort: false,
  });
  expect(openaiTakes(model, true)).toEqual(openaiTakes(model, undefined));
  expect(openaiTakes(model, false)).toEqual(openaiTakes(model, undefined));
});

test.each([
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.4-nano-2026-03-17',
  'gpt-5.1:batch',
  'ft:gpt-5.4-mini-2026-03-17:acme::9xYz',
])('%s samples unless the request reasons', (model) => {
  expect(openaiTakes(model, undefined)).toMatchObject({
    temperature: [0, 2],
    presencePenalty: true,
    frequencyPenalty: true,
  });
  expect(openaiTakes(model, false)).toEqual(openaiTakes(model, undefined));
  expect(openaiTakes(model, true)).toMatchObject({
    temperature: 1,
    topP: 1,
    presencePenalty: false,
    frequencyPenalty: false,
  });
});

test('a model past the closed list samples only when the request says not to reason', () => {
  expect(openaiTakes('gpt-5.5', false)).toMatchObject({
    temperature: [0, 2],
    presencePenalty: true,
    frequencyPenalty: true,
  });
  expect(openaiTakes('gpt-5.5', undefined)).toMatchObject({
    temperature: 1,
    topP: 1,
    topK: false,
    presencePenalty: false,
    frequencyPenalty: false,
    together: true,
  });
  expect(openaiTakes('gpt-5.5', true)).toEqual(
    openaiTakes('gpt-5.5', undefined),
  );
});

test.each(['o1', 'gpt-5'])(
  '%s, which never samples and refuses the order not to reason, is held to the newest behaviour',
  (model) => {
    expect(openaiTakes(model, undefined)).toMatchObject({
      temperature: 1,
      topP: 1,
      presencePenalty: false,
      frequencyPenalty: false,
    });
    expect(openaiTakes(model, true)).toEqual(openaiTakes(model, undefined));
    expect(openaiTakes(model, false)).toMatchObject({
      ...openaiTakes('gpt-5.5', false),
      effort: openaiTakes(model, undefined)?.effort,
    });
  },
);

const o = ['low', 'medium', 'high'] as const;
const first = ['minimal', 'low', 'medium', 'high'] as const;
const stoppable = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
const pro = ['medium', 'high', 'xhigh'] as const;
const newest = ['low', 'medium', 'high', 'xhigh'] as const;

// Each row is what the model named in its own refusal when it was asked live.
test.each([
  ['chat-latest', ['medium'], ['medium']],
  ['ft:o4-mini-2025-04-16:acme::9xYz', o, [...o, 'xhigh']],
  ['gpt-5-pro', ['high'], ['high']],
  ['gpt-5-nano-2025-08-07', first, first],
  [
    'gpt-5.1',
    ['none', 'low', 'medium', 'high'],
    ['none', 'low', 'medium', 'high'],
  ],
  ['gpt-5.2', stoppable, stoppable],
  ['gpt-5.3-codex', stoppable, stoppable],
  ['gpt-5.4-mini-2026-03-17', stoppable, stoppable],
  ['gpt-5.5-pro-2026-04-23', pro, pro],
  ['gpt-5.6-luna', [...stoppable, 'max'], stoppable],
  ['gpt-6-sol', [...stoppable, 'max'], stoppable],
  ['gpt-6.1-sol', [...newest, 'max'], newest],
  ['gpt-7', [...newest, 'max'], newest],
] as const)(
  '%s takes the effort levels it has a word for on each API',
  (model, responses, chat) => {
    for (const reasons of [true, false, undefined]) {
      expect(openaiTakes(model, reasons)?.effort).toEqual(responses);
      expect(openaiChatTakes(model, reasons)?.effort).toEqual(chat);
    }
  },
);

test('the two OpenAI rules differ only in the effort levels', () => {
  for (const model of ['gpt-4o', 'gpt-5.4', 'gpt-6.1-sol', 'o3']) {
    expect({ ...openaiChatTakes(model, true), effort: undefined }).toEqual({
      ...openaiTakes(model, true),
      effort: undefined,
    });
  }
});

test.each([
  'gpt-5.1-codex',
  'gpt-5-chat-latest',
  'o3-deep-research',
  'gpt-5.3',
  'gpt-5.10',
  'gpt-5.1-pro',
  'gpt-5.6-luna-pro',
])(
  '%s, a name that did not answer or nobody asked, is held to the newest behaviour and not to that of a name it starts with',
  (model) => {
    for (const reasons of [undefined, true, false]) {
      expect(openaiTakes(model, reasons)).toMatchObject({
        ...openaiTakes('gpt-5.5', reasons),
        effort: ['low', 'medium', 'high', 'xhigh', 'max'],
      });
    }
  },
);

test('a model that can reason takes no top-p of zero while it samples', () => {
  expect(openaiTakes('gpt-5.4-mini', false)).toMatchObject({
    topP: [0.01, 1],
  });
});

test('a Kimi model allows one temperature and one top-p, and takes no penalty, by Kimi`s reference', () => {
  expect(moonshotTakes('kimi-k3', undefined)).toMatchObject({
    temperature: 1,
    topP: 0.95,
    presencePenalty: false,
    frequencyPenalty: false,
  });
});

test('a K2 model allows another temperature once told not to think, and a coding model, which always thinks, does not', () => {
  expect(moonshotTakes('kimi-k2.6', false)).toMatchObject({ temperature: 0.6 });
  expect(moonshotTakes('kimi-k2.6', true)).toMatchObject({ temperature: 1 });
  expect(moonshotTakes('kimi-k2.7-code', false)).toMatchObject({
    temperature: 1,
  });
  expect(moonshotTakes('kimi-k3', false)).toMatchObject({ temperature: 1 });
});

test('an older Moonshot model still samples, with a temperature up to one', () => {
  expect(moonshotTakes('moonshot-v1-8k', undefined)).toMatchObject({
    temperature: [0, 1],
    topP: [0, 1],
    presencePenalty: true,
    frequencyPenalty: true,
  });
});

test('a model of another maker served beside Qwen takes no top-k, by the same reference', () => {
  expect(dashscopeTakes('MiniMax-M3', undefined)).toMatchObject({
    topK: false,
  });
});

test('a GLM model served beside Qwen takes top-k, by the same reference', () => {
  expect(dashscopeTakes('glm-5.3', undefined)).toMatchObject({ topK: true });
});
