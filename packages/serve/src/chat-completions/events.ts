import type {
  EventStream,
  Finish,
  Json,
  StreamEvent,
  Usage,
} from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import { cutShort, unreadable } from '../wire/broken-stream.ts';
import { inline } from '../wire/data-url.ts';
import {
  type Dict,
  dict,
  given,
  isDict,
  list,
  number,
  parsed,
  text,
} from '../wire/json.ts';
import { failed } from '../wire/openai-failure.ts';
import type { Clean } from '../wire/upstream-failure.ts';
import { unchunked } from './content-chunks.ts';
import { type Dialect, plain } from './dialect.ts';
import { family } from './family.ts';
import { reasonFailed, reasonRead } from './finish.ts';
import { untagged } from './think-tags.ts';
import { usageRead } from './usage.ts';

function probable(tokens: Json | undefined): { provider?: Dict } {
  return Array.isArray(tokens) && tokens.length > 0
    ? { provider: { [family]: { logprobs: tokens } } }
    : {};
}

// One per stream: after its first fragment a call is named by index alone.
// A chunk is read into a list: a generator inside the stream's own made
// every event wait again, a fifth of what reading one cost.
function reader(dialect: Dialect) {
  const ids = new Map<number, string>();
  const tags =
    dialect.tagged === undefined
      ? undefined
      : untagged(dialect.tagged === 'open');
  let owed: Json[] = [];

  function called(raw: Json): StreamEvent {
    const { index, id, type, function: fn, custom } = dict(raw);
    const at = number(index) ?? 0;
    if (typeof id === 'string' && id !== '') ids.set(at, id);
    const free = isDict(custom);
    const { name, arguments: source, input } = dict(free ? custom : fn);
    return {
      type: 'tool_call',
      id: ids.get(at) ?? `call_${at}`,
      ...(typeof name === 'string' ? { name } : {}),
      arguments: text(free ? input : source) ?? '',
      // The caller's wire writes a free-form call apart from a function's.
      ...(free || type === 'custom'
        ? { provider: { [family]: { type: 'custom' } } }
        : {}),
    };
  }

  // A chunk's likelihoods are of its text, so they go with the first of it:
  // with its reasoning where it held no text and nothing signed that, and
  // with what comes next where all of it was held back.
  function told(
    read: readonly Extract<StreamEvent, { type: 'text' | 'reasoning' }>[],
    tokens?: Json,
  ): StreamEvent[] {
    owed = [...owed, ...list(tokens)];
    const text = read.findIndex(({ type }) => type === 'text');
    const first =
      text === -1
        ? read.findIndex(({ provider }) => provider === undefined)
        : text;
    return read.map((piece, at) => {
      if (at !== first) return piece;
      const likely = { ...piece, ...probable(owed) };
      owed = [];
      return likely;
    });
  }

  const spoken =
    tags === undefined
      ? (content: string, tokens: Json | undefined): StreamEvent[] => [
          { type: 'text', text: content, ...probable(tokens) },
        ]
      : (content: string, tokens: Json | undefined) =>
          told(tags.read(content), tokens);

  // Text that might have opened a tag when the reply ended was text.
  // Likelihoods no text came for are still the reply's, told with none.
  function ended(): StreamEvent[] {
    const last = told(tags?.ended() ?? []);
    if (owed.length === 0) return last;
    return [...last, ...told([{ type: 'text', text: '' }])];
  }

  function choice(raw: Dict): StreamEvent[] {
    const { delta, logprobs } = raw;
    const { content: tokens, refusal: refused } = dict(logprobs);
    const {
      reasoning,
      reasoning_content: thought,
      reasoning_details: detailed,
      content,
      refusal,
      tool_calls: calls,
      annotations,
      audio,
      images,
    } = dict(delta);
    const out: StreamEvent[] = [];
    const details = dialect.details === true ? list(detailed) : [];
    const mused = thought ?? reasoning;
    const said = typeof mused === 'string' ? mused : '';
    // A signature comes with no text, on a chunk of its own.
    if (said !== '' || details.length > 0) {
      out.push({
        type: 'reasoning',
        text: said,
        ...(details.length === 0
          ? {}
          : { provider: { [family]: { reasoning_details: details } } }),
      });
    }
    if (typeof content === 'string' && content !== '') {
      out.push(...spoken(content, tokens));
    }
    if (typeof refusal === 'string' && refusal !== '') {
      out.push({ type: 'refusal', text: refusal, ...probable(refused) });
    }
    // A call follows the text before it, so what was held is said first.
    if (list(calls).length > 0) out.push(...ended());
    for (const call of list(calls)) out.push(called(call));
    for (const annotation of list(annotations)) {
      const { url_citation: cited } = dict(annotation);
      const { url, title, start_index, end_index } = dict(cited);
      if (typeof url !== 'string') continue;
      out.push({
        type: 'citation',
        url,
        ...(typeof title === 'string' ? { title } : {}),
        provider: { [family]: given({ start_index, end_index }) },
      });
    }
    // Sound has no chunk of its own, so it stays this family's to read.
    if (isDict(audio)) {
      out.push({ type: 'provider', provider: { [family]: { audio } } });
    }
    // A picture is a file like any other; what else its entry held, and
    // that it is a picture when only an address says so, stays this family's.
    for (const image of dialect.images === true ? list(images) : []) {
      const { image_url: located, ...more } = dict(image);
      const { url } = dict(located);
      if (typeof url !== 'string') continue;
      out.push({
        type: 'file',
        ...(inline(url) ?? { url }),
        provider: { [family]: { type: 'image_url', ...more } },
      });
    }
    return out;
  }

  // A content that is a list is read a chunk at a time, and what the delta
  // holds beside it as any other delta's.
  function listed(raw: Dict): StreamEvent[] {
    const { delta, logprobs } = raw;
    const { content } = dict(delta);
    if (!Array.isArray(content)) return choice(raw);
    const { content: tokens } = dict(logprobs);
    return [
      ...told(unchunked(content), tokens),
      ...choice({ ...raw, delta: { ...dict(delta), content: null } }),
    ];
  }

  return { choice: dialect.chunked === true ? listed : choice, ended };
}

