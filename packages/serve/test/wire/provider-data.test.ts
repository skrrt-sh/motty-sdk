import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { dict, parsed } from '../../src/wire/json.ts';
import { providerData } from '../../src/wire/provider-data.ts';

const { hinted, own, mine, marked, noted } = providerData(
  'openai.chat',
  'Chat Completions',
);

test('only what was written for this wire is read from a map', () => {
  expect(
    hinted({ 'openai.chat': { detail: 'low' }, anthropic: { cache: true } }),
  ).toEqual({ detail: 'low' });
  expect(hinted({ anthropic: { cache: true } })).toEqual({});
  expect(hinted(undefined)).toEqual({});
  expect(hinted({ 'openai.chat': 'not an object' })).toEqual({});
});

test('the other API of one provider is another wire', () => {
  expect(hinted({ openai: { a: 1 }, 'openai.responses': { b: 1 } })).toEqual(
    {},
  );
  expect(() =>
    own({ 'openai.responses': { truncation: 'auto' } }, 'an option'),
  ).toThrow(Unsupported);
});

test('a map with no entry for this wire fails the call', () => {
  expect(() =>
    own({ anthropic: { thinking: { type: 'enabled' } } }, 'an option'),
  ).toThrow(Unsupported);
  expect(() =>
    own({ anthropic: {}, 'openai.responses': { a: 1 } }, 'an option'),
  ).toThrow('Chat Completions cannot carry an option of openai.responses: a');
});

test('a refusal names the fields that cannot be carried, never what they hold', () => {
  expect(() =>
    own(
      { 'openai.responses': { client_metadata: { token: 'sk-secret' } } },
      'options',
    ),
  ).toThrow(
    new Unsupported(
      'Chat Completions cannot carry options of openai.responses: client_metadata',
    ),
  );
  expect(() =>
    own(
      { anthropic: { defer_loading: true, eager_input_streaming: true } },
      'a tool option',
    ),
  ).toThrow(
    new Unsupported(
      'Chat Completions cannot carry a tool option of anthropic: defer_loading, eager_input_streaming',
    ),
  );
});

test('a refusal of an entry with no field names the family alone', () => {
  expect(() => own({ anthropic: 'not an object' }, 'an option')).toThrow(
    new Unsupported('Chat Completions cannot carry an option of anthropic'),
  );
});

test('an empty entry for another wire carries nothing and fails no call', () => {
  expect(own({ 'openai.responses': {} }, 'options')).toEqual({});
  expect(own({ anthropic: {}, 'openai.responses': [] }, 'a part')).toEqual({});
});

test('a refusal names five fields and counts the rest', () => {
  expect(() =>
    own({ anthropic: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 } }, 'a tool'),
  ).toThrow(
    new Unsupported(
      'Chat Completions cannot carry a tool of anthropic: a, b, c, d, e and 2 more',
    ),
  );
});

test.each([[{ anthropic: { caller: { type: 'direct' } } }, {}]])(
  'what a map holds for another wire alone is read as nothing and not refused',
  (data, read) => {
    expect(mine(data)).toEqual(read);
  },
);

test('an empty entry for this wire says there is nothing to add', () => {
  expect(
    own(
      { anthropic: { thinking: { type: 'enabled' } }, 'openai.chat': {} },
      'an option',
    ),
  ).toEqual({});
});

test('no map and an empty map ask for nothing', () => {
  expect(own(undefined, 'an option')).toEqual({});
  expect(own({}, 'an option')).toEqual({});
});

test('fields are written under this wire`s key, and no fields as nothing', () => {
  expect(marked({ logprobs: true })).toEqual({
    provider: { 'openai.chat': { logprobs: true } },
  });
  expect(noted({ store: true })).toEqual({
    hints: { 'openai.chat': { store: true } },
  });
  expect(marked({})).toEqual({});
  expect(noted({})).toEqual({});
});

test('a null or empty field is no reason to hold a request to this wire', () => {
  expect(
    marked({ annotations: [], audio: null, logit_bias: {}, top_logprobs: 0 }),
  ).toEqual({ provider: { 'openai.chat': { top_logprobs: 0 } } });
  expect(marked({ annotations: [], audio: null })).toEqual({});
  expect(marked({ refusal: '', logprobs: false })).toEqual({
    provider: { 'openai.chat': { refusal: '', logprobs: false } },
  });
});

test('a hint is kept as it was given, empty or not', () => {
  expect(noted({ logprobs: [] })).toEqual({
    hints: { 'openai.chat': { logprobs: [] } },
  });
});

