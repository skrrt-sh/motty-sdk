import { type Dict, dict, isDict, without } from '../wire/json.ts';

// What this codec reads and writes of a call or a tool itself: around the
// object that names it, and inside that object. All else is carried.
export const callFields = {
  outer: ['index', 'id', 'type', 'function', 'custom'],
  function: ['name', 'arguments', 'input'],
  custom: ['name', 'arguments', 'input'],
};

type Own = typeof callFields;
type Kind = Exclude<keyof Own, 'outer'>;

export const toolFields: Own = {
  outer: ['type', 'function', 'custom'],
  function: ['name', 'description', 'parameters', 'strict'],
  custom: ['name', 'description', 'format'],
};

// Nearly every fragment of a stream holds nothing else, so nothing is made
// until a field is found that is.
function rest(fields: Dict, own: readonly string[]): Dict | undefined {
  for (const name in fields) {
    if (!own.includes(name)) return without(fields, own);
  }
  return undefined;
}

// A field around the object that names a call or a tool is carried at the
// top, and one inside that object under its key.
export function parted(raw: Dict, kind: Kind, own: Own): Dict | undefined {
  const unread = rest(raw, own.outer);
  const named = raw[kind];
  const within = isDict(named) ? rest(named, own[kind]) : undefined;
  return within === undefined ? unread : { ...unread, [kind]: within };
}

// What a later fragment carried adds to an earlier one's, at the top and
// inside the object alike.
export function merged(earlier: Dict | undefined, later: Dict, kind: Kind) {
  if (earlier === undefined) return later;
  const within = { ...dict(earlier[kind]), ...dict(later[kind]) };
  return { ...earlier, ...later, [kind]: within };
}

// Each carried field goes back where it sat. What is carried may come from
// anywhere, so it is parted again: nothing of it is written as the call's own.
export function rebuilt(
  carried: Dict | undefined,
  kind: Kind,
  own: Own,
  outer: Dict,
  inner: Dict,
): Dict {
  const more = carried === undefined ? undefined : parted(carried, kind, own);
  if (more === undefined) return { ...outer, [kind]: inner };
  const { [kind]: within, ...unread } = more;
  return { ...unread, ...outer, [kind]: { ...dict(within), ...inner } };
}
