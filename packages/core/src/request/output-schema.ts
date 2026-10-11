import { Unsupported } from '../data/errors.ts';
import type {
  Json,
  JsonOutput,
  JsonSchema,
  Prompt,
  StandardSchema,
} from '../data/message.ts';
import { isStandard } from './structured-output.ts';

// Each object is proven once, so one shared by many branches costs one walk;
// it is marked false while walked, so one that holds itself is refused.
function isJson(value: unknown, proven: Map<object, boolean>): value is Json {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (value === null) return true;
      const known = proven.get(value);
      if (known !== undefined) return known;
      proven.set(value, false);
      // By index, so a hole is read as the undefined it holds.
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (!isJson(value[index], proven)) return false;
        }
      } else {
        const kind = Object.getPrototypeOf(value);
        if (kind !== Object.prototype && kind !== null) return false;
        for (const held of Object.values(value)) {
          if (!isJson(held, proven)) return false;
        }
      }
      proven.set(value, true);
      return true;
    }
    default:
      return false;
  }
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isJson(value, new Map<object, boolean>())
  );
}

function described(schema: StandardSchema): JsonSchema {
  // Proving a very deep value overflows the stack, caught here too.
  try {
    const provided: unknown = schema['~standard'].jsonSchema?.output({
      target: 'draft-2020-12',
    });
    if (isJsonSchema(provided)) return provided;
  } catch (cause) {
    throw new Unsupported('The output schema has no JSON Schema form', {
      cause,
    });
  }
  throw new Unsupported('The output schema provides no JSON Schema to send');
}

function holdsStandard(schema: unknown): boolean {
  return (
    ((typeof schema === 'object' && schema !== null) ||
      typeof schema === 'function') &&
    '~standard' in schema
  );
}

function isWire(prompt: Prompt): prompt is Prompt<JsonOutput> {
  const output: unknown = prompt.output;
  return (
    output === undefined ||
    (typeof output === 'object' &&
      output !== null &&
      !Array.isArray(output) &&
      !('~standard' in output) &&
      !('schema' in output && holdsStandard(output.schema)))
  );
}

function standard(output: unknown): StandardSchema {
  try {
    if (isStandard(output)) return output;
  } catch (cause) {
    throw new Unsupported('The output schema could not be read', { cause });
  }
  throw new Unsupported(
    'The output is neither a Standard Schema with a validate function nor a JSON output',
  );
}

export function wired(prompt: Prompt): Prompt<JsonOutput> {
  // Thrown plain: a prompt that is no object is a mistake in the author's code.
  if (typeof prompt !== 'object' || prompt === null) {
    throw new Error('A prompt must be an object');
  }
  if (isWire(prompt)) return prompt;
  const { output, ...rest } = prompt;
  if (
    typeof output === 'object' &&
    output !== null &&
    !('~standard' in output) &&
    'schema' in output
  ) {
    const { schema, ...stated } = output;
    return {
      ...rest,
      output: { ...stated, schema: described(standard(schema)) },
    };
  }
  return { ...rest, output: { schema: described(standard(output)) } };
}