const chat = providerData(
  'openai.chat',
  'Chat Completions',
  'openai',
  new Set(['previous_response_id']),
);

test('the provider`s entry is read beside this API`s own, which wins a clash', () => {
  expect(chat.hinted({ openai: { a: 1, b: 1 } })).toEqual({ a: 1, b: 1 });
  expect(
    chat.addressed({
      provider: { openai: { a: 1, b: 1 }, 'openai.chat': { a: 2 } },
    }).provider,
  ).toEqual({ a: 2, b: 1 });
  expect(chat.hinted({ openai: 'not an object' })).toEqual({});
});

test('a field this API`s own entry holds replaces the provider`s whole, however deep either goes', () => {
  expect(
    chat.addressed({
      provider: {
        openai: { reasoning: { effort: 'low', summary: 'detailed' } },
        'openai.chat': { reasoning: { effort: 'high' } },
      },
    }).provider,
  ).toEqual({ reasoning: { effort: 'high' } });
});

test('the provider`s entry, even an empty one, is an entry for this API`s options', () => {
  expect(
    chat.addressed({
      provider: { anthropic: { thinking: { type: 'enabled' } }, openai: {} },
    }).provider,
  ).toEqual({});
  expect(() =>
    chat.addressed({
      provider: { 'openai.responses': { truncation: 'auto' } },
    }),
  ).toThrow(
    'Chat Completions cannot carry an option of openai.responses: truncation',
  );
  expect(
    chat.addressed({ provider: { 'openai.responses': {}, anthropic: {} } })
      .provider,
  ).toEqual({});
});

test('below the options the provider`s entry is no entry: its APIs share no shape there', () => {
  expect(() =>
    chat.own({ openai: { type: 'web_search' } }, 'a provider tool'),
  ).toThrow('Chat Completions cannot carry a provider tool of openai');
  expect(() =>
    chat.own({ anthropic: { defer_loading: true }, openai: {} }, 'a tool'),
  ).toThrow(Unsupported);
  expect(
    chat.own({ openai: { a: 1 }, 'openai.chat': { b: 2 } }, 'a tool'),
  ).toEqual({ b: 2 });
});

test.each([[{ previous_response_id: null }], [{ previous_response_id: [] }]])(
  'another API`s option that says nothing, as %j, fails no call and is not sent',
  (openai) => {
    expect(
      chat.addressed({ provider: { openai: { ...openai, user: 'u' } } }),
    ).toEqual({ provider: { user: 'u' }, hints: {}, leftOut: [] });
  },
);

test('an option under the provider`s key that only another of its APIs has fails the call by name', () => {
  expect(() =>
    chat.addressed({ provider: { openai: { previous_response_id: 'r1' } } }),
  ).toThrow(
    'Chat Completions cannot carry previous_response_id, which another API of openai has',
  );
  expect(() =>
    chat.addressed({ provider: { openai: { previous_response_id: 'r1' } } }),
  ).toThrow(Unsupported);
});

test('such a hint is left out and reported, and the rest is kept', () => {
  expect(
    chat.addressed({
      hints: { openai: { previous_response_id: 'r1', service_tier: 'flex' } },
    }),
  ).toEqual({
    provider: {},
    hints: { service_tier: 'flex' },
    leftOut: [
      {
        setting: 'openai.previous_response_id',
        detail: 'Chat Completions has no field for previous_response_id',
      },
    ],
  });
});

test('what is written under this API`s own key, or is known to neither API, is sent as said', () => {
  expect(
    chat.addressed({
      provider: {
        openai: { previous_response_id: 'r1', some_new_field: 1 },
        'openai.chat': { previous_response_id: 'r2' },
      },
      hints: { 'openai.chat': { previous_response_id: 'r0' } },
    }),
  ).toEqual({
    provider: { previous_response_id: 'r2', some_new_field: 1 },
    hints: { previous_response_id: 'r0' },
    leftOut: [],
  });
});

test('a wire with no provider key holds nothing to that check', () => {
  expect(
    providerData('anthropic', 'Anthropic Messages').addressed({
      provider: { anthropic: { previous_response_id: 'r1' } },
    }),
  ).toEqual({
    provider: { previous_response_id: 'r1' },
    hints: {},
    leftOut: [],
  });
});

test('a field named as the prototype is written as a field, and nothing is read through it', () => {
  const { provider } = marked(
    dict(parsed('{"__proto__":{"logprobs":true},"top_logprobs":0}')),
  );
  const { 'openai.chat': fields } = provider ?? {};

  expect(Object.keys(fields ?? {})).toEqual(['__proto__', 'top_logprobs']);
  expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
});
