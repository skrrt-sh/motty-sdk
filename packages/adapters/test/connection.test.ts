import { expect, test } from 'bun:test';
import {
  addressed,
  broken,
  credentials,
  endpoint,
  moved,
  prefixed,
  told,
} from '../src/connection.ts';

test('a failure under a signal that fired is the stop', () => {
  expect(
    broken(AbortSignal.abort(), new Error('socket closed'), (text) => text),
  ).toEqual({
    code: 'aborted',
    status: 499,
    message: 'The call was stopped',
  });
});

test('any other failure is the upstream, worth another try', () => {
  expect(
    broken(
      new AbortController().signal,
      new Error('socket closed'),
      (text) => text,
    ),
  ).toEqual({
    code: 'upstream_failed',
    status: 502,
    message: 'The connection to the upstream failed',
    retryable: true,
    upstream: true,
    cause: 'socket closed',
  });
});

test('one slash stands between an address and a path, however each was written', () => {
  expect([
    endpoint('https://api.example/v1', '/responses'),
    endpoint('https://api.example/v1/', '/responses'),
    endpoint('https://api.example/v1//', 'responses'),
    endpoint('https://api.example/v1', 'chat/completions'),
  ]).toEqual([
    'https://api.example/v1/responses',
    'https://api.example/v1/responses',
    'https://api.example/v1/responses',
    'https://api.example/v1/chat/completions',
  ]);
});

test('a platform that quotes the key or a header in its failure has both cut from the cause', () => {
  const { clean } = credentials(
    'acme',
    'sk-test-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1',
    undefined,
    {
      'x-portkey-api-key': 'pk-Zq7Lm2Xv9Rt4Kp8Wd3Nh',
    },
  );

  expect(
    broken(
      new AbortController().signal,
      new Error(
        "Header 'authorization' has invalid value: 'Bearer sk-test-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1' beside pk-Zq7Lm2Xv9Rt4Kp8Wd3Nh",
      ),
      clean,
    ),
  ).toMatchObject({
    message: 'The connection to the upstream failed',
    cause:
      "Header 'authorization' has invalid value: 'Bearer [key]' beside [key]",
  });
});

test('the adapter`s own sentence is not cut, whatever word the key is', () => {
  const { clean } = credentials('acme', 'upstream', undefined);

  expect(
    broken(
      new AbortController().signal,
      new Error('no route to upstream'),
      clean,
    ),
  ).toMatchObject({
    message: 'The connection to the upstream failed',
    cause: 'no route to [key]',
  });
});

test('a header of fifteen characters is not cut, and one of sixteen is', () => {
  const { clean } = credentials('acme', undefined, undefined, {
    'x-short': 'Zq7Lm2Xv9Rt4Kp8',
    'x-long': 'Wd3Nh6Bc1Zq7Lm2X',
  });

  expect(clean('Sent Zq7Lm2Xv9Rt4Kp8 and Wd3Nh6Bc1Zq7Lm2X')).toBe(
    'Sent Zq7Lm2Xv9Rt4Kp8 and [key]',
  );
});

test.each([
  ['Customer-Support-Desk', 'Please contact your Customer-Support'],
  ['pk-Zq7Lm2Xv9Rt4Kp8Wd3Nh', 'key pk-Zq7Lm2Xv****d3Nh'],
  ['pk-Zq7Lm2Xv9Rt4Kp8Wd3Nh', '{"x-portkey-api-key":"pk-Zq7Lm2'],
])(
  'no part of the header %s is cut, inside a sentence or where the text ends: %s',
  (value, message) => {
    const { clean } = credentials('acme', undefined, undefined, {
      'x-held': value,
    });

    expect(clean(message)).toBe(message);
    expect(clean(`${message}.`)).toBe(`${message}.`);
  },
);

test.each([
  ['a tab after its scheme', 'Bearer\tZq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1'],
  ['pairs as a cookie has', 'session=Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1; theme=dark'],
  ['a list', 'acme,Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1'],
])(
  'a header whose secret stands with %s has the secret cut where it is echoed alone, and the value whole',
  (_, value) => {
    const { clean } = credentials('acme', undefined, undefined, {
      'x-held': value,
    });

    expect(
      clean(
        `Refused Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1, sent as ${value.trim()}, for tenant acme in theme dark at v2`,
      ),
    ).toBe('Refused [key], sent as [key], for tenant acme in theme dark at v2');
  },
);

test.each([
  ['by its first four', 'key sk-p...', 'key [key]...'],
  ['by its last four', 'key ...5Gj0', 'key ...[key]'],
  ['by eight of its middle', 'key ..Xv9Rt4Kp..', 'key ..[key]..'],
  [
    'across a line break',
    'sk-proj-Zq7Lm2Xv9Rt\n4Kp8Wd3Nh6Bc1Yf5Gj0',
    '[key]\n[key]',
  ],
  [
    'inside a longer token',
    'AAAAsk-proj-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1Yf5Gj0BBBB',
    'AAAA[key]BBBB',
  ],
])('a key of a provider`s length is cut %s', (_, message, cleaned) => {
  const { clean } = credentials(
    'acme',
    'sk-proj-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1Yf5Gj0',
    undefined,
  );

  expect(clean(message)).toBe(cleaned);
});

test('three characters of a long key`s end and seven of its middle are no echo of it', () => {
  const { clean } = credentials(
    'acme',
    'sk-proj-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1Yf5Gj0',
    undefined,
  );

  expect(clean('key sk-...Gj0 ..7Lm2Xv9..')).toBe('key sk-...Gj0 ..7Lm2Xv9..');
});

