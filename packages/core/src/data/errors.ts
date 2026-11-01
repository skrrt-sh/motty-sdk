import { isObject, type ProviderData } from './message.ts';

// The second member keeps an author's own code allowed and the known ones
// offered by an editor.
type Code = KnownCode | (string & {});

/**
 * An error as plain data, which is how it crosses between a motty and its host.
 */
export type ErrorFacts = {
  code: Code;
  status?: number;
  message: string;
  /** How long the upstream asked to wait, in ms. */
  retryAfter?: number;
  retryable?: boolean;
  provider?: ProviderData;
  /**
   * The error came from outside the motty, so its message is not the motty's.
   * Only a host says false, of a failure of its own; absent means the same.
   */
  upstream?: boolean;
  /**
   * What was thrown is no SDK error, so its message was not written for a
   * caller.
   */
  unexpected?: true;
  stack?: string;
  cause?: string;
};

type RaiseOptions = {
  /** Kept as the error's `cause` and never sent to a caller. */
  cause?: unknown;
  /** The HTTP status a caller is sent, in place of the class's own. */
  status?: number;
  /** Whether `retry` may try again, in place of the class's own. */
  retryable?: boolean;
  /**
   * How long to wait before another try, in ms. `retry` honors up to 30000 and
   * gives up beyond it.
   */
  retryAfter?: number;
  provider?: ProviderData;
  upstream?: true;
  unexpected?: boolean;
};

// A bundle and its host each hold a copy of the SDK; a registered symbol is one they share.
const brand = Symbol.for('@mottyjs/core/error');

function raised(value: unknown, code?: string): boolean {
  if (!isObject(value)) return false;
  if (!(brand in value && 'code' in value)) return false;
  return code === undefined || value.code === code;
}

/**
 * The base of every error the SDK raises. A caller is told its code, status and
 * message, while anything thrown that is no `MottyError` reaches a caller only
 * as an internal error with no words of its own.
 */
export class MottyError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    // biome-ignore lint/complexity/noThisInStatic: a subclass given no code of its own raises the base's code, and only `this` tells it from the base
    return raised(value, this === MottyError ? undefined : 'internal');
  }

  readonly code: string = 'internal';
  readonly status: number;
  readonly retryable: boolean;
  declare readonly retryAfter?: number;
  declare readonly provider?: ProviderData;
  declare readonly upstream?: true;
  declare readonly unexpected?: true;

  constructor(message: string, options: RaiseOptions = {}) {
    super(message, options);
    this.name = new.target.name || 'MottyError';
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    if (options.retryAfter !== undefined) {
      this.retryAfter = options.retryAfter;
    }
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.upstream === true) this.upstream = true;
    if (options.unexpected === true) this.unexpected = true;
  }

  // Set here and not declared: a member keyed by the symbol would be part of
  // the class's type, which a declaration file cannot name.
  static {
    Object.defineProperty(MottyError.prototype, brand, { value: true });
  }

  // Named, or a declaration file spells out the class it returns, and with
  // it the statics the runtime's own types give Error, Node's among them.
  /**
   * Makes an error class with its own `code` and default status, as in `class
   * Spent extends MottyError.define('spent', 402) {}`. `retryable` is false
   * unless stated.
   */
  static define(
    code: string,
    status: number,
    { retryable = false }: { retryable?: boolean } = {},
  ): typeof MottyError {
    return class extends MottyError {
      static override [Symbol.hasInstance](value: unknown): boolean {
        return raised(value, code);
      }

      override readonly code = code;

      constructor(message: string, options: RaiseOptions = {}) {
        super(message, {
          ...options,
          status: options.status ?? status,
          retryable: options.retryable ?? retryable,
        });
      }
    };
  }
}

/**
 * An upstream's rate limit was reached. Status 429, and `retry` tries again.
 */
export class RateLimited extends MottyError.define('rateLimited', 429, {
  retryable: true,
}) {}
/**
 * A balance, budget or quota is spent, which a wait does not mend. Status 429,
 * and `retry` does not try again.
 */
export class QuotaExceeded extends MottyError.define('quotaExceeded', 429) {}
/**
 * An upstream is too busy, or the server is shutting down. Status 503, and
 * `retry` tries again.
 */
