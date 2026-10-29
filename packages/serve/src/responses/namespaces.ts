import type { Json, Tool } from '@mottyjs/core/host';
import { type Dict, dict, list, without } from '../wire/json.ts';
import { family, mine } from './family.ts';
import { clientRun } from './fields.ts';

// Where the tool came from, for the caller who declared it in a namespace.
export type Spaced = ReadonlyMap<string, { namespace: string; name: string }>;

// Anthropic Messages and Chat Completions take a tool's name in these
// characters, and Chat Completions in no more than 64 of them.
const portable = /^[a-zA-Z0-9_-]{1,64}$/;

// What a tool in a namespace is named elsewhere, unless another tool has the
// name or no family takes it.
export function flat(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

// A name made apart is the same for the same tool on every turn, so a call
// echoed in history is named as its tool is.
function apart(namespace: string, name: string, taken: Set<string>): string {
  let hash = 0x811c9dc5;
  for (const char of `${namespace}\0${name}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  const stem = flat(namespace, name)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 54);
  for (let more = 0; ; more++) {
    const named = `${stem}_${hash.toString(36)}${more || ''}`;
    if (!taken.has(named)) return named;
  }
}

// Tools a search the caller ran has found are loaded from then on. The API
// that ran it holds them itself, so they are marked as found, and what says
// they wait to be loaded is said of none of them.
export function foundIn(input: Json | undefined): Json[] {
  return list(input).flatMap((item) => {
    const { type, tools } = dict(item);
    const output = typeof type === 'string' && type.endsWith('_output');
    return output && clientRun(dict(item)) !== undefined
      ? list(tools).map((tool) => {
          const { tools: inside, ...rest } = without(dict(tool), [
            'defer_loading',
          ]);
          return inside === undefined
            ? rest
            : {
                ...rest,
                tools: list(inside).map((member) =>
                  without(dict(member), ['defer_loading']),
                ),
              };
        })
      : [];
  });
}

// A tool in a namespace is a tool of its own to every other family, under
// a name that says both and that no other tool of the request has.
export function spacesOf(
  listed: readonly Json[],
  found: readonly Json[],
  toolOf: (raw: Json, at: string) => Tool,
) {
  const taken = new Set<string>();
  for (const raw of listed) {
    const { type, name } = dict(raw);
    if (type !== 'namespace' && typeof name === 'string') taken.add(name);
  }
  const spaced = new Map<string, { namespace: string; name: string }>();
  const flats = new Map<string, string>();
  const read = (raw: Json, index: number, more: Dict): Tool[] => {
    const at = `tools[${index}]`;
    const { type, name: namespace, tools: inside } = dict(raw);
    if (type !== 'namespace' || typeof namespace !== 'string') {
      const tool = toolOf(raw, at);
      if (Object.keys(more).length === 0) return [tool];
      if (tool.type === 'provider' || taken.has(tool.name)) return [];
      taken.add(tool.name);
      return [
        { ...tool, hints: { [family]: { ...mine(tool.hints), ...more } } },
      ];
    }
    if (!Array.isArray(inside)) return [toolOf(raw, at)];
    const members = inside.map((member, place) =>
      toolOf(member, `${at}.tools[${place}]`),
    );
    if (members.some((member) => member.type === 'provider')) {
      return [toolOf(raw, at)];
    }
    const container = without(dict(raw), ['tools']);
    return members.flatMap((member) => {
      if (member.type === 'provider') return [];
      if (flats.has(`${namespace}\0${member.name}`)) return [];
      const plain = flat(namespace, member.name);
      const named =
        portable.test(plain) && !taken.has(plain)
          ? plain
          : apart(namespace, member.name, taken);
      taken.add(named);
      spaced.set(named, { namespace, name: member.name });
      flats.set(`${namespace}\0${member.name}`, named);
      const hints: Dict = { namespace: container, name: member.name, ...more };
      return [{ ...member, name: named, hints: { [family]: hints } }];
    });
  };
  const tools = [
    ...listed.flatMap((raw, index) => read(raw, index, {})),
    ...found.flatMap((raw, index) => read(raw, index, { found: true })),
  ];
  // A call to a tool no longer declared is named the plain way.
  const named = (namespace: string, name: string) =>
    flats.get(`${namespace}\0${name}`) ?? flat(namespace, name);
  return { tools, spaced, named };
}
