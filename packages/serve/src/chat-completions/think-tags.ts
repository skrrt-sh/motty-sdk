import type { Chunk } from '@mottyjs/core/host';

const opening = '<think>';
const closing = '</think>';

export function wrapped(text: string): string {
  return `${opening}${text}${closing}`;
}

// How much of the end of a text may still grow into the tag.
function begun(text: string, tag: string): number {
  for (let size = Math.min(tag.length - 1, text.length); size > 0; size--) {
    if (text.endsWith(tag.slice(0, size))) return size;
  }
  return 0;
}

// One per reply. Thinking opens a reply or is no thinking: a tag an answer
// shows further on is the answer's own text, and so is all that follows the
// first closing tag. A reply said to begin inside its thinking has no opening.
export function untagged(open = false) {
  let where: 'before' | 'inside' | 'after' = open ? 'inside' : 'before';
  let held = '';

  function piece(text: string): Extract<Chunk, { type: 'text' | 'reasoning' }> {
    return { type: where === 'inside' ? 'reasoning' : 'text', text };
  }

  // A tag may be cut across two chunks at any character, so only an ending
  // that may still become one is held back for the next.
  function read(added: string) {
    const out: ReturnType<typeof piece>[] = [];
    let rest = held + added;
    held = '';
    if (where === 'before') {
      const blank = rest.length - rest.trimStart().length;
      if (blank > 0) out.push(piece(rest.slice(0, blank)));
      rest = rest.slice(blank);
      if (rest.length < opening.length && opening.startsWith(rest)) {
        held = rest;
        return out;
      }
      where = rest.startsWith(opening) ? 'inside' : 'after';
      if (where === 'inside') rest = rest.slice(opening.length);
    }
    if (where === 'inside') {
      const at = rest.indexOf(closing);
      const keep = at === -1 ? begun(rest, closing) : 0;
      const said = rest.slice(0, at === -1 ? rest.length - keep : at);
      if (said !== '') out.push(piece(said));
      held = rest.slice(rest.length - keep);
      if (at === -1) return out;
      where = 'after';
      rest = rest.slice(at + closing.length);
    }
    if (rest !== '') out.push(piece(rest));
    return out;
  }

  // What was held when the reply ended, or when something other than text
  // came, never became a tag.
  function ended() {
    const out = held === '' ? [] : [piece(held)];
    if (where === 'before' && held !== '') where = 'after';
    held = '';
    return out;
  }

  return { read, ended };
}
