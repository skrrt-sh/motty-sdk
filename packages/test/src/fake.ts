import type { NamedModel } from '@mottyjs/core';
import {
  type DecisionCall,
  type EventStream,
  type JsonOutput,
  type ModelCall,
  type Prompt,
  type ReadonlyJson,
  type StreamEvent,
  toFacts,
} from '@mottyjs/core/host';
import type { DecisionModel } from '@mottyjs/decision';
import { type ChatReply, chatEvents } from './chat-reply.ts';
import { type DecisionReply, decided } from './decision-reply.ts';
import { Unscripted } from './unscripted.ts';

type Kind = 'chat' | 'decision';

// A decision reply is held as the chat reply it also is, and read as a
// decision when the call comes.
type Entry = {
  readonly kind: Kind;
  readonly name: string;
  readonly reply: ChatReply;
};

export type Fake = ReturnType<typeof fake>;

export function on(model: DecisionModel, reply: DecisionReply): Entry;
export function on(model: NamedModel, reply: ChatReply): Entry;
export function on(model: NamedModel | DecisionModel, reply: ChatReply): Entry {
  return {
    kind: 'decide' in model ? 'decision' : 'chat',
    name: model.name,
    reply,
  };
}

function unscripted(kind: Kind, name: string): Unscripted {
  return new Unscripted(`No ${kind} reply was scripted for ${name}`);
}

async function* replay(events: readonly StreamEvent[]): EventStream {
  yield* events;
}

export function fake(...entries: Entry[]) {
  const names = new Set(entries.map(({ name }) => name));
  const scripts = Map.groupBy(entries, ({ kind, name }) => `${kind} ${name}`);
  const prompts = new Map<string, Prompt<JsonOutput>[]>();
  const inputs = new Map<string, ReadonlyJson[]>();

  // The last entry repeats.
  function next(kind: Kind, name: string): Entry | undefined {
    const left = scripts.get(`${kind} ${name}`);
    return left !== undefined && left.length > 1 ? left.shift() : left?.[0];
  }

  const call: ModelCall = (name, prompt, signal) => {
    prompts.set(name, [...(prompts.get(name) ?? []), prompt]);
    const entry = next('chat', name);
    return entry === undefined
      ? replay([{ type: 'error', error: toFacts(unscripted('chat', name)) }])
      : chatEvents(entry.reply, prompt, signal);
  };

  const decide: DecisionCall = async (name, input) => {
    inputs.set(name, [...(inputs.get(name) ?? []), input]);
    const entry = next('decision', name);
    if (entry === undefined) throw unscripted('decision', name);
    return decided(name, entry.reply, input);
  };

  function sent(model: DecisionModel): ReadonlyJson[];
  function sent(model: NamedModel): Prompt<JsonOutput>[];
  function sent(model: NamedModel | DecisionModel) {
    return (
      ('decide' in model ? inputs.get(model.name) : prompts.get(model.name)) ??
      []
    );
  }

  // Only the names it was given, so a real adapter beside it keeps its own.
  return { serves: (name: string) => names.has(name), call, decide, sent };
}
