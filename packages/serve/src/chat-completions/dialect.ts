import type { FinishReason, Json, Options, Part } from '@mottyjs/core/host';
import { joined } from '../wire/details.ts';
import { type Effort, nearest } from '../wire/effort.ts';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, dict, given, list } from '../wire/json.ts';
import type { Cut, FailureReader } from '../wire/upstream-failure.ts';
import { family, hinted } from './family.ts';
import { wrapped } from './think-tags.ts';

// What a provider adds to Chat Completions. OpenAI's own adds nothing, and
// refuses a field it does not know, so each addition goes only where named.
export type Dialect = {
  // What an upstream failure is recorded under.
  name: string;
  // The field of an assistant turn that takes reasoning text back.
  thought?: 'reasoning' | 'reasoning_content';
  // `reasoning_details`: read from a reply and sent back as it came.
  details?: true;
  // Reasoning comes inside the answer's text, between think tags, and an
  // assistant turn takes it back the same way. `open` is a server whose
  // template wrote the opening tag, so its reply begins inside the thinking.
  tagged?: true | 'open';
  // Reasoning comes as a typed chunk of a content that is then a list, and
  // an assistant turn takes it back the same way, with what signed it.
  chunked?: true;
  // What asks for reasoning beside `reasoning_effort`: an object that takes
  // it over with a budget and a mute, or a switch for thinking: a type, a
  // flag with a budget beside it, a template argument, an object with a flag.
  asks?:
    | 'reasoning'
    | 'reasoning.enabled'
    | 'thinking'
    | 'enable_thinking'
    | 'chat_template_kwargs';
  // The levels `reasoning_effort` takes, where they are not OpenAI's: `none`
  // among them where it is one, and no level where there is no such field.
  efforts?: readonly Effort[];
  // The upstream takes any JSON object and no schema.
  output?: 'json_object';
  // The provider's own failures, named before the family's.
  failures?: FailureReader;
  // A failure it tells with no error object, in a body or in a chunk of a
  // reply that began well: the error such a body holds, or none.
  envelope?: (body: Dict) => Dict | undefined;
  // What in its failures names the host's account: a caller is told the
  // failure without it.
  cuts?: readonly Cut[];
  // `top_k`, which OpenAI's own API has no field for.
  topK?: true;
  // The output limit, where it is not `max_completion_tokens`.
  limit?: 'max_tokens';
  // A file part beside OpenAI's, a PDF by bytes or by id under `file`: one
  // of any type that may be an address too, or a picture alone, by bytes or
  // by id, with no object around it, which is how a picture goes by id.
  files?: 'any' | 'pictures';
  // Sound beside OpenAI's wav and mp3: in every format, or none at all.
  sound?: 'any' | 'none';
  // `video_url`, for a file that is a video.
  video?: true;
  // A tool message takes the parts a user message takes.
  shown?: true;
  // `images` on an assistant turn: read from a reply and sent back.
  images?: true;
  // A cache marker on a content part: `prompt_cache_breakpoint`, which most
  // of OpenAI's own models refuse, or a router's `cache_control`, which has
  // a lifetime.
  breakpoints?: true | 'cache_control';
  // Where a marker's lifetime goes, if not on the marker: nowhere, as an
  // upstream that keeps one five minutes alone, or in the request's
  // `prompt_cache_options`, as one that caches every prefix by itself.
  lifetime?: '5m' | 'prompt_cache_options';
  // Headers that say what the body may hold, by name in lower case: sent
  // from the hint or the option of that name, and never in the body.
  carried?: readonly string[];
  // `native_finish_reason`: tells a stop sequence apart from a natural stop.
  native?: true;
  // Its own words for an ending, beside the ones OpenAI lists.
  endings?: { readonly [word: string]: FinishReason };
  // Its own words for a reply that did not end: the call failed.
  broken?: readonly string[];
  // `cached_tokens` at the top of usage, where a model sends no details:
  // the details and DeepSeek's `prompt_cache_hit_tokens` outrank it.
  flat?: true;
};

export const plain: Dialect = { name: family };

// Every field that asks for reasoning, under any dialect's name.
export const reasoningWords = [
  'reasoning_effort',
  'reasoning',
  'thinking',
  'enable_thinking',
  'thinking_budget',
  'chat_template_kwargs',
];

function turned(word: Exclude<Dialect['asks'], 'reasoning'>, on: boolean) {
  switch (word) {
    case undefined:
      return {};
    case 'thinking':
      return { thinking: { type: on ? 'enabled' : 'disabled' } };
    case 'enable_thinking':
      return { enable_thinking: on };
    case 'chat_template_kwargs':
      return { chat_template_kwargs: { enable_thinking: on } };
    case 'reasoning.enabled':
      return { reasoning: { enabled: on } };
    default:
      return word satisfies never;
  }
}

