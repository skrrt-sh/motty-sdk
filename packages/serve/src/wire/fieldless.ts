import type { LeftOut } from '../codec.ts';
import { unsupported } from './refusals.ts';

export const apis = {
  chat: 'Chat Completions',
  responses: 'The Responses API',
  messages: 'Anthropic Messages',
} as const;

export type Api = keyof typeof apis;

type Row = { readonly said: string; readonly unset?: number } & {
  readonly [Name in Api]?: 'meaning' | 'hint';
};

// A row per neutral option or part kind that some API has no field for. One
// that changes the meaning fails the call, so a fallback can move on; a hint
// is left out and reported. An API a row does not name has the field.
export const fieldless = {
  seed: { said: 'a seed', responses: 'hint', messages: 'hint' },
  topK: { said: 'top-k sampling', chat: 'hint', responses: 'hint' },
  stop: { said: 'stop sequences', responses: 'meaning' },
  presencePenalty: {
    said: 'a presence penalty',
    unset: 0,
    messages: 'hint',
  },
  frequencyPenalty: {
    said: 'a frequency penalty',
    unset: 0,
    messages: 'hint',
  },
  // What a model does not take is the connection's rule to say, so each of
  // these is reported by an API that has the field, where there is a rule.
  'temperature.model': {
    said: 'a temperature the model does not take',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'temperature.range': {
    said: "a temperature outside the model's range, sent as the nearest inside",
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'topP.model': {
    said: 'top-p sampling the model does not take',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'topP.range': {
    said: "top-p sampling outside the model's range, sent as the nearest inside",
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'topP.temperature': {
    said: 'top-p sampling beside a temperature, which the model does not take together',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'temperature.topP': {
    said: 'a temperature beside top-p sampling, which the model does not take together',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'topK.model': {
    said: 'top-k sampling the model does not take',
    chat: 'hint',
    messages: 'hint',
  },
  'presencePenalty.model': {
    said: 'a presence penalty the model does not take',
    unset: 0,
    chat: 'hint',
    responses: 'hint',
  },
  'frequencyPenalty.model': {
    said: 'a frequency penalty the model does not take',
    unset: 0,
    chat: 'hint',
    responses: 'hint',
  },
  'sampling.own': {
    said: "a sampling setting the request also states in the API's own words",
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'reasoning.model': {
    said: 'a reasoning effort the model does not take',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'reasoning.budgetTokens': {
    said: 'a reasoning budget in tokens',
    chat: 'hint',
    responses: 'hint',
  },
  'reasoning.exclude': {
    said: 'an order to keep reasoning out of the reply',
    chat: 'hint',
  },
  'reasoning.minimal': {
    said: 'minimal effort, sent as low',
    messages: 'hint',
  },
  'reasoning.none': {
    said: 'an order not to reason, sent as low effort',
    messages: 'hint',
  },
  'reasoning.off': {
    said: 'an order not to reason',
    chat: 'hint',
  },
  'reasoning.effort': {
    said: 'a level of reasoning effort',
    chat: 'hint',
  },
  'reasoning.level': {
    said: 'a reasoning effort the upstream has no level for, sent as the nearest it has',
    chat: 'hint',
  },
  'reasoning.own': {
    said: "a reasoning option the request also states in the API's own words",
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'reasoning.hint': {
    said: 'a hint of thinking the reasoning asked for does not take',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  'message.moved': {
    said: 'an instruction before a user turn, sent after it',
    messages: 'hint',
  },
  'output.name': {
    said: 'the name or description of a JSON output, or a schema held loosely',
    messages: 'hint',
  },
  'output.schema': {
    said: 'the schema of a JSON output, to an upstream that takes any JSON object',
    chat: 'hint',
  },
  'toolChoice.allowed': {
    said: 'a choice among only some of the tools',
    messages: 'meaning',
  },
  'tool.custom': { said: 'a free-form custom tool', messages: 'meaning' },
  'tool.cache': {
    said: 'a cache marker on a tool, a tool call or a tool result',
    chat: 'hint',
    responses: 'hint',
  },
  'message.name': {
    said: 'the name of who wrote a message',
    responses: 'meaning',
    messages: 'meaning',
  },
  // A tool message has no name on any API; the others refuse every name.
  'message.name.tool': {
    said: 'the name of who wrote a message',
    chat: 'hint',
    responses: 'meaning',
    messages: 'meaning',
  },
  'message.hints': {
    said: 'the hints or provider data of a message sent as no message item',
    responses: 'hint',
  },
  'cache.outside': {
    said: 'a cache marker outside input content',
    responses: 'hint',
  },
  // Most OpenAI models refuse the marker and cache by themselves, so it is
  // written only to an upstream said to take it.
  cache: {
    said: 'a cache marker, to an upstream not said to take one',
    chat: 'hint',
    responses: 'hint',
  },
  // The lifetime is one for the whole request there, not one per marker.
  'cache.ttl': {
    said: 'a lifetime on a cache marker',
    chat: 'hint',
    responses: 'hint',
  },
  'user.long': {
    said: 'a user longer than 64 characters',
    responses: 'hint',
  },
  audio: { said: 'audio', responses: 'meaning', messages: 'meaning' },
  // No API takes a picture as bare bytes, and none is given a type here.
  'image.untyped': {
    said: 'image bytes of no named media type',
    chat: 'meaning',
    responses: 'meaning',
    messages: 'meaning',
  },
  hosted: {
    said: 'a call or a result of a tool another upstream ran',
    chat: 'meaning',
    responses: 'meaning',
    messages: 'meaning',
  },
  'tool_result.failed': {
    said: 'the mark of a tool that failed',
    chat: 'hint',
    responses: 'hint',
  },
  reasoning: {
    said: 'reasoning it did not sign',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
  citation: {
    said: 'a citation in a form that is not its own',
    chat: 'hint',
    responses: 'hint',
    messages: 'hint',
  },
} satisfies { [option: string]: Row };

export type Fieldless = keyof typeof fieldless;

// One per encoded prompt. Each option is reported once, however many
// messages or parts carried it. Which cache marker the upstream takes, if
// any, is the connection's to say, and is asked wherever one would be written.
export function leaving(api: Api, marks?: true | 'cache_control') {
  const left = new Map<Fieldless, LeftOut>();

  // Asked wherever this API's encoder has nowhere to write the value. An
  // option not given, turned off or empty asks for nothing.
  function without(option: Fieldless, value: unknown): void {
    const row: Row = fieldless[option];
    if (value === undefined || value === false || value === row.unset) return;
    if (Array.isArray(value) && value.length === 0) return;
    const name = apis[api];
    if (row[api] === 'meaning') unsupported(`${name} cannot carry ${row.said}`);
    if (row[api] === 'hint') {
      const detail = `${name} has no field for ${row.said}`;
      left.set(option, { setting: option, detail });
    }
  }

  return { without, marks, leftOut: (): LeftOut[] => [...left.values()] };
}

export type Leaving = ReturnType<typeof leaving>;