test.each([
  [
    'not from a word that ends as the key does',
    'The product is not in production; prod',
    'The product is not in production; [key]',
  ],
  [
    'not from a word that begins as the key does',
    'The bigw-7 and bigw-7f3 gateways, not gw-7',
    'The bigw-7 and bigw-7f3 gateways, not [key]',
  ],
  [
    'its ends as a mask leaves them',
    'key gw-7f****-prod, gw-7…prod or ****prod.',
    'key [key]****[key], [key]…[key] or ****[key].',
  ],
  ['its end where a longer name ends', 'key hidden-prod', 'key hidden[key]'],
])(
  'four characters that begin or end a long key are cut only at that edge of a name: %s',
  (_, message, cleaned) => {
    const { clean } = credentials('acme', 'gw-7f3a9c1e5b2d-prod', undefined);

    expect(clean(message)).toBe(cleaned);
  },
);

test.each([
  [
    'ollama',
    "model 'ollama3.2' not found, see ollama.com/library/codeollama or v1.ollama; sent Bearer ollama.",
    "model 'ollama3.2' not found, see ollama.com/library/codeollama or v1.ollama; sent Bearer [key].",
  ],
  [
    'lm-studio',
    'No models loaded in LM Studio; studio lm-studio-cli knows (lm-studio)',
    'No models loaded in LM Studio; studio lm-studio-cli knows ([key])',
  ],
  [
    'EMPTY',
    'messages must not be NONEMPTY or EMPTY_LIST',
    'messages must not be NONEMPTY or EMPTY_LIST',
  ],
  [
    'gw-7f3a9c1e-prod',
    'The product is not in production: gw-7f3a9c1e-prod',
    'The product is not in production: [key]',
  ],
])(
  'the short key %s is cut only whole and where it stands alone, and no word that holds a part of it is',
  (key, message, cleaned) => {
    const { clean } = credentials('acme', key, undefined);

    expect(clean(message)).toBe(cleaned);
  },
);

test('a key of nineteen characters is cut only whole, and one of twenty by its ends too', () => {
  expect(
    ['Zq7Lm2Xv9Rt4Kp8Wd3N', 'Zq7Lm2Xv9Rt4Kp8Wd3Nh'].map((key) =>
      credentials('acme', key, undefined).clean(
        `No key Zq7L...${key.slice(-4)} as ${key}`,
      ),
    ),
  ).toEqual(['No key Zq7L...Wd3N as [key]', 'No key [key]...[key] as [key]']);
});

test.each([
  ['a name alone', 'https://Zq7Lm2Xv9Rt4Kp8W@api.example/v1'],
  ['a password alone', 'https://:Zq7Lm2Xv9Rt4Kp8W@api.example/v1'],
])(
  'an address that holds %s fails when the adapter is made, in words that quote none of it',
  (_, address) => {
    const made = () => addressed('acme', address);

    expect(made).toThrow(
      'The acme adapter was given an address that holds credentials; send them in a header',
    );
    expect(made).not.toThrow(/gateway|Zq7L|Kp8W|127|example/);
  },
);

test('an address that has no end fails when the adapter is made, in words that quote none of it', () => {
  const made = () =>
    addressed('acme', 'http://gateway:Zq7Lm2Xv9Rt4Kp8W@[::1/v1');

  expect(made).toThrow('The acme adapter was given an address that is none');
  expect(made).not.toThrow(/gateway|Zq7L|Kp8W|v1/);
});

test.each(['', 'acme/eu'])(
  'the prefix %p, which would serve names no caller writes, fails',
  (prefix) => {
    expect(() => prefixed(prefix)).toThrow(
      /^An adapter was given a prefix that is no name: it takes one or more characters and no \/$/,
    );
  },
);

test('a redirect is told as one that is not followed, and a 3xx that points nowhere to follow by its status, with no other try', () => {
  expect([moved(308), moved(305)]).toEqual([
    {
      code: 'upstream_failed',
      status: 502,
      message: 'The upstream answered 308, a redirect, which is not followed',
      retryable: false,
      upstream: true,
    },
    {
      code: 'upstream_failed',
      status: 502,
      message: 'The upstream answered 305',
      retryable: false,
      upstream: true,
    },
  ]);
});

test('a failure`s body is read up to 65536 bytes: one byte more is left unread, and one exactly that long is whole', async () => {
  const exact = `{"error":{"message":"${'m'.repeat(65_536 - 24)}"}}`;

  expect(await told(new Response(exact))).toBe(exact);
  expect(await told(new Response(`${exact} `))).toBe(exact);
  expect(await told(new Response('m'.repeat(200_000)))).toBe(
    'm'.repeat(65_536),
  );
  expect(await told(new Response(null))).toBe('');
});

test('a character the limit falls inside is left out, whichever chunk it came in', async () => {
  const whole = await told(new Response(`${'m'.repeat(65_535)}é`));
  const chunked = await told(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('m'.repeat(65_533)));
          controller.enqueue(new TextEncoder().encode('日本'));
          controller.close();
        },
      }),
    ),
  );

  expect(whole).toBe('m'.repeat(65_535));
  expect(chunked).toBe(`${'m'.repeat(65_533)}日`);
});

test('a body that never ends is read to the limit and then let go', async () => {
  let released = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('m'.repeat(16_384)));
    },
    cancel() {
      released = true;
    },
  });

  expect(await told(new Response(body))).toBe('m'.repeat(65_536));
  expect(released).toBe(true);
});
