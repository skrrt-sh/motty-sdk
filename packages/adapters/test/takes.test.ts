import { expect, test } from 'bun:test';
import * as entry from '../src/takes.ts';
import {
  anthropicTakes,
  dashscopeTakes,
  minimaxTakes,
  mistralTakes,
  moonshotTakes,
  openaiTakes,
  zaiTakes,
} from '../src/takes.ts';

test.each([
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-0',
  'claude-sonnet-4-20250514',
  'claude-opus-4',
  'claude-3-7-sonnet-latest',
  'claude-3-5-haiku-20241022',
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

test.each([
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-3-7-sonnet-latest',
])(
  '%s takes no temperature but one, a high top-p and no top-k while it thinks',
  (model) => {
    expect(anthropicTakes(model, true)).toMatchObject({
      temperature: 1,
      topP: [0.95, 1],
      topK: false,
    });
  },
);

test('a Claude model told not to think samples as one that says nothing of it', () => {
  expect(anthropicTakes('claude-sonnet-4-6', false)).toEqual(
    anthropicTakes('claude-sonnet-4-6', undefined),
  );
});

test.each([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-haiku-5-5',
  'claude-mythos-5-1',
  'claude-opus-4-10',
  'claude-opus-6',
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
  'claude-opus-4-5-20251101',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-haiku-5-5',
])('%s takes an effort', (model) => {
  expect(anthropicTakes(model, true)).toMatchObject({ effort: true });
});

test.each([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-sonnet-4-0',
  'claude-opus-4-20250514',
  'claude-3-7-sonnet-latest',
  'claude-3-haiku-20240307',
])('%s takes no effort', (model) => {
  expect(anthropicTakes(model, true)).toMatchObject({ effort: false });
});

test.each([
  ['claude-haiku-4.5', 'claude-haiku-4-5'],
  ['claude-opus-4.7', 'claude-opus-4-7'],
  ['claude-3.5-sonnet', 'claude-3-5-sonnet'],
  ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
])(
  '%s, a version written with a dot, is held to the rule of %s',
  (dotted, dashed) => {
    expect(anthropicTakes(dotted, undefined)).toEqual(
      anthropicTakes(dashed, undefined),
    );
    expect(anthropicTakes(dotted, true)).toEqual(anthropicTakes(dashed, true));
  },
);

test.each([
  ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude-3-5-sonnet-20241022'],
  ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
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

test.each([
  'gpt-4.1',
  'gpt-4.1-mini-2025-04-14',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini-2024-07-18',
  'gpt-4-turbo',
  'gpt-4-0613',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-16k',
  'ft:gpt-4o-mini-2024-07-18:acme::9xYz',
  'ft:gpt-4.1-2025-04-14:acme::9xYz',
  'ft:gpt-3.5-turbo-0125:acme::9xYz',
  'gpt-35-turbo',
  'gpt-4o:batch',
])(
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

test.each([
  'gpt-5-search-api',
  'gpt-5-search-api-2025-10-14',
  'gpt-4o-search-preview',
  'gpt-4o-mini-search-preview-2025-03-11',
])(
  '%s, a search model, neither samples nor takes an effort, whatever the request says of reasoning',
  (model) => {
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
  },
);

test.each([
  'gpt-5.1',
  'gpt-5.1-2025-11-13',
  'gpt-5.2',
  'gpt-5.2-2025-12-11',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-2026-03-05',
  'gpt-5.4-mini',
  'gpt-5.4-mini-2026-03-17',
  'gpt-5.4-nano',
  'gpt-5.4-nano-2026-03-17',
  'gpt-5.1:batch',
  'ft:gpt-5.4-mini-2026-03-17:acme::9xYz',
])('%s samples unless the request reasons', (model) => {
  expect(openaiTakes(model, undefined)).toMatchObject({
    temperature: [0, 2],
    presencePenalty: true,
    frequencyPenalty: true,
    effort: true,
  });
  expect(openaiTakes(model, false)).toEqual(openaiTakes(model, undefined));
  expect(openaiTakes(model, true)).toMatchObject({
    temperature: 1,
    topP: 1,
    presencePenalty: false,
    frequencyPenalty: false,
    effort: true,
  });
});

test.each([
  'gpt-5.5',
  'gpt-5.5-2026-04-23',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-luna',
  'gpt-6-sol',
])('%s samples only when the request says not to reason', (model) => {
  expect(openaiTakes(model, false)).toMatchObject({
    temperature: [0, 2],
    presencePenalty: true,
    frequencyPenalty: true,
    effort: true,
  });
  expect(openaiTakes(model, undefined)).toEqual({
    temperature: 1,
    topP: 1,
    topK: false,
    presencePenalty: false,
    frequencyPenalty: false,
    together: true,
    effort: true,
  });
  expect(openaiTakes(model, true)).toEqual(openaiTakes(model, undefined));
});

test.each([
  'o1',
  'o3-mini',
  'o4-mini-2025-04-16',
  'o1-pro',
  'o3-pro',
  'ft:o4-mini-2025-04-16:acme::9xYz',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano-2025-08-07',
  'gpt-5-pro',
  'gpt-5.2-pro',
  'gpt-5.4-pro-2026-03-05',
  'gpt-5.5-pro',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'chat-latest',
])(
  '%s, which never samples and refuses the order not to reason, is held to the newest behaviour and takes an effort',
  (model) => {
    expect(openaiTakes(model, undefined)).toMatchObject({
      temperature: 1,
      topP: 1,
      presencePenalty: false,
      frequencyPenalty: false,
      effort: true,
    });
    expect(openaiTakes(model, true)).toEqual(openaiTakes(model, undefined));
    expect(openaiTakes(model, false)).toEqual(openaiTakes('gpt-5.5', false));
  },
);

test.each([
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2-codex',
  'gpt-5-codex',
  'gpt-5-chat-latest',
  'gpt-5.1-chat-latest',
  'gpt-5.2-chat-latest',
  'gpt-5.3-chat-latest',
  'chatgpt-4o-latest',
  'o3-deep-research',
])(
  '%s, which did not answer when it was asked, is held to the newest behaviour',
  (model) => {
    expect(openaiTakes(model, undefined)).toEqual(
      openaiTakes('gpt-5.5', undefined),
    );
    expect(openaiTakes(model, true)).toEqual(openaiTakes('gpt-5.5', true));
    expect(openaiTakes(model, false)).toEqual(openaiTakes('gpt-5.5', false));
  },
);

test.each([
  'gpt-5.3',
  'gpt-5.4-turbo',
  'gpt-5.4-mini-high',
  'gpt-5.2-chat',
  'gpt-5.1-pro',
  'gpt-5.10',
  'gpt-5.6-luna-pro',
  'gpt-6',
  'gpt-7-mini',
  'o5',
  'model-of-next-year',
])(
  '%s, a name nobody asked, is held to the newest behaviour and not to that of a name it starts with',
  (model) => {
    expect(openaiTakes(model, undefined)).toEqual(
      openaiTakes('gpt-5.5', undefined),
    );
    expect(openaiTakes(model, true)).toEqual(openaiTakes('gpt-5.5', true));
    expect(openaiTakes(model, false)).toEqual(openaiTakes('gpt-5.5', false));
  },
);

test.each(['gpt-5.4-mini', 'gpt-5.6-luna', 'model-of-next-year'])(
  '%s, which can reason, takes no top-p of zero while it samples',
  (model) => {
    expect(openaiTakes(model, false)).toMatchObject({ topP: [0.01, 1] });
  },
);

test.each(['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k4'])(
  '%s allows one temperature and one top-p, and takes no penalty, by Kimi`s reference',
  (model) => {
    expect(moonshotTakes(model, undefined)).toMatchObject({
      temperature: 1,
      topP: 0.95,
      presencePenalty: false,
      frequencyPenalty: false,
    });
  },
);

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

test('a GLM model takes a temperature up to one, a top-p above zero and no penalty, by its reference', () => {
  expect(zaiTakes('glm-5.3', undefined)).toEqual({
    temperature: [0, 1],
    topP: [0.01, 1],
    topK: false,
    presencePenalty: false,
    frequencyPenalty: false,
    together: true,
    effort: true,
  });
});

test('a Qwen model takes a temperature below two and a top-p above zero, by its reference', () => {
  expect(dashscopeTakes('qwen3.7-plus', undefined)).toEqual({
    temperature: [0, 1.99],
    topP: [0.01, 1],
    topK: true,
    presencePenalty: true,
    frequencyPenalty: true,
    together: true,
    effort: true,
  });
});

test.each([
  'deepseek-v4-pro',
  'kimi-k3',
  'Moonshot-Kimi-K2-Instruct',
  'MiniMax-M3',
])('%s, served beside Qwen, takes no top-k, by the same reference', (model) => {
  expect(dashscopeTakes(model, undefined)).toMatchObject({ topK: false });
});

test('a GLM model served beside Qwen takes top-k, by the same reference', () => {
  expect(dashscopeTakes('glm-5.3', undefined)).toMatchObject({ topK: true });
});

test('a MiniMax model takes a temperature up to two and no penalty, by its reference', () => {
  expect(minimaxTakes('MiniMax-M2.7', undefined)).toEqual({
    temperature: [0, 2],
    topP: [0, 1],
    topK: false,
    presencePenalty: false,
    frequencyPenalty: false,
    together: true,
    effort: true,
  });
});

test('a Mistral model takes a temperature up to one and a half, a top-p above zero and no top-k, by its reference', () => {
  expect(mistralTakes('mistral-small-latest', undefined)).toEqual({
    temperature: [0, 1.5],
    topP: [0.01, 1],
    topK: false,
    presencePenalty: true,
    frequencyPenalty: true,
    together: true,
    effort: true,
  });
});

test('the entry a host imports the rules from exports exactly them, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/takes.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual([
    'anthropicTakes',
    'dashscopeTakes',
    'minimaxTakes',
    'mistralTakes',
    'moonshotTakes',
    'openaiTakes',
    'zaiTakes',
  ]);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
