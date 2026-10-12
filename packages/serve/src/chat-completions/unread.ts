import { type Dict, dict, isDict, without } from '../wire/json.ts';

export const callFields = {
  outer: ['index', 'id', 'type', 'function', 'custom'],
  function: ['name', 'arguments', 'input'],
  custom: ['name', 'arguments', 'input'],
};

type Own = typeof callFields;
export type Kind = Exclude<keyof Own, 'outer'>;

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

// A fragment may be marked as the other kind than its call is, and what its
// object holds is the call's all the same.
function named(raw: Dict, kind: Kind): Dict {
  const { [kind]: own, [kind === 'custom' ? 'function' : 'custom']: other } =
    raw;
  return dict(isDict(own) ? own : other);
}

export function unreadOf(raw: Dict, kind: Kind, own: Own): Dict | undefined {
  const around = rest(raw, own.outer);
  const within = rest(named(raw, kind), own[kind]);
  return within === undefined ? around : { ...around, [kind]: within };
}

// Made from entries, a key named as the prototype is a key like any other.
export function mergedUnread(
  fragments: readonly Dict[],
  kind: Kind,
): Dict | undefined {
  if (fragments.length < 2) return fragments[0];
  const within = fragments.flatMap((fragment) =>
    Object.entries(named(fragment, kind)),
  );
  return Object.fromEntries([
    ...fragments.flatMap((fragment) => Object.entries(fragment)),
    [kind, Object.fromEntries(within)],
  ]);
}

// What is carried may come from anywhere, so nothing of it is written as the
// call's or the tool's own.
export function withUnread(
  carried: Dict | undefined,
  kind: Kind,
  own: Own,
  outer: Dict,
  inner: Dict,
): Dict {
  const unread =
    carried === undefined ? undefined : unreadOf(carried, kind, own);
  if (unread === undefined) return { ...outer, [kind]: inner };
  const { [kind]: within, ...around } = unread;
  return { ...around, ...outer, [kind]: { ...dict(within), ...inner } };
}

export function wireCall(
  kind: Kind,
  input: string,
  carried?: Dict,
  opened?: { id: string; name: string },
  index?: number,
): Dict {
  const outer = {
    ...(index === undefined ? {} : { index }),
    ...(opened === undefined ? {} : { id: opened.id, type: kind }),
  };
  const name = opened === undefined ? {} : { name: opened.name };
  const inner =
    kind === 'custom' ? { ...name, input } : { ...name, arguments: input };
  return withUnread(carried, kind, callFields, outer, inner);
}
