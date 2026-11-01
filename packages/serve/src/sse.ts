/** One event of a server-sent stream. */
export type ServerSentEvent = { event?: string; data: string };

/** Writes one event as it goes on the wire. */
export function formatted({ event, data }: ServerSentEvent): string {
  const lines = data.split('\n').map((line) => `data: ${line}`);
  if (event !== undefined) lines.unshift(`event: ${event}`);
  return `${lines.join('\n')}\n\n`;
}

function read(event: string | undefined, data: string): ServerSentEvent {
  return event === undefined ? { data } : { event, data };
}

/**
 * Reads a body into events as the standard reads a stream. Comments, ids and
 * retry times are dropped, and so is an event the stream ended in the middle
 * of.
 */
export async function* parsed(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const decoder = new TextDecoder();
  let held = '';
  let carried = '';
  let event: string | undefined;
  let data: string | undefined;
  for await (const bytes of body) {
    // The three line breaks are made one. A return that ends the text may
    // be the first half of a line break, so it waits for what follows.
    const decoded = carried + decoder.decode(bytes, { stream: true });
    const text = decoded.includes('\r')
      ? decoded.replace(/\r\n|\r(?!$)/g, '\n')
      : decoded;
    carried = text.endsWith('\r') ? '\r' : '';
    // Only what came is searched: a line held over many chunks was read
    // again with each one.
    const fresh = carried === '' ? text : text.slice(0, -1);
    let from = 0;
    for (
      let end = fresh.indexOf('\n');
      end !== -1;
      end = fresh.indexOf('\n', from)
    ) {
      // The line every event has, read with no string for the line or its name.
      if (held === '' && fresh.startsWith('data: ', from)) {
        const value = fresh.slice(from + 6, end);
        data = data === undefined ? value : `${data}\n${value}`;
        from = end + 1;
        continue;
      }
      const line =
        held === '' ? fresh.slice(from, end) : held + fresh.slice(from, end);
      held = '';
      from = end + 1;
      if (line === '') {
        if (data !== undefined) yield read(event, data);
        event = undefined;
        data = undefined;
        continue;
      }
      // A line with no colon is all name.
      const colon = line.indexOf(':');
      const at = colon === -1 ? line.length : colon;
      const field = line.slice(0, at);
      const value = line.slice(at + (line[at + 1] === ' ' ? 2 : 1));
      if (field === 'event') event = value;
      else if (field === 'data') {
        data = data === undefined ? value : `${data}\n${value}`;
      }
    }
    held += fresh.slice(from);
  }
  // The return still waiting was a whole line break: nothing came after it.
  if (carried !== '' && held === '' && data !== undefined) {
    yield read(event, data);
  }
}
