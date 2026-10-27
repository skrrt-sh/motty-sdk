type Scalar = string | number | boolean | null;

export type Json = Scalar | Json[] | { [key: string]: Json };

// JSON as it is passed in: read and never changed, so what is given may be
// read-only. Whoever is handed JSON to keep gets the form above.
export type ReadonlyJson =
  | Scalar
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };

export type JsonSchema = { [keyword: string]: ReadonlyJson };

// Keyed by whoever can read the value back: a wire family, or something narrower
// when a value is not portable inside one. A key of another family is
// dropped when it sits in `hints`.
export type ProviderData = { [key: string]: ReadonlyJson };

export type Cache = { ttl?: '5m' | '1h' };

// `data` is base64.
export type Media =
  | { url: string; data?: never; id?: never; mediaType?: string }
  | { data: string; url?: never; id?: never; mediaType?: string }
  | { id: string; url?: never; data?: never; mediaType?: string };

export type Content =
  | { text: string; parts?: never }
  | { text?: never; parts: readonly Part[] };

type KnownPart =
  | { type: 'text'; text: string }
  | ({ type: 'image' } & Media)
  | ({ type: 'file'; name?: string } & Media)
  | ({ type: 'audio' } & Media)
  | { type: 'reasoning'; text: string }
  // `input` is the parsed arguments, a string for a custom tool's free-form
  // input; `raw` is arguments that did not parse.
  | ({ type: 'tool_call'; id: string; name: string; hosted?: boolean } & (
      | { input: ReadonlyJson; raw?: never }
      | { input?: never; raw: string }
    ))
  | ({
      type: 'tool_result';
      id: string;
      failed?: boolean;
      hosted?: boolean;
    } & Content)
  // Annotates the text part before it.
  | { type: 'citation'; title?: string; url?: string; text?: string }
  | { type: 'refusal'; text: string };

export type Part =
  | (KnownPart & {
      cache?: Cache;
      provider?: ProviderData;
      hints?: ProviderData;
    })
  | { type: 'provider'; provider: ProviderData; hints?: ProviderData };

export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export type Message = {
  role: Role;
  name?: string;
  cache?: Cache;
  provider?: ProviderData;
  hints?: ProviderData;
} & Content;

export type Tool =
  | {
      type: 'function';
      name: string;
      description?: string;
      input: JsonSchema;
      strict?: boolean;
      cache?: Cache;
      provider?: ProviderData;
      hints?: ProviderData;
    }
  | {
      type: 'custom';
      name: string;
      description?: string;
      grammar?: { syntax: 'lark' | 'regex'; definition: string };
      provider?: ProviderData;
      hints?: ProviderData;
    }
  | {
      type: 'provider';
      name?: string;
      cache?: Cache;
      provider: ProviderData;
      hints?: ProviderData;
    };

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { tool: string }
  | { allowed: readonly [string, ...string[]]; mode: 'auto' | 'required' }
  | { provider: ProviderData };

export type Options = {
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    budgetTokens?: number;
    exclude?: boolean;
  };
  stop?: readonly string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  user?: string;
  /**
   * Sent upstream only where the host's connection allows the name. The
   * connection's and the API's own headers win, a null or undefined value is skipped,
   * and credentials, cookies and connection headers are never sent.
   */
  headers?: { readonly [name: string]: string | null | undefined };
  provider?: ProviderData;
  hints?: ProviderData;
};

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?:
          | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
          | undefined;
      }>;
    };

export type StandardSchema<Input = unknown, Output = Input> = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
    readonly jsonSchema?:
      | {
          readonly output: (options: {
            readonly target: 'draft-2020-12';
          }) => Record<string, unknown>;
        }
      | undefined;
  };
};

// With no `schema` it asks for any JSON object.
export type JsonOutput = {
  schema?: JsonSchema;
  name?: string;
  description?: string;
  strict?: boolean;
};

// An author states the name and the strictness beside a schema of a library.
export type OutputSchema =
  | StandardSchema
  | JsonOutput
  | (Omit<JsonOutput, 'schema'> & { schema: StandardSchema });

export type Prompt<Output extends OutputSchema = OutputSchema> = {
  messages: readonly Message[];
  tools?: readonly Tool[];
  options?: Options;
  output?: Output;
};

// The same data with every list of the SDK's open to change. Stops at JSON,
// which is the same data whoever holds it.
export type Open<Data> = [Json] extends [Data]
  ? Data
  : Data extends object
    ? { -readonly [Key in keyof Data]: Open<Data[Key]> }
    : Data;

// What a context holds, for a hook to change in place: its own lists and its
// options are open. A message in it is any a prompt takes, the caller's too,
// so the lists inside a message are replaced.
export type Draft = Omit<Prompt, 'messages' | 'tools' | 'options'> & {
  messages: Message[];
  tools?: Tool[];
  options?: Open<Options>;
};

// The same data read-only at every depth, stopping where opening it stops.
// A function and a branded scalar are kept as they are: mapped, the one could
// no longer be called and the other would be an object.
export type Closed<Data> = [Json] extends [Data]
  ? Data
  : Data extends Scalar | ((...given: never) => unknown)
    ? Data
    : Data extends object
      ? { readonly [Key in keyof Data]: Closed<Data[Key]> }
      : Data;

// The host makes it per request and the motty is not given a copy.
export type ChatRequest = Closed<{
  id: string;
  model: string;
  messages: Message[];
  tools: Tool[];
  options: Options;
  output?: JsonOutput;
}> & { readonly headers: Headers };

// A coding agent puts its own notes in text parts ahead of the user's words, so a message
// says its last text part. Only the fields read are typed: checking a request's read-only
// message against `Message` cost the type-check far more than the function itself.
export function said(
  message:
    | {
        text?: string;
        parts?: readonly { type: Part['type']; text?: string }[];
      }
    | undefined,
): string {
  return (
    message?.text ??
    message?.parts?.findLast((part) => part.type === 'text')?.text ??
    ''
  );
}

// A function holds keys as an object does: some validator libraries make
// their schemas callable.
export function keyed(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}
