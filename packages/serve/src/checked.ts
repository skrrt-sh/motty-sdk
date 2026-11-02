import type { StandardSchema } from '@mottyjs/core';
import { type Contract, toFacts } from '@mottyjs/core/host';
import { plain } from './stderr.ts';

type Part = NonNullable<Contract['root']>;

type Schemas = { readonly [group: string]: StandardSchema };

type Issues = NonNullable<
  Exclude<
    ReturnType<StandardSchema['~standard']['validate']>,
    Promise<unknown>
  >['issues']
>;

function isSchemas(held: unknown): held is Schemas {
  return (
    typeof held === 'object' &&
    held !== null &&
    Object.values(held).every(
      (schema: unknown) =>
        (typeof schema === 'object' || typeof schema === 'function') &&
        schema !== null &&
        '~standard' in schema,
    )
  );
}

// A served motty has one settings part at most, as the core refuses a second,
// and it may stand under any part or any entry of a route.
function schemasIn(part: Part): Schemas | undefined {
  for (const step of part.steps) {
    if (step.kind === 'derive') {
      if ('groups' in step.run && isSchemas(step.run.groups)) {
        return step.run.groups;
      }
    } else if (step.kind === 'use' || step.kind === 'route') {
      const inner =
        step.kind === 'use'
          ? [step.part]
          : Object.values(step.table).flatMap((entry) =>
              'part' in entry ? [entry.part] : [],
            );
      for (const nested of inner) {
        const found = schemasIn(nested);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function problems(issues: Issues): string {
  return issues
    .map(({ message, path }) => {
      const at = path?.map((step) =>
        String(typeof step === 'object' ? step.key : step),
      );
      return at?.length ? `${at.join('.')}: ${message}` : message;
    })
    .join('; ');
}

// Told by group and the schema's own words, which may quote the value. A schema
// that takes its time cannot stop a mount, which returns at once: its verdict
// is said when it comes, and each request still runs the schema.
function settled(
  overrides: object,
  schemas: Schemas | undefined,
  name: string,
  say: (line: string) => void,
) {
  const entries: [string, unknown][] = Object.entries(overrides);
  for (const [group, value] of entries) {
    const schema =
      schemas !== undefined && Object.hasOwn(schemas, group)
        ? schemas[group]
        : undefined;
    if (schema === undefined) {
      throw new Error(`The motty "${name}" has no settings group "${group}"`);
    }
    const refusal = (said: string) =>
      `The host's settings for the group "${group}" are not valid: ${plain(said)}`;
    let result: ReturnType<StandardSchema['~standard']['validate']>;
    try {
      result = schema['~standard'].validate(value);
    } catch (thrown) {
      throw new Error(refusal(toFacts(thrown).message));
    }
    if ('then' in result) {
      Promise.resolve(result).then(
        ({ issues }) => {
          if (issues) say(`motty: ${refusal(problems(issues))}`);
        },
        (thrown: unknown) => {
          say(`motty: ${refusal(toFacts(thrown).message)}`);
        },
      );
    } else if (result.issues) {
      throw new Error(refusal(problems(result.issues)));
    }
  }
}

// What every request would fail on is refused as the host is made. What a host
// may mean, as an optional caller, is only said. A contract with no chain tells
// nothing of its answer or its settings.
export function checked(
  { description, root }: Contract,
  { auth, settings }: { auth?: unknown; settings?: object },
  say: (line: string) => void,
): void {
  const { name, plugins } = description;
  if (root !== undefined) {
    if (!root.answers) {
      throw new Error(`The motty "${name}" has no route or handle`);
    }
    if (settings !== undefined) settled(settings, schemasIn(root), name, say);
  }
  const guarded = plugins.includes('auth');
  if (auth !== undefined && !guarded) {
    say(
      `motty: the host gave an auth adapter, and the motty "${name}" does not use auth(): requests run without a valid token unless the motty uses auth()`,
    );
  }
  if (auth === undefined && guarded) {
    say(
      `motty: the motty "${name}" uses auth(), and the host gave no auth adapter: every caller gets a 401. A host that states the caller by the third fetch argument may ignore this`,
    );
  }
}
