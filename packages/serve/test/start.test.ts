import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { auth } from '@mottyjs/auth';
import { answer, motty, type StandardSchema } from '@mottyjs/core';
import {
  type AuthAdapter,
  type HostOptions,
  type Marked,
  mark,
} from '@mottyjs/core/host';
import { settings } from '@mottyjs/settings';
import { z } from 'zod';
import { mount, serve } from '../src/index.ts';

function ask(headers: { [name: string]: string } = {}): Request {
  return new Request('http://motty.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'coder',
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
  });
}

let stderr: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  stderr = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stderr.mockRestore();
});

function lines(): string[] {
  return stderr.mock.calls.map(([line]) => String(line));
}

const replies = motty({ name: 'coder' }).handle(() => answer('Use a mutex.'));

test('a motty with no route or handle is refused at mount and by serve, in the words of the core', () => {
  expect(() =>
    // @ts-expect-error nothing answers
    mount(motty({ name: 'x' }), () => ({})),
  ).toThrow('The motty "x" has no route or handle');
  expect(() =>
    // @ts-expect-error nothing answers
    serve(motty({ name: 'x' }), () => ({})),
  ).toThrow('has no route or handle');
  const unanswered = motty({ name: 'x' }).use(auth());
  // @ts-expect-error a part with no answer does not make one
  expect(() => mount(unanswered, () => ({}))).toThrow('has no route or handle');
});

test('a motty is taken whether its answer is its own, a part used or a route', () => {
  const part = motty({ name: 'part' }).handle(() => answer('Hi'));

  mount(motty({ name: 'used' }).use(part), () => ({}));
  mount(
    motty({ name: 'routed' }).route(() => 'only', { only: part }),
    () => ({}),
  );
});

test('a motty held without its types is not refused by them, and one with no answer still fails at mount', () => {
  const held: Marked = motty({ name: 'x' });

  expect(() => mount(held, () => ({}))).toThrow('has no route or handle');
});

test('a motty of another copy of the SDK, which tells nothing of itself, is hosted as it always was', () => {
  const { root: _, ...told } = replies[mark];

  mount({ [mark]: told }, () => ({
    settings: { anything: { goes: true } },
  }));
});

const tuned = motty({ name: 'coder' })
  .use(
    settings({
      routing: z.object({ threshold: z.number().max(1).default(0.5) }),
    }),
  )
  .handle(({ settings: { routing } }) => answer(String(routing.threshold)));

test('a valid override mounts, and the motty reads it', async () => {
  const { fetch } = mount(tuned, () => ({
    settings: { routing: { threshold: 0.9 } },
  }));

  const reply = await fetch(ask());

  expect(reply.status).toBe(200);
  expect(await reply.text()).toContain('0.9');
});

test('an override its schema refuses fails at mount and at serve, naming the group and the problem', () => {
  expect(() =>
    mount(tuned, () => ({ settings: { routing: { threshold: 2 } } })),
  ).toThrow(/settings for the group "routing".*threshold.*<=1/);
  expect(() =>
    serve(tuned, () => ({ settings: { routing: { threshold: 2 } } })),
  ).toThrow('"routing"');
});

// A schema that says the value back, as some libraries do.
const echoing: StandardSchema<{ key?: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      JSON.stringify(value) === '{}'
        ? { value: {} }
        : { issues: [{ message: `Refused ${JSON.stringify(value)}` }] },
  },
};

test('what a schema says of a refused value does not bring the value along', () => {
  const served = motty({ name: 'coder' })
    .use(settings({ keys: echoing }))
    .handle(() => answer('Hi'));

  let thrown: unknown;
  try {
    mount(served, () => ({ settings: { keys: { key: 'held-by-host' } } }));
  } catch (caught) {
    thrown = caught;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).toContain('"keys"');
  expect(String(thrown)).toContain('Refused');
  expect(String(thrown)).not.toContain('held-by-host');
});

test('a schema that throws on a value fails at mount with the same care', () => {
  const served = motty({ name: 'coder' })
    .use(
      settings({
        keys: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value) => {
              if (JSON.stringify(value) === '{}') return { value: {} };
              throw new Error(`Cannot read ${JSON.stringify(value)}`);
            },
          },
        },
      }),
    )
    .handle(() => answer('Hi'));
  const options: HostOptions = {
    settings: { keys: { key: 'held-by-host' } },
  };

  let thrown: unknown;
  try {
    mount(served, () => options);
  } catch (caught) {
    thrown = caught;
  }

  expect(String(thrown)).toContain('"keys"');
  expect(String(thrown)).not.toContain('held-by-host');
});

