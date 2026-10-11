import type { ProviderData } from './message.ts';

// The second member keeps an author's own code allowed and the known ones
// offered by an editor.
type Code = KnownCode | (string & {});

export type ErrorFacts = {
  code: Code;
  status?: number;
  message: string;
  // In milliseconds.
  retryAfter?: number;
  retryable?: boolean;
  provider?: ProviderData;
  // The error came from outside the motty, so its message is not the motty's.
  // Only a host says false, of a failure of its own; absent means the same.
  upstream?: boolean;
  // What was thrown is no SDK error, so its message was not written for a
  // caller.
  unexpected?: true;
  stack?: string;
  cause?: string;
};

type RaiseOptions = {
  cause?: unknown;
  status?: number;
  retryable?: boolean;
  // In milliseconds.
  retryAfter?: number;
  provider?: ProviderData;
  upstream?: true;
  unexpected?: boolean;
};

// A bundle and its host each hold a copy of the SDK; a registered symbol is one they share.
const brand = Symbol.for('@mottyjs/core/error');

function raised(value: unknown, code?: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (!(brand in value && 'code' in value)) return false;
  return code === undefined || value.code === code;
}

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

  static define(
    code: string,
    status: number,
    { retryable = false }: { retryable?: boolean } = {},
  ) {
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

export class RateLimited extends MottyError.define('rate_limited', 429, {
  retryable: true,
}) {}
export class QuotaExceeded extends MottyError.define('quota_exceeded', 429) {}
export class Overloaded extends MottyError.define('overloaded', 503, {
  retryable: true,
}) {}
export class ContextTooLong extends MottyError.define(
  'context_too_long',
  400,
) {}
export class Blocked extends MottyError.define('blocked', 400) {}
export class Unsupported extends MottyError.define('unsupported', 400) {}
export class Forbidden extends MottyError.define('forbidden', 403) {}
export class InvalidRequest extends MottyError.define('invalid_request', 400) {}
export class UpstreamFailed extends MottyError.define('upstream_failed', 502, {
  retryable: true,
}) {}
export class UpstreamRefused extends MottyError.define(
  'upstream_refused',
  502,
) {}
export class UnknownModel extends MottyError.define('unknown_model', 404) {}
export class TimedOut extends MottyError.define('timed_out', 504, {
  retryable: true,
}) {}
export class Aborted extends MottyError.define('aborted', 499) {}
export class Unauthenticated extends MottyError.define(
  'unauthenticated',
  401,
) {}
export class InvalidOutput extends MottyError.define('invalid_output', 502) {}
export class LimitReached extends MottyError.define('limit_reached', 500) {}
export class RouteLoop extends MottyError.define('route_loop', 500) {}
export class UnknownRoute extends MottyError.define('unknown_route', 500) {}

type Raised = new (message: string, options?: RaiseOptions) => MottyError;

const known = {
  internal: MottyError,
  rate_limited: RateLimited,
  quota_exceeded: QuotaExceeded,
  overloaded: Overloaded,
  context_too_long: ContextTooLong,
  blocked: Blocked,
  unsupported: Unsupported,
  forbidden: Forbidden,
  invalid_request: InvalidRequest,
  upstream_failed: UpstreamFailed,
  upstream_refused: UpstreamRefused,
  unknown_model: UnknownModel,
  timed_out: TimedOut,
  aborted: Aborted,
  unauthenticated: Unauthenticated,
  invalid_output: InvalidOutput,
  limit_reached: LimitReached,
  route_loop: RouteLoop,
  unknown_route: UnknownRoute,
} satisfies Record<string, Raised>;

// All a caller is told of a throw that was not meant for them.
const internal = 'Internal error';

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
const timedOut = 'The work timed out';

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

export function toFacts(thrown: unknown): ErrorFacts {
  try {
    return told(thrown);
  } catch {
    return sealed();
  }
}

// An error says what happened in its own words, an upstream's included. A
// thrown value that is no SDK error may hold anything, so only its code goes
// out. The stack and the cause are the host's to read and never go out.
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
    ...(typeof provider === 'object' &&
    provider !== null &&
    !Array.isArray(provider)
      ? { provider }
      : {}),
    ...(upstream === true ? { upstream } : {}),
    ...(unexpected === true ? { unexpected } : {}),
    ...(typeof cause === 'string' ? { cause } : {}),
  });
}
