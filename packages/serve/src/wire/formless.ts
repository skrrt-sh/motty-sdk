import { Unsupported } from '@mottyjs/core';
import {
  type Chunk,
  type Progress,
  type RunStream,
  toFacts,
} from '@mottyjs/core/host';
import type { Codec, LeftOut } from '../codec.ts';

type Formless = Codec['formless'];

type Kind = Chunk['type'];

// One wording for every API, so a caller and a host read the same sentence
// whichever reply could not hold the content.
export function formlessIn(api: string) {
  const said =
    (ends: boolean) =>
    (setting: Kind, what: string): ReturnType<Formless> => ({
      warning: { setting, detail: `${api} has no form for ${what}` },
      ends,
    });
  return { answer: said(true), note: said(false) };
}

export function refusal({ setting, detail }: LeftOut): Unsupported {
  return new Unsupported(detail ?? setting);
}

// Reasoning the caller can be shown is not lost with the data beside it
// that its API has no form for.
export function shown(chunk: Chunk): Chunk | undefined {
  if (chunk.type !== 'reasoning' || chunk.text === '') return undefined;
  const { provider: _, ...kept } = chunk;
  return kept;
}

// A stream that has begun cannot take its status back, so content that is
// the answer and has no form ends it as one that failed.
export async function* formed(
  events: RunStream,
  formless: Formless,
): RunStream {
  for await (const event of events) {
    if (
      event.type === 'progress' ||
      event.type === 'finish' ||
      event.type === 'error'
    ) {
      yield event;
      continue;
    }
    const found = formless(event);
    if (found?.ends === true) {
      yield { type: 'error', error: toFacts(refusal(found.warning)) };
      return;
    }
    const kept = found === undefined ? event : shown(event);
    if (kept !== undefined) yield kept;
  }
}

// A reply that is collected has no status yet, so the same content fails it.
export function formedWhole(
  events: readonly (Chunk | Progress)[],
  formless: Formless,
): (Chunk | Progress)[] {
  return events.flatMap((event): (Chunk | Progress)[] => {
    if (event.type === 'progress') return [event];
    const found = formless(event);
    if (found?.ends === true) throw refusal(found.warning);
    const kept = found === undefined ? event : shown(event);
    return kept === undefined ? [] : [kept];
  });
}