test('a group the motty does not declare fails at mount, held as any names or under the name of what every object inherits', () => {
  const stray: HostOptions = { settings: { routes: { tier: 'deep' } } };
  const inherited: HostOptions = { settings: { toString: {} } };

  expect(() => mount(tuned, () => stray)).toThrow('"routes"');
  expect(() => mount(tuned, () => inherited)).toThrow('"toString"');
});

test('overrides for a motty with no settings fail at mount, and none at all is no override', () => {
  const stray: HostOptions = { settings: { routes: { tier: 'deep' } } };

  expect(() => mount(replies, () => stray)).toThrow('"routes"');
  mount(replies, () => ({ settings: {} }));
});

test('settings used only by a part of a route are found', () => {
  const inner = motty({ name: 'inner' })
    .use(
      settings({
        routing: z.object({ threshold: z.number().max(1).default(0.5) }),
      }),
    )
    .handle(() => answer('Hi'));
  const routed = motty({ name: 'coder' }).route(() => 'only', { only: inner });

  expect(() =>
    mount(routed, () => ({ settings: { routing: { threshold: 2 } } })),
  ).toThrow('"routing"');
  mount(routed, () => ({ settings: { routing: { threshold: 1 } } }));
});

// Accepts its defaults at once, as a settings group must, and takes its time
// over anything else.
function slow(
  verdict: () => Promise<boolean>,
): StandardSchema<{ key?: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) =>
        JSON.stringify(value) === '{}'
          ? { value: {} }
          : verdict().then((fine) =>
              fine
                ? { value: { key: 'fine' } }
                : {
                    issues: [{ message: `Refused ${JSON.stringify(value)}` }],
                  },
            ),
    },
  };
}

test('a schema that takes its time still works', async () => {
  const served = motty({ name: 'coder' })
    .use(settings({ keys: slow(async () => true) }))
    .handle(({ settings: { keys } }) => answer(String(keys.key)));

  const { fetch, close } = mount(served, () => ({
    settings: { keys: { key: 'anything' } },
  }));
  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(200);
  expect(await reply.text()).toContain('fine');
  expect(lines()).toEqual([]);
});

test.each([
  ['refuses', () => Promise.resolve(false)],
  ['rejects', () => Promise.reject(new Error('Refused held-by-host'))],
] as const)(
  'a schema that takes its time and %s cannot stop a mount: it is written, and every request fails as before',
  async (_, verdict) => {
    const served = motty({ name: 'coder' })
      .use(settings({ keys: slow(verdict) }))
      .handle(() => answer('Hi'));

    const { fetch, close } = mount(served, () => ({
      settings: { keys: { key: 'held-by-host' } },
      report: () => {},
    }));
    await Bun.sleep(0);

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('"keys"');
    expect(lines()[0]).not.toContain('held-by-host');

    const reply = await fetch(ask());
    await close();

    expect(reply.status).toBe(500);
    expect(lines()).toHaveLength(1);
  },
);

const keys: AuthAdapter = {
  verify: (token) => (token === 'right' ? { id: 'ada' } : undefined),
};

test('an auth adapter for a motty with no auth() lets a wrong token in, which is legitimate and warned of once at mount', async () => {
  const { fetch } = mount(replies, () => ({ auth: keys }));

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('auth()');
  expect(lines()[0]).toContain('without a valid token');

  const reply = await fetch(ask({ authorization: 'Bearer wrong' }));

  expect(reply.status).toBe(200);
  expect(lines()).toHaveLength(1);
});

const guarded = motty({ name: 'coder' })
  .use(auth())
  .handle(({ caller }) => answer(caller.id));

test('auth() with no adapter refuses everyone, which is warned of once at mount, and a host that states the caller is told it may ignore it', async () => {
  const { fetch } = mount(guarded, () => ({}));

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('401');
  expect(lines()[0]).toContain('third');

  expect((await fetch(ask())).status).toBe(401);
  expect(
    (await fetch(ask(), undefined, { caller: { id: 'ada' } })).status,
  ).toBe(200);
  expect(lines().filter((line) => line.includes('third'))).toHaveLength(1);
});

test('a motty and a host that agree on auth write nothing at mount', () => {
  mount(guarded, () => ({ auth: keys }));
  mount(replies, () => ({}));

  expect(lines()).toEqual([]);
});