export class Overloaded extends MottyError.define('overloaded', 503, {
  retryable: true,
}) {}
/** The prompt does not fit the model's context. Status 400. */
export class ContextTooLong extends MottyError.define('contextTooLong', 400) {}
/** A content filter or policy refused the request. Status 400. */
export class Blocked extends MottyError.define('blocked', 400) {}
/**
 * The model, the API or the host has no way to do what was asked. Status 400.
 */
export class Unsupported extends MottyError.define('unsupported', 400) {}
/** The caller may not do what was asked. Status 403. */
export class Forbidden extends MottyError.define('forbidden', 403) {}
/** The request itself is wrong. Status 400. */
export class InvalidRequest extends MottyError.define('invalidRequest', 400) {}
/**
 * An upstream failed or could not be reached. Status 502, and `retry` tries
 * again unless the failure says it would not help.
 */
export class UpstreamFailed extends MottyError.define('upstreamFailed', 502, {
  retryable: true,
}) {}
/**
 * An upstream refused the host's key, account or settings, which another try
 * does not mend. Status 502.
 */
export class UpstreamRefused extends MottyError.define(
  'upstreamRefused',
  502,
) {}
/**
 * No adapter of the host serves the model name, or the upstream does not know
 * it. Status 404.
 */
export class UnknownModel extends MottyError.define('unknownModel', 404) {}
/** A time limit passed. Status 504, and `retry` tries again. */
export class TimedOut extends MottyError.define('timedOut', 504, {
  retryable: true,
}) {}
/**
 * The work was stopped, as when the caller leaves. Status 499, and `retry`
 * never tries again.
 */
export class Aborted extends MottyError.define('aborted', 499) {}
/**
 * The request has no caller the host could identify, which `auth()` raises.
 * Status 401.
 */
export class Unauthenticated extends MottyError.define(
  'unauthenticated',
  401,
) {}
/**
 * The answer is not JSON or does not match the schema, which `answer.json()`
 * raises. Status 502.
 */
export class InvalidOutput extends MottyError.define('invalidOutput', 502) {}
/**
 * The request needs more model calls than `limits.calls` allows. Status 400,
 * and `retry` never tries again.
 */
export class LimitReached extends MottyError.define('limitReached', 400) {}
/** A reroute named an entry that already ran for this request. Status 500. */
export class RouteLoop extends MottyError.define('routeLoop', 500) {}
/**
 * A chooser or a reroute named an entry the table does not have. Status 500.
 */
export class UnknownRoute extends MottyError.define('unknownRoute', 500) {}

type Raised = new (message: string, options?: RaiseOptions) => MottyError;

const known = {
  internal: MottyError,
  rateLimited: RateLimited,
  quotaExceeded: QuotaExceeded,
  overloaded: Overloaded,
  contextTooLong: ContextTooLong,
  blocked: Blocked,
  unsupported: Unsupported,
  forbidden: Forbidden,
  invalidRequest: InvalidRequest,
  upstreamFailed: UpstreamFailed,
  upstreamRefused: UpstreamRefused,
  unknownModel: UnknownModel,
  timedOut: TimedOut,
  aborted: Aborted,
  unauthenticated: Unauthenticated,
  invalidOutput: InvalidOutput,
  limitReached: LimitReached,
  routeLoop: RouteLoop,
  unknownRoute: UnknownRoute,
} satisfies Record<string, Raised>;

// All a caller is told of a throw that was not meant for them.
const internal = 'Internal error';

/** The code of an error class the SDK knows. */
export type KnownCode = keyof typeof known;

// An own-property check keeps a code like "constructor" off the prototype.
function isKnown(code: string): code is KnownCode {
  return Object.hasOwn(known, code);
}

function described(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error && typeof value.message === 'string') {
    return value.message;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
}

// Only what the cause says of itself, one level down: facts stay shallow.
function because(cause: unknown): { cause?: string } {
  return cause === undefined ? {} : { cause: described(cause) };
}

// True of a call and of a whole request alike: either may be what ended.
export const stopped = 'The work was stopped';
export const timedOut = 'The work timed out';

