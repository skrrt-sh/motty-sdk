type Scalar = string | number | boolean | null;

/** A JSON value. */
export type Json = Scalar | Json[] | { [key: string]: Json };

/**
 * JSON as it is passed in: read and never changed, so what is given may be
 * read-only. Whoever is handed JSON to keep gets the form above.
 */
export type ReadonlyJson =
  | Scalar
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };

export type JsonSchema = { [keyword: string]: ReadonlyJson };

/**
 * Keyed by whoever can read the value back: a wire family, or something
 * narrower when a value is not portable inside one. A key of another family is
 * dropped when it sits in `hints`.
 */
export type ProviderData = { [key: string]: ReadonlyJson };

/**
 * A cache marker on a message, a part or a tool. `implied` is a marker a cache
 * key asked for and not one the caller placed, since an upstream that takes
 * none caches by itself and misses nothing.
 */
export type Cache = { ttl?: '5m' | '1h'; implied?: true };

/**
 * An image, a file or sound, given by address, by base64 `data` or by an
 * uploaded `id`.
 */
export type Media =
  | { url: string; data?: never; id?: never; mediaType?: string }
  | { data: string; url?: never; id?: never; mediaType?: string }
  | { id: string; url?: never; data?: never; mediaType?: string };

/** What a message says, as plain `text` or as a list of `parts`. */
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

/** A piece of a message. */
export type Part =
  | (KnownPart & {
      cache?: Cache;
      provider?: ProviderData;
      hints?: ProviderData;
    })
  | { type: 'provider'; provider: ProviderData; hints?: ProviderData };

export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

/** One turn of a conversation. */
export type Message = {
  role: Role;
  name?: string;
  cache?: Cache;
  provider?: ProviderData;
  hints?: ProviderData;
} & Content;

/**
 * A tool the model may call. It is a function with a JSON Schema input, a
 * custom tool with free-form input, or a provider's own.
 */
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

/** How the model may use its tools. */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { tool: string }
  | { allowed: readonly [string, ...string[]]; mode: 'auto' | 'required' }
  | { provider: ProviderData };

/**
 * The neutral options of a model call, which each upstream receives in its own
 * names.
 */
export type Options = {
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    budgetTokens?: number;
    /** Keeps the reasoning out of the reply. */
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
  /**
   * Fields in the upstream's own names, keyed by wire API or vendor. A call
   * fails if this has fields only for another API, so a fallback can move on.
   */
  provider?: ProviderData;
  /**
   * The same as `provider`, except that what this upstream cannot carry is
   * dropped and the call goes on.
   */
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

/** Any validator of the Standard Schema spec, such as a zod schema. */
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

/**
 * Asks for a JSON answer that fits `schema`. With no `schema` it asks for any
 * JSON object.
 */
export type JsonOutput = {
  schema?: JsonSchema;
  name?: string;
  description?: string;
  strict?: boolean;
};

/**
 * A JSON answer asked for by a validator or a JSON Schema. An author states the
 * name and the strictness beside a validator.
 */
export type OutputSchema =
  | StandardSchema
  | JsonOutput
  | (Omit<JsonOutput, 'schema'> & { schema: StandardSchema });

/** What a model call takes. */
export type Prompt<Output extends OutputSchema = OutputSchema> = {
  messages: readonly Message[];
  tools?: readonly Tool[];
  options?: Options;
  /**
   * Asks for JSON. Given a validator, `answer.json()` returns what it parsed,
   * typed by it.
   */
  output?: Output;
};

// The same data with every list of the SDK's open to change. Stops at JSON,
// which is the same data whoever holds it.
export type Open<Data> = [Json] extends [Data]
  ? Data
  : Data extends object
    ? { -readonly [Key in keyof Data]: Open<Data[Key]> }
    : Data;

/**
 * What a context holds, for a hook to change in place: its own lists and its
 * options are open. A message in it is any a prompt takes, the caller's too, so
 * the lists inside a message are replaced.
 */
export type Draft = Omit<Prompt, 'messages' | 'tools' | 'options'> & {
  messages: Message[];
  tools?: Tool[];
  options?: Open<Options>;
};

/**
 * The same data read-only at every depth, stopping where opening it stops. A
 * function and a branded scalar are kept as they are: mapped, the one could no
 * longer be called and the other would be an object.
 */
export type Closed<Data> = [Json] extends [Data]
  ? Data
  : Data extends Scalar | ((...given: never) => unknown)
    ? Data
    : Data extends object
      ? { readonly [Key in keyof Data]: Closed<Data[Key]> }
      : Data;

/**
 * The request a motty is given, read-only. The host makes it per request and
 * the motty is not given a copy.
 */
export type ChatRequest = Closed<{
  id: string;
  model: string;
  messages: Message[];
  tools: Tool[];
  options: Options;
  output?: JsonOutput;
}> & { readonly headers: Headers };

// Only the fields read are typed: checking a request's read-only message
// against `Message` cost the type-check far more than the function itself.
/**
 * Gives what a message says, which is its `text` or else its last text part,
 * since a coding agent puts its own notes in the parts ahead of the user's
 * words. It gives an empty string for a message with neither.
 *
 * @example
 * ```ts
 * const question = said(request.messages.at(-1));
 * ```
 */
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

export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

// A function holds keys as an object does: some validator libraries make
// their schemas callable.
export function keyed(value: unknown): value is object {
  return isObject(value) || typeof value === 'function';
}
