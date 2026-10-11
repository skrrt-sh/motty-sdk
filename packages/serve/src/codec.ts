import type {
  ChatRequest,
  Chunk,
  ErrorFacts,
  EventStream,
  Finish,
  Json,
  JsonOutput,
  Progress,
  Prompt,
  RunStream,
} from '@mottyjs/core/host';
import type { ServerSentEvent } from './sse.ts';
import type { Dict } from './wire/json.ts';
import type { Clean } from './wire/upstream-failure.ts';

// The reply is encoded by what decoding returned, because how it is written
// depends on what the caller asked for: muted reasoning, usage in the stream.
export type Decoded = {
  request: Omit<ChatRequest, 'id' | 'headers'>;
  stream: boolean;
  // Whoever serves picks the HTTP status from the first event, so an error
  // met here is written the way this API ends a stream that failed.
  streamed: (events: RunStream, id: string) => AsyncIterable<ServerSentEvent>;
  // Only for a request that finished: one that failed is answered with the
  // error body instead.
  collected: (
    events: readonly (Chunk | Progress)[],
    finish: Finish,
    id: string,
  ) => Json;
};

// A short, stable statement of what was left out and which API has no place
// for it: the shape of a finish event's warning, which carries it.
export type LeftOut = NonNullable<Finish['warnings']>[number];

// A range, the one value a model allows, or no value at all.
type Sampled = readonly [least: number, most: number] | number | false;

// What one model takes of the neutral options that differ by model.
export type Taken = {
  temperature: Sampled;
  topP: Sampled;
  topK: boolean;
  presencePenalty: boolean;
  frequencyPenalty: boolean;
  // Whether a temperature and a top-p may be sent in one request.
  together: boolean;
  effort: boolean;
};

// Asked by the model's own name and by what the request says of reasoning:
// that it reasons, that it does not, or nothing. A model the rule does not
// know is sent everything.
export type Takes = (
  model: string,
  reasons: boolean | undefined,
) => Taken | undefined;

export type Codec = {
  paths: readonly string[];
  // The headers a caller of this API sends its key or token in, in lower
  // case. The host reads the credential from them and removes them.
  credentials: readonly string[];
  // The response header a client of this API reads the request's id from.
  requestId: string;
  decode: (body: Json, headers: Headers) => Decoded;
  // The id is given for a request that has a record.
  error: (facts: ErrorFacts, id?: string) => { status: number; body: Json };
  // The model name is the provider's own, and the path is relative to the
  // address the adapter was given. The credential is the transport's to add.
  // A hint this API has no field for is left out of the body and named in
  // the list, so whoever sends the request can pass it on.
  encode: (
    model: string,
    prompt: Prompt<JsonOutput>,
    // A connection's own body fields: whatever the request states replaces
    // one whole.
    defaults?: Dict,
    // What the model takes, where the connection has a rule for it.
    takes?: Takes,
  ) => {
    path: string;
    headers: { [name: string]: string };
    body: Json;
    leftOut: LeftOut[];
  };
  // A chunk a reply in this API has no form for. One that ends the reply is
  // part of the answer; any other only annotates it, and what annotates is
  // left out while reasoning text beside it stays.
  formless: (chunk: Chunk) => { warning: LeftOut; ends: boolean } | undefined;
  // Always exactly one terminal event, also when the upstream's stream ends
  // without one.
  // What the connection's holder cuts from an upstream's words is cut from
  // a failure as it is read, before any of it is shortened.
  events: (
    messages: AsyncIterable<ServerSentEvent>,
    clean?: Clean,
  ) => EventStream;
  failure: (
    status: number,
    headers: Headers,
    body: string,
    clean?: Clean,
  ) => ErrorFacts;
};
