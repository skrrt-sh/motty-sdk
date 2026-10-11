import type { JsonSchema, Prompt } from '@mottyjs/core/host';

// No parameters given means a function that takes none. Each tool gets a
// schema of its own, so a change to one request's is not the next one's.
export function parameterless(): JsonSchema {
  return { type: 'object', properties: {} };
}

export function customNames(
  tools: NonNullable<Prompt['tools']> | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type === 'custom') names.add(tool.name);
  }
  return names;
}