// What a reply says of itself at its end, as its chunks gave it so far.
function headed(
  id?: Json,
  model?: Json,
  system_fingerprint?: Json,
  service_tier?: Json,
) {
  return { id, model, system_fingerprint, service_tier };
}

// A read that throws is left to whoever holds the connection, so a broken
// one is told the same way whichever API was being read.
export async function* events(
  messages: AsyncIterable<ServerSentEvent>,
  dialect: Dialect = plain,
  clean?: Clean,
): EventStream {
  const { choice, ended } = reader(dialect);
  const { envelope } = dialect;
  let reason: string | undefined;
  let native: string | undefined;
  let done = false;
  let usage: Usage | undefined;
  let head = headed();
  const counted = (): { usage?: Usage } =>
    usage === undefined ? {} : { usage };
  try {
    for await (const { data } of messages) {
      if (data === '[DONE]') {
        done = true;
        break;
      }
      const chunk = parsed(data);
      if (!isDict(chunk)) {
        yield* ended();
        yield { type: 'error', error: unreadable(), ...counted() };
        return;
      }
      const { error, usage: reported, choices, service_tier } = chunk;
      // A failure may be a sentence where this family has an object.
      const raised = isDict(error)
        ? error
        : typeof error === 'string' && error.trim() !== ''
          ? { message: error }
          : envelope?.(chunk);
      if (raised !== undefined) {
        yield* ended();
        yield {
          type: 'error',
          error: failed(
            dialect.name,
            raised,
            dialect.failures,
            dialect.cuts,
            clean,
          ),
          ...counted(),
        };
        return;
      }
      // What a chunk leaves out stays as an earlier one gave it, and a null
      // tier says what no tier says.
      const {
        id = head.id,
        model = head.model,
        system_fingerprint = head.system_fingerprint,
      } = chunk;
      head = headed(
        id,
        model,
        system_fingerprint,
        service_tier ?? head.service_tier,
      );
      if (isDict(reported)) usage = usageRead(reported, dialect.flat);
      const [first] = list(choices);
      if (!isDict(first)) continue;
      for (const event of choice(first)) yield event;
      const { finish_reason: finished, native_finish_reason: own } = first;
      reason = text(finished) ?? reason;
      if (dialect.native === true) native = text(own) ?? native;
    }
  } catch (thrown) {
    // What was held was said before the read broke, so it is told first.
    yield* ended();
    throw thrown;
  }
  yield* ended();
  // The usage chunk follows the reason, so the finish waits for the end.
  // A stream marked done finished: one that gave no reason, as a reply of
  // sound alone may not, stopped.
  if (reason === undefined && !done) {
    yield { type: 'error', error: cutShort(), ...counted() };
    return;
  }
  const failure =
    reason === undefined
      ? undefined
      : reasonFailed(dialect.name, reason, dialect.broken);
  if (failure !== undefined) {
    yield { type: 'error', error: failure, ...counted() };
    return;
  }
  const { id, model, system_fingerprint, service_tier } = head;
  const said = given({ system_fingerprint, service_tier });
  const finish: Finish = {
    type: 'finish',
    reason: reason === undefined ? 'stop' : reasonRead(reason, dialect.endings),
    // The one ending this wire's own reason does not tell from a stop.
    ...(reason === 'stop' && native === 'stop_sequence'
      ? { rawReason: native }
      : reason === undefined
        ? {}
        : { rawReason: reason }),
    ...counted(),
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(Object.keys(said).length === 0 ? {} : { provider: { [family]: said } }),
  };
  yield finish;
}
