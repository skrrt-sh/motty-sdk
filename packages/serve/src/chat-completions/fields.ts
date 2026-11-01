import type { Json, Options } from '@mottyjs/core/host';
import type { LeftOut } from '../codec.ts';
import { copied, type Dict, put } from '../wire/json.ts';
import { says } from '../wire/provider-data.ts';
import type { Dialect } from './dialect.ts';

// The options that only help, each with OpenAI's name for it: a call means the
// same without one, so an upstream is sent one only where its table has it. Any
// other field may change the answer, so it always goes, and a refusal of it lets
// a fallback move on where a silent drop would give a wrong answer.
export const named = {
  metadata: 'metadata',
  store: 'store',
  serviceTier: 'service_tier',
  safetyIdentifier: 'safety_identifier',
  cacheKey: 'prompt_cache_key',
  cacheOptions: 'prompt_cache_options',
  cacheRetention: 'prompt_cache_retention',
  prediction: 'prediction',
  verbosity: 'verbosity',
  seed: 'seed',
  user: 'user',
  presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty',
  maxTokens: 'max_completion_tokens',
} as const satisfies { readonly [Option in keyof Options]?: string };

type Named = keyof typeof named;

/**
 * What an upstream takes of the options that only help, each with `true` or the
 * name it goes by there where that is not OpenAI's. `streamOptions` is the SDK's
 * own ask for usage, which no option states.
 */
export type Fields = {
  readonly [Option in Named | 'streamOptions']?: true | string;
};

function isNamed(name: string): name is Named {
  return Object.hasOwn(named, name);
}

const optionOf = new Map<string, keyof Fields>([
  ...Object.keys(named)
    .filter(isNamed)
    .map((option): [string, Named] => [named[option], option]),
  ['stream_options', 'streamOptions'],
]);

// What the options state, added to `fields` under OpenAI's names, before any table
// is held to it. A penalty is `sampling`'s to write, since a model's rule may leave
// it out. Only what was said is read, since few of the options are said on a call.
export function withOptions(fields: Dict, said: Options): Dict {
  for (const option in said) {
    if (!isNamed(option) || option.endsWith('Penalty')) continue;
    const value = said[option];
    if (value !== undefined) put(fields, named[option], copied(value));
  }
  return fields;
}

const same = (fields: Dict) => fields;
const none: readonly LeftOut[] = [];
const unlisted = { hints: same, typed: same, told: none };

// The one step that holds a request to its dialect's table. With none it is
// nothing, as this is every call to OpenAI itself. What an author names in
// `provider` or on a connection never comes through here: it goes as said.
export function listing({ fields, name }: Dialect) {
  if (fields === undefined) return unlisted;
  const told: LeftOut[] = [];
  const sifted = (
    said: Dict,
    tells: (option: keyof Fields, value: Json) => boolean,
  ): Dict => {
    const kept: Dict = {};
    for (const field in said) {
      const value = said[field];
      if (value === undefined) continue;
      const option = optionOf.get(field);
      const as = option === undefined ? true : fields[option];
      if (as !== undefined) put(kept, as === true ? field : as, value);
      else if (
        option !== undefined &&
        tells(option, value) &&
        !told.some(({ setting }) => setting === option)
      ) {
        const detail = `${name} has no field for ${option}`;
        told.push({ setting: option, detail });
      }
    }
    return kept;
  };
  return {
    // A hint of nothing says what leaving it out says.
    hints: (said: Dict) => sifted(said, (_, value) => says(value)),
    // So does an option, and a penalty of zero asks for nothing, on every API.
    // Usage is the SDK's own ask and no caller's, so nobody is told of it.
    typed: (said: Dict) =>
      sifted(
        said,
        (option, value) =>
          option !== 'streamOptions' &&
          says(value) &&
          !(value === 0 && option.endsWith('Penalty')),
      ),
    told,
  };
}
