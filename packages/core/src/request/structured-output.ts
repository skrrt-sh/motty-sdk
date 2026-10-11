import { InvalidOutput } from '../data/errors.ts';
import type { OutputSchema, StandardSchema } from '../data/message.ts';

// Some validator libraries make their schemas callable.
function keyed(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

export function isStandard(schema: unknown): schema is StandardSchema {
  if (!keyed(schema) || !('~standard' in schema)) return false;
  const standard = schema['~standard'];
  return (
    keyed(standard) &&
    'validate' in standard &&
    typeof standard.validate === 'function'
  );
}

function isIssue(issue: unknown): issue is { message: string } {
  return (
    typeof issue === 'object' &&
    issue !== null &&
    'message' in issue &&
    typeof issue.message === 'string'
  );
}

async function validated(
  schema: StandardSchema,
  value: unknown,
): Promise<unknown> {
  const result: unknown = await schema['~standard'].validate(value);
  if (typeof result === 'object' && result !== null) {
    const issues = 'issues' in result ? result.issues : undefined;
    // The spec's rule: a falsy `issues` is a success, so an empty list is not.
    if (!issues) {
      if ('value' in result) return result.value;
    } else if (Array.isArray(issues) && issues.every(isIssue)) {
      const said = issues.map((issue) => issue.message).join('; ');
      throw new InvalidOutput(
        `The answer does not match the schema${said && `: ${said}`}`,
        { cause: issues },
      );
    }
  }
  throw new InvalidOutput('The output schema returned no usable result');
}

export function structured(
  source: string,
  output: OutputSchema | undefined,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new InvalidOutput('The answer is not JSON', { cause });
  }
  if (isStandard(output)) return validated(output, value);
  return output !== undefined && isStandard(output.schema)
    ? validated(output.schema, value)
    : value;
}
