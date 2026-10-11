import type { EventStream, Host, ModelCall } from '../src/contract.ts';
import type { StreamEvent } from '../src/data/event.ts';
import type { JsonOutput, Prompt } from '../src/data/message.ts';

async function* replay(
  events: StreamEvent[] | undefined,
  model: string,
  signal: AbortSignal,
): EventStream {
  if (events === undefined) {
    yield {
      type: 'error',
      error: {
        code: 'unknown_model',
        status: 404,
        message: `No model named ${model}`,
      },
    };
    return;
  }
  for (const event of events) {
    if (signal.aborted) {
      yield {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The call was stopped',
        },
      };
      return;
    }
    yield event;
  }
}

export function stubHost(
  script: { [model: string]: StreamEvent[] } = {},
  rest: Partial<Omit<Host, 'models'>> = {},
) {
  const prompts = new Map<string, Prompt<JsonOutput>[]>();
  const models: ModelCall = (model, prompt, signal) => {
    prompts.set(model, [...(prompts.get(model) ?? []), prompt]);
    return replay(
      Object.hasOwn(script, model) ? script[model] : undefined,
      model,
      signal,
    );
  };
  return {
    signal: new AbortController().signal,
    ...rest,
    models,
    sent: (model: string) => prompts.get(model) ?? [],
  };
}
