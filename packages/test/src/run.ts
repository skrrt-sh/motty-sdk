import type { Answer, Motty } from '@mottyjs/core';
import {
  buffered,
  type ChatRequest,
  fromFacts,
  type HostOptions,
  hosting,
  mark,
  type Overrides,
  type RequestRecord,
  type StreamEvent,
} from '@mottyjs/core/host';
import { fake } from './fake.ts';
import { memory } from './memory.ts';
import { Unscripted } from './unscripted.ts';

export type Asked = Partial<
  Pick<ChatRequest, 'model' | 'tools' | 'options' | 'output'>
> & {
  headers?: { readonly [name: string]: string };
  signal?: AbortSignal;
} & (
    | { text: string; messages?: never }
    | { messages: ChatRequest['messages']; text?: never }
  );

export type Ran<Paths extends string[] = string[]> = {
  route: Paths[0] | undefined;
  path: Paths | [];
  answer: Answer;
  calls: RequestRecord['calls'];
  thoughts: string[];
};

async function* replayed(events: readonly StreamEvent[]) {
  yield* events;
}

// The path is typed here by the motty that ran: the record holds it as plain
// names, and what they may be is known only to the motty's type.
export function run<Paths extends string[], Served>(
  motty: Motty<unknown, Paths> & Served,
  request: Asked,
  options?: HostOptions<Overrides<Served>>,
): Promise<Ran<Paths>>;
export async function run(
  motty: Motty,
  request: Asked,
  options: HostOptions = {},
): Promise<Ran> {
  const contract = motty[mark];
  const arrived = Promise.withResolvers<RequestRecord>();
  // The last adapter takes every name left, so a call nobody scripted
  // fails as one and not as a model the host does not know.
  const last = { ...fake(), serves: () => true };
  const { models = [] } = options;
  const admit = hosting(motty, {
    ...options,
    models:
      typeof models === 'function'
        ? async (asked, caller) => [...(await models(asked, caller)), last]
        : [...models, last],
    storage: options.storage ?? memory(),
  });
  const admitted = await admit({
    request: {
      model: request.model ?? contract.description.name,
      messages: request.messages ?? [{ role: 'user', text: request.text }],
      tools: request.tools ?? [],
      options: request.options ?? {},
      ...(request.output === undefined ? {} : { output: request.output }),
    },
    headers: new Headers(request.headers),
    // A test has no wire, so the credential is where a bearer token goes.
    credentials: ['authorization'],
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    over: arrived.resolve,
  });
  const host =
    options.auth === undefined
      ? { ...admitted.host, caller: { id: 'tester' } }
      : admitted.host;

  const events: StreamEvent[] = [];
  const pieces = new Map<number, string>();
  for await (const event of contract.run(admitted.request, host)) {
    if (event.type === 'progress') {
      pieces.set(event.piece, (pieces.get(event.piece) ?? '') + event.text);
    } else {
      events.push(event);
    }
  }
  // The record and not the stream's last event: it comes after the
  // after-response work, and a caller who left is sent no last event.
  const record = await arrived.promise;

  // A call that met no script is in the record whether or not the motty
  // recovered from it, so nothing but the contract tells of it.
  const unscripted = record.calls
    .filter(({ code }) => code === 'unscripted')
    .map(({ model }) => model);
  if (record.error?.code === 'unscripted') {
    throw new Unscripted(record.error.message);
  }
  if (unscripted.length > 0) {
    throw new Unscripted(
      `No reply was scripted for a call to ${unscripted.join(', ')}`,
    );
  }
  if (record.error !== undefined) throw fromFacts(record.error);
  const [route] = record.path;
  return {
    route,
    path: record.path,
    answer: buffered(replayed(events), request.output),
    calls: record.calls,
    thoughts: [...pieces.values()],
  };
}
