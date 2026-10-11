import type { Json, JsonOutput, Options } from '@mottyjs/core/host';
import type { Codec, Taken } from '../codec.ts';
import type { Leaving } from '../wire/fieldless.ts';
import { copied, type Dict, dict, given, isDict } from '../wire/json.ts';
import { invalid, unsupported } from '../wire/refusals.ts';
import { effortless, sampling } from '../wire/taken.ts';
import { hinted, marked, noted, own, parted } from './family.ts';
import { reasoningOf, reasoningTo, unsaid } from './reasoning.ts';
import { choiceOf, choiceTo } from './tools.ts';

function numeric(value: Json | undefined, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number'
    ? value
    : invalid(`${name} must be a number`);
}

function stopOf(value: Json | undefined): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalid('stop_sequences must be a list');
  return value.map((stop) =>
    typeof stop === 'string' ? stop : invalid('A stop sequence must be text'),
  );
}

function outputOf(format: Json | undefined): JsonOutput | undefined {
  if (format === undefined || format === null) return undefined;
  if (!isDict(format)) invalid('output_config.format must be an object');
  const { type, schema } = format;
  if (type !== 'json_schema' || !isDict(schema)) {
    invalid('output_config.format must be a json_schema with a schema');
  }
  // This API always holds the answer to the schema.
  return { schema, strict: true };
}

// Whatever the body holds that is not named here changes the meaning for
// all this codec knows, so it travels as this family's own and is sent back.
export function optionsOf(
  settings: Dict,
  heard: Dict = {},
): {
  options: Options;
  output?: JsonOutput;
  shown: boolean;
} {
  const {
    max_tokens: maxTokens,
    stop_sequences: stops,
    temperature,
    top_p: topP,
    top_k: topK,
    metadata,
    thinking,
    output_config: config,
    output_format: legacy,
    tool_choice: choice,
    cache_control: cache,
    service_tier: tier,
    ...rest
  } = settings;
  if (typeof maxTokens !== 'number') invalid('max_tokens must be a number');
  if (config !== undefined && !isDict(config)) {
    invalid('output_config must be an object');
  }
  const { effort, format, ...others } = config ?? {};
  const { reasoning, kept, verbatim, shown } = reasoningOf(thinking, effort);
  const { user_id: user } = dict(metadata);
  const stop = stopOf(stops);
  const output = outputOf(format ?? legacy);
  const options: Options = {
    maxTokens,
    ...choiceOf(choice),
    ...marked({
      ...rest,
      ...verbatim,
      ...(Object.keys(others).length === 0 ? {} : { output_config: others }),
    }),
    ...noted({
      ...given({ metadata, cache_control: cache, service_tier: tier }),
      ...heard,
      ...kept,
    }),
  };
  const sampled = {
    temperature: numeric(temperature, 'temperature'),
    topP: numeric(topP, 'top_p'),
    topK: numeric(topK, 'top_k'),
  };
  if (sampled.temperature !== undefined) {
    options.temperature = sampled.temperature;
  }
  if (sampled.topP !== undefined) options.topP = sampled.topP;
  if (sampled.topK !== undefined) options.topK = sampled.topK;
  if (stop !== undefined) options.stop = stop;
  if (typeof user === 'string') options.user = user;
  if (reasoning !== undefined) options.reasoning = reasoning;
  return { options, ...(output === undefined ? {} : { output }), shown };
}

function formatTo(
  left: Leaving,
  output: JsonOutput | undefined,
): Dict | undefined {
  if (output === undefined) return undefined;
  if (output.schema === undefined) {
    return unsupported('Anthropic Messages needs a schema for JSON output');
  }
  const { name, description, strict } = output;
  left.without(
    'output.name',
    name !== undefined || description !== undefined || strict === false,
  );
  return { type: 'json_schema', schema: copied(output.schema) };
}

function unless<Fields extends Dict>(fields: Fields): Fields | undefined {
  return Object.keys(fields).length === 0 ? undefined : fields;
}

export function optionsTo(
  left: Leaving,
  options: Options,
  output: JsonOutput | undefined,
  defaults: Dict = {},
  takes?: (reasons: boolean | undefined) => Taken | undefined,
): { headers: ReturnType<Codec['encode']>['headers']; fields: Dict } {
  left.without('presencePenalty', options.presencePenalty);
  left.without('frequencyPenalty', options.frequencyPenalty);
  left.without('seed', options.seed);
  const told = parted(own(options.provider, 'options'));
  const hint = parted(hinted(options.hints));
  const provider = told.rest;
  const { max_tokens: limit } = defaults;
  const {
    thinking: shape,
    output_config: steer,
    metadata,
    ...loose
  } = hint.rest;
  const { thinking: said, output_config: config } = provider;
  const { thinking, effort } = reasoningTo(
    left,
    effortless(left, takes?.(true), options.reasoning),
    shape,
    steer,
    said,
  );
  const { effort: stated } = dict(config);
  left.without('reasoning.own', stated === undefined ? undefined : effort);
  // Whether the request thinks is read from what is sent, whoever said it.
  const { thinking: preset } = unsaid(options.reasoning, defaults);
  const { type } = dict(said ?? thinking ?? preset);
  const thinks =
    type === 'enabled' || type === 'adaptive'
      ? true
      : type === 'disabled'
        ? false
        : undefined;
  return {
    headers: {
      // An option outranks a hint, as with a body field.
      ...hint.headers,
      ...told.headers,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    },
    fields: {
      ...loose,
      ...provider,
      // A caller of another family may send no limit, and this one needs it.
      // Every current model takes this much, and too low a cap cuts answers;
      // a connection that states one knows its model.
      max_tokens: options.maxTokens ?? limit ?? 64_000,
      ...given({
        stop_sequences:
          options.stop === undefined || options.stop.length === 0
            ? undefined
            : [...options.stop],
        metadata: unless({
          ...dict(metadata),
          ...given({ user_id: options.user }),
        }),
        thinking,
        output_config: unless({
          ...dict(steer),
          ...given({ effort }),
          ...dict(config),
          ...given({ format: formatTo(left, output) }),
        }),
        tool_choice: choiceTo(left, options),
      }),
      ...sampling(
        left,
        takes?.(thinks),
        {
          temperature: options.temperature,
          topP: options.topP,
          topK: options.topK,
        },
        provider,
      ),
    },
  };
}
