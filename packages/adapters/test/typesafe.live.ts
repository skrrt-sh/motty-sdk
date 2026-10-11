import { describe, expect, test } from 'bun:test';
import {
  answer,
  InvalidRequest,
  motty,
  UnknownModel,
  UpstreamFailed,
  UpstreamRefused,
} from '@mottyjs/core';
import { adapted, toFacts } from '@mottyjs/core/host';
import { choice, decision, noul, score } from '@mottyjs/decision';
import { run } from '@mottyjs/test';
import { typesafe } from '../src/typesafe.ts';

// Real calls: the file is not a `.test.ts`, so it runs only when named.
// Jev's cost money and need a key; Laya's need its server's address, with
// the version, as `http://127.0.0.1:8765/v1`.
const { TYPESAFE_KEY: key = '', LAYA_ADDRESS: address = '' } = Bun.env;

// A new connection, or a checkpoint Laya loads on its first call, takes
// longer than the adapter's own limit allows a decision.
const timeoutMs = 30_000;

function jev(held = key) {
  return typesafe({ key: held, timeoutMs });
}

function laya(body: { [control: string]: number } = {}) {
  return typesafe({ address, prefix: 'laya', timeoutMs, body });
}

function decided(name: string, state: string) {
  return decision(name).decide(state, {
    department: choice({
      instructions: 'Which department should handle this?',
      criteria: {
        billing: 'invoices, payments, refunds',
        technical: 'bugs, outages, system errors',
        other: 'everything else',
      },
    }),
    urgency: score({
      instructions: 'How urgent is this?',
      criteria: ['not urgent', 'soon', 'blocking'],
    }),
    refund: noul({ instructions: 'Does the user ask for a refund?' }),
  });
}

// One ticket goes through a motty that answers with the department, and
// what the motty was told is kept as the plugin typed it.
async function sorted(name: string, adapter: ReturnType<typeof typesafe>) {
  const told: Awaited<ReturnType<typeof decided>>[] = [];
  const { answer: reply, calls } = await run(
    motty({ name: 'triage' }).handle(async ({ request }) => {
      const answers = await decided(name, request.messages.at(-1)?.text ?? '');
      told.push(answers);
      return answer(answers.department.choice);
    }),
    {
      text: 'We were billed twice for March. Please refund the duplicate today.',
    },
    { models: [adapter] },
  );
  return { text: await reply.text(), calls, told };
}

