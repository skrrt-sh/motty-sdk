import {
  bound,
  type ErrorFacts,
  fromFacts,
  type Json,
  type KnownCode,
  type ModelAdapter,
} from '@mottyjs/core/host';
import { retryAfter } from '@mottyjs/serve/retry-after';
import {
  cleaned,
  loose,
  raised,
  stated,
  upstreamFailure,
} from '@mottyjs/serve/upstream-failure';
import {
  addressed,
  broken,
  credentials,
  endpoint,
  moved,
  prefixed,
  told,
} from './connection.ts';
import { parsed } from './json.ts';

const family = 'typesafe';

function fields(read: Json | undefined) {
  return typeof read === 'object' && read !== null && !Array.isArray(read)
    ? read
    : {};
}

// A body that is an object is an error the API wrote; anything else is not.
function said(body: string) {
  try {
    return fields(parsed(body));
  } catch {
    return {};
  }
}

// Laya answers a name it does not know with a checkpoint its router chose,
// and no error. Only then does it say what the router detected in the state:
// for a name it took, an alias or other letters included, that is null.
function picked(answer: Json) {
  const { routing } = fields(answer);
  const told = fields(routing);
  const { detection } = told;
  return (detection ?? null) === null ? undefined : told;
}

// A server of this API names no failure by code, so two are read by their
// words: a model it does not know, and a state past the length it reads.
function named(status: number, sentence: string): KnownCode | undefined {
  if (/^\s*unknown model/i.test(sentence)) return 'unknown_model';
  return status === 413 && /state too large/i.test(sentence)
    ? 'context_too_long'
    : undefined;
}

// The two servers of this API tell a failure as a sentence, as an object
// that holds one, or as a validator's list. The body is kept as the cause.
// The motty reads all of it, so the secrets are cut before any is shortened.
function failure(
  status: number,
  headers: Headers,
  body: string,
  clean: (text: string) => string,
): ErrorFacts {
  const written = said(body);
  const { detail } = written;
  const error = { ...loose(written), ...raised(detail) };
  const { message } = error;
  const sentence =
    typeof message === 'string' && message.trim() !== '' ? message : undefined;
  const request = headers.get('x-typesafe-request-id');
  const code = sentence === undefined ? undefined : named(status, sentence);
  // No server of this API tells a model it does not know with a 404, and
  // both tell a path they do not have with one. So it is the host's setup,
  // which no other try mends and no caller's other model should hide.
  const lost = status === 404 && code === undefined;
  const words = cleaned(sentence, clean);
  return {
    ...upstreamFailure(
      {
        code: lost ? 'upstream_failed' : code,
        message: lost
          ? "The decision upstream has no decisions at the adapter's address, which is likely wrong"
          : (words ?? `The decision upstream answered ${status}`),
        ...(lost && words !== undefined ? { detail: words } : {}),
        ...(lost ? { retryable: false } : {}),
        record: {
          [family]: {
            ...stated(error, clean),
            status,
            ...(request === null ? {} : stated({ request_id: request }, clean)),
          },
        },
        error: written,
        headers,
      },
      status,
      retryAfter(headers),
    ),
    ...(body === '' ? {} : { cause: clean(body).slice(0, 1000) }),
  };
}

export function typesafe(options: {
  key?: string | undefined;
  address?: string;
  prefix?: string;
  // In milliseconds.
  timeout?: number;
  headers?: { [name: string]: string };
  // Fields in the server's own names, sent with every request. Laya takes
  // controls that Jev refuses with a 400, so only a host that knows its
  // server states them; the call's own state, questions and model replace it.
  body?: { [name: string]: Json };
  // Laya answers a name of Jev's by its router on purpose, so one motty can
  // run on both. Only the host knows its server does: unsaid, a name the
  // server did not take is a model it does not know.
  routes?: boolean;
}): ModelAdapter {
  const { key, routes = false } = options;
  const name = prefixed(options.prefix ?? family);
  const address = addressed(
    name,
    options.address ?? 'https://api.typesafe.ai/v1',
  );
  // A decision is one short answer, and a route waits for it before it does
  // anything else. Jev on a new connection takes about half a second, so
  // this lets a slow one through and is still a wait a route can afford.
  const timeout =
    bound(`The ${name} adapter's timeout`, options.timeout) ?? 2000;
  const prefix = `${name}/`;
  // The host's headers add; the content type and the credential stay ours.
  const { headers, clean } = credentials(name, key, undefined, options.headers);
  headers.set('content-type', 'application/json');
  if (
    options.address === undefined &&
    (key === undefined || key.trim() === '')
  ) {
    throw new Error(`The ${name} adapter was given no key`);
  }

  return {
    serves: (model) => model.startsWith(prefix),
    decide: async (model, input, signal) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw fromFacts({
          code: 'invalid_request',
          status: 400,
          message: 'A decision takes a state and questions',
        });
      }
      const limit = AbortSignal.timeout(timeout);
      let response: Response;
      let body: string;
      try {
        response = await fetch(endpoint(address, '/systemone'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...options.body,
            ...input,
            model: model.slice(prefix.length),
          }),
          signal: AbortSignal.any([signal, limit]),
          redirect: 'manual',
        });
        // Only an answer is read whole: a failure has a limit.
        body = await (response.ok ? response.text() : told(response));
      } catch (thrown) {
        throw fromFacts(
          limit.aborted && !signal.aborted
            ? {
                code: 'timed_out',
                status: 504,
                message: `The decision upstream gave no answer in ${timeout} ms`,
                retryable: true,
                upstream: true,
              }
            : broken(signal, thrown, clean),
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw fromFacts(moved(response.status));
      }
      if (!response.ok) {
        throw fromFacts(
          failure(response.status, response.headers, body, clean),
        );
      }
      let answer: Json;
      try {
        answer = parsed(body);
      } catch {
        throw fromFacts({
          code: 'invalid_output',
          status: 502,
          message: 'The decision upstream answered with what is not JSON',
          upstream: true,
        });
      }
      const routing = routes ? undefined : picked(answer);
      if (routing === undefined) return answer;
      // The name is the motty's own and holds no secret of the host's.
      throw fromFacts({
        code: 'unknown_model',
        message: `The decision upstream does not know the model '${model.slice(prefix.length)}' and answered with one its router chose`,
        provider: { [family]: stated(routing, clean) },
        upstream: true,
      });
    },
  };
}