function interrupted(
  thrown: unknown,
  options: RaiseOptions = {},
): MottyError | undefined {
  if (thrown instanceof MottyError) return thrown;
  if (!(thrown instanceof Error)) return undefined;
  if (thrown.name === 'AbortError') return new Aborted(stopped, options);
  if (thrown.name === 'TimeoutError') return new TimedOut(timedOut, options);
  return undefined;
}

// An error the host gave as its reason is raised as it is: it is the host's,
// so the cause is put only on an error made here.
export function stopReason(reason: unknown, cause?: unknown): MottyError {
  const options = cause === undefined ? {} : { cause };
  return interrupted(reason, options) ?? new Aborted(stopped, options);
}

type Quoted = Pick<ErrorFacts, 'message' | 'stack' | 'cause'>;

function quoted(thrown: unknown): Quoted {
  const failed = thrown instanceof Error;
  return {
    message:
      failed && typeof thrown.message === 'string'
        ? thrown.message
        : `A value that is not an error was thrown: ${described(thrown)}`,
    ...(failed && typeof thrown.stack === 'string'
      ? { stack: thrown.stack }
      : {}),
    ...(failed ? because(thrown.cause) : {}),
  };
}

function sealed(said?: Quoted): ErrorFacts {
  return {
    code: 'internal',
    status: 500,
    message: internal,
    retryable: false,
    unexpected: true,
    ...said,
  };
}

// Reading what was thrown runs its own code, which may throw in its turn:
// such a value is quoted in nothing.
export function unexpected(thrown: unknown): ErrorFacts {
  try {
    return sealed(quoted(thrown));
  } catch {
    return sealed();
  }
}

function told(thrown: unknown): ErrorFacts {
  const raised = interrupted(thrown);
  if (raised === undefined) return sealed(quoted(thrown));
  const { code, status, message, retryable, retryAfter, provider, upstream } =
    raised;
  // The brand alone promises no field types, and JSON has no NaN or Infinity.
  return {
    code: typeof code === 'string' ? code : 'internal',
    ...(Number.isFinite(status) ? { status } : {}),
    message: typeof message === 'string' ? message : internal,
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(typeof retryAfter === 'number' &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
      ? { retryAfter }
      : {}),
    ...(provider === undefined ? {} : { provider }),
    ...(upstream === true ? { upstream } : {}),
    ...(raised.unexpected === true ? { unexpected: true } : {}),
    ...because(raised.cause),
  };
}

/**
 * Turns anything thrown into facts and never throws. A value that is no SDK
 * error is marked `unexpected`.
 */
export function toFacts(thrown: unknown): ErrorFacts {
  try {
    return told(thrown);
  } catch {
    return sealed();
  }
}

/**
 * Cuts facts down to what a caller may read. The stack and the cause never go
 * out, and an unexpected error's message and provider data do not either.
 */
export function disclosed(facts: ErrorFacts): ErrorFacts {
  const { code, status, message, retryable, retryAfter, provider } = facts;
  const meant = facts.unexpected !== true;
  return {
    code,
    ...(status === undefined ? {} : { status }),
    message: meant ? message : internal,
    ...(retryable === undefined ? {} : { retryable }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(meant && provider !== undefined ? { provider } : {}),
  };
}

/**
 * Raises facts again as the error class of their code, or as a class made for a
 * code the SDK does not know.
 */
export function fromFacts(facts: ErrorFacts): MottyError {
  const { status, retryable, retryAfter, provider, upstream, cause } = facts;
  const { unexpected } = facts;
  // Facts that crossed a wire as JSON may hold a null or a wrong type.
  const code = typeof facts.code === 'string' ? facts.code : 'internal';
  const message = typeof facts.message === 'string' ? facts.message : internal;
  const Raised: Raised = isKnown(code)
    ? known[code]
    : MottyError.define(code, 500);
  return new Raised(message, {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
    ...(isObject(provider) && !Array.isArray(provider) ? { provider } : {}),
    ...(upstream === true ? { upstream } : {}),
    ...(unexpected === true ? { unexpected } : {}),
    ...(typeof cause === 'string' ? { cause } : {}),
  });
}