describe.each([
  [
    'Jev',
    key,
    jev,
    'typesafe/jev-latest',
    0.5,
    'typesafe/no-such-model',
    'Unknown model: no-such-model',
  ],
  [
    'Laya',
    address,
    laya,
    'laya/english',
    0,
    'laya/org/repo',
    "unknown model 'org/repo'",
  ],
])('against %s', (_, needed, made, model, least, unknown, sentence) => {
  test.skipIf(needed === '')(
    'a choice, a score and a noul are each answered as the plugin types them, and the call is counted with its usage',
    async () => {
      const { text, calls, told } = await sorted(model, made());
      const [{ department, urgency, refund } = {}] = told;

      expect(text).toBe('billing');
      expect(department?.probabilities.billing).toBeGreaterThan(0.5);
      expect(urgency?.score).toBeGreaterThanOrEqual(0);
      expect(urgency?.score).toBeLessThanOrEqual(2);
      expect(Object.keys(urgency?.probabilities ?? {})).toHaveLength(3);
      expect(refund?.noul).toBeGreaterThanOrEqual(least);
      expect(refund?.noul).toBeLessThanOrEqual(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe(model);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    },
  );

  test.skipIf(needed === '')(
    'a model the server does not know rejects as an unknown model, in a sentence that names it',
    async () => {
      const asked = adapted([made()]).decisions(
        unknown,
        {
          state: 'We were billed twice for March.',
          questions: {
            refund: {
              type: 'noul',
              instructions: 'Does the user ask for a refund?',
            },
          },
        },
        AbortSignal.timeout(timeoutMs),
      );

      await expect(asked).rejects.toBeInstanceOf(UnknownModel);
      await expect(asked).rejects.toThrow(sentence);
    },
  );
});

describe.each([
  ['Jev', key, 'https://api.typesafe.ai/v0', 'typesafe'],
  ['Laya', address, `${address}/nope`, 'laya'],
])('against %s', (_, needed, wrong, prefix) => {
  test.skipIf(needed === '')(
    'an address with no decisions at it rejects as an upstream failure nothing retries, and as no unknown model',
    async () => {
      const thrown = await adapted([
        typesafe({ key, address: wrong, prefix, timeoutMs }),
      ])
        .decisions(
          `${prefix}/english`,
          {
            state: 'We were billed twice for March.',
            questions: {
              refund: {
                type: 'noul',
                instructions: 'Does the user ask for a refund?',
              },
            },
          },
          AbortSignal.timeout(timeoutMs),
        )
        .catch((raised: unknown) => raised);

      expect(thrown).toBeInstanceOf(UpstreamFailed);
      expect(toFacts(thrown)).toMatchObject({
        message:
          "The decision upstream has no decisions at the adapter's address, which is likely wrong: Not Found",
        retryable: false,
      });
    },
  );
});

describe.skipIf(key === '')('against Jev', () => {
  test('a key Jev does not know is told as the host`s refusal, with none of the key in anything the error carries', async () => {
    const thrown = await sorted(
      'typesafe/jev-latest',
      jev('apikey_0000000000000000000000000000'),
    ).catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(UpstreamRefused);
    expect(JSON.stringify(toFacts(thrown))).not.toMatch(/apikey_|0000/);
    expect(Bun.inspect(thrown)).not.toMatch(/apikey_|0000/);
  });

  test('a question Jev refuses rejects as an invalid request, in Jev`s own sentence', async () => {
    const asked = adapted([jev()]).decisions(
      'typesafe/jev-latest',
      {
        state: 'We were billed twice for March.',
        questions: { refund: { type: 'noul' } },
      },
      AbortSignal.timeout(timeoutMs),
    );

    await expect(asked).rejects.toBeInstanceOf(InvalidRequest);
    await expect(asked).rejects.toThrow(
      'Noul question must have criteria or instructions: refund',
    );
  });
});

describe.skipIf(address === '')('against Laya', () => {
  test('a misspelt name, which Laya answers with a checkpoint of its own choosing, rejects as an unknown model that names it', async () => {
    const thrown = await sorted('laya/englsh', laya()).catch(
      (raised: unknown) => raised,
    );

    expect(thrown).toBeInstanceOf(UnknownModel);
    expect(toFacts(thrown).message).toContain("'englsh'");
  });

  test('a name of Jev`s, which Laya answers by its router on purpose, is answered only where the host says its server routes by itself', async () => {
    const refused = await sorted('laya/jev-latest', laya()).catch(
      (raised: unknown) => raised,
    );
    const { text } = await sorted(
      'laya/jev-latest',
      typesafe({ address, prefix: 'laya', timeoutMs, routes: true }),
    );

    expect(refused).toBeInstanceOf(UnknownModel);
    expect(text).toBe('billing');
  });

  test.each(['laya/ml', 'laya/MultiLingual', 'laya/en'])(
    '%s, an alias or other letters of a name Laya knows, is answered',
    async (name) => {
      const { text } = await sorted(name, laya());

      expect(text).toBe('billing');
    },
  );

  test('every answer comes with the fields Laya adds to Jev`s: its own confidence, and Jev`s beside a choice and a score', async () => {
    const { told } = await sorted('laya/english', laya());
    const [{ department, urgency, refund } = {}] = told;

    expect(department?.answer_confidence).toBeNumber();
    expect(department?.x_jev_confidence).toBeNumber();
    expect(urgency?.answer_confidence).toBeNumber();
    expect(urgency?.x_jev_confidence).toBeNumber();
    expect(refund?.answer_confidence).toBeNumber();
    expect(refund?.confidence).toBeNumber();
  });

  test('a control of Laya`s own, stated as a body field, is taken: only with it does an answer say that it abstained', async () => {
    const [plain, held] = await Promise.all([
      sorted('laya/english', laya()),
      sorted('laya/english', laya({ min_confidence: 1 })),
    ]);

    expect(plain.told[0]?.refund.type).toBe('noul');
    expect(plain.told[0]?.refund).not.toHaveProperty('abstention');
    expect(held.told[0]?.refund.abstention).toBe('abstained');
    expect(held.told[0]?.refund.abstention_threshold).toBe(1);
  });
});
