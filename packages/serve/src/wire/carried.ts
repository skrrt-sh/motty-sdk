import type { Dict } from './json.ts';
import { invalid } from './refusals.ts';

// A header that says what the body may hold, as a beta does, is the
// request's own as a body field is. It is kept among its family's fields
// under its own name, which no body field has, and sent back as a header.
// What is named is told of a name in lower case, and is never a header a
// credential is sent in.
export function carrying(named: (name: string) => boolean) {
  // A header sent twice is read as one list.
  function heard(headers: Headers): Dict {
    const said: Dict = {};
    for (const [name, value] of headers) {
      if (named(name) && value.trim() !== '') said[name] = value.trim();
    }
    return said;
  }

  function parted(fields: Dict): {
    headers: { [name: string]: string };
    rest: Dict;
  } {
    const headers: { [name: string]: string } = {};
    const rest: Dict = {};
    for (const [written, value] of Object.entries(fields)) {
      // A header's name has no letter case, and a field's has.
      const name = written.toLowerCase();
      if (!named(name)) rest[written] = value;
      else if (typeof value === 'string') headers[name] = value;
      // Left out, the body's field would go upstream without what turns it
      // on, and the upstream's refusal would name the field alone.
      else invalid(`The header ${name} must be text`);
    }
    return { headers, rest };
  }

  return { heard, parted };
}