// Whether a request's switch says to reason, whoever wrote it.
export function switched(sent: Dict): boolean | undefined {
  const { thinking, enable_thinking: flag, chat_template_kwargs: args } = sent;
  const { reasoning } = sent;
  const { type } = dict(thinking);
  const { enable_thinking: inner } = dict(args);
  const { enabled } = dict(reasoning);
  const off = flag === false || inner === false || enabled === false;
  if (type === 'disabled' || off) return false;
  const on = flag === true || inner === true || enabled === true;
  return type === 'enabled' || on ? true : undefined;
}

// What the neutral option asks for in the dialect's words. A level sent as
// another is told only where it is sent.
function translated(
  left: Leaving,
  dialect: Dialect,
  reasoning: Options['reasoning'],
  sent: boolean,
): Dict {
  const { effort, budgetTokens, exclude } = reasoning ?? {};
  if (dialect.asks === 'reasoning') {
    // The object takes an effort or a budget and refuses both, so the
    // effort stays, as this upstream chooses when it translates them itself.
    const budget = effort === undefined ? budgetTokens : undefined;
    if (budget === undefined) {
      left.without('reasoning.budgetTokens', budgetTokens);
    }
    const wanted = given({ effort, max_tokens: budget, exclude });
    return Object.keys(wanted).length === 0 ? {} : { reasoning: wanted };
  }
  const { asks: word, efforts } = dialect;
  const off = effort === 'none';
  // Only a flag has a budget beside it, and none goes with an order not to
  // reason.
  const size = word === 'enable_thinking' && !off ? budgetTokens : undefined;
  if (size === undefined) left.without('reasoning.budgetTokens', budgetTokens);
  left.without('reasoning.exclude', exclude);
  // With a switch, an order not to reason is the switch's to give. With
  // none it is the effort's, where the upstream takes that level.
  const none = word === undefined && (efforts?.includes('none') ?? true);
  const level = off
    ? none
      ? effort
      : undefined
    : effort === undefined
      ? undefined
      : nearest(efforts, effort);
  if (off) left.without('reasoning.off', word === undefined && !none);
  else {
    left.without('reasoning.effort', level === undefined ? effort : undefined);
    left.without(
      'reasoning.level',
      sent && level !== undefined && level !== effort,
    );
  }
  // A switch has no level, but a caller who gave an effort or a budget
  // asked to reason.
  const on = off
    ? false
    : size !== undefined ||
        (effort === undefined && budgetTokens !== undefined) ||
        (effort !== undefined && level === undefined)
      ? true
      : undefined;
  return given({
    reasoning_effort: level,
    ...(on === undefined ? {} : turned(word, on)),
    thinking_budget: size,
  });
}

// The request fields that ask for reasoning. A reasoning word the author
// said in an API's own words is all the request says of reasoning: a neutral
// word beside it could contradict it, so none is written and that is told.
export function asked(
  left: Leaving,
  dialect: Dialect,
  reasoning: Options['reasoning'],
  said: Dict,
): Dict {
  const own = reasoningWords.some((word) => said[word] !== undefined);
  const written = translated(left, dialect, reasoning, !own);
  if (!own) return written;
  left.without('reasoning.own', Object.keys(written).length > 0);
  return {};
}

type Thought = Extract<Part, { type: 'reasoning' }>;

function detailsOf(dialect: Dialect, part: Thought): Json[] {
  if (dialect.details !== true) return [];
  const { reasoning_details: details } = hinted(part.provider);
  return list(details);
}

// What an assistant turn says of its reasoning, where the dialect has a
// field for it. Details go back alone: they hold the text they sign.
export function returned(
  left: Leaving,
  dialect: Dialect,
  thoughts: readonly Thought[],
): Dict {
  if (dialect.thought === undefined) return {};
  for (const part of thoughts) {
    // What another API, or another dialect, goes on from has no field here.
    if (part.provider !== undefined && detailsOf(dialect, part).length === 0) {
      left.without('reasoning', part);
    }
  }
  const details = joined(thoughts.flatMap((part) => detailsOf(dialect, part)));
  if (details.length > 0) return { reasoning_details: details };
  const text = thoughts.map((part) => part.text).join('');
  return text === '' ? {} : { [dialect.thought]: text };
}

// What an assistant turn's text opens with where reasoning goes back inside
// it. Only the text goes: what signed it has no place there.
export function inlined(
  left: Leaving,
  dialect: Dialect,
  thoughts: readonly Thought[],
): string {
  if (dialect.tagged === undefined) return '';
  for (const part of thoughts) {
    if (part.provider !== undefined) left.without('reasoning', part);
  }
  const text = thoughts.map((part) => part.text).join('');
  return text === '' ? '' : wrapped(text);
}
