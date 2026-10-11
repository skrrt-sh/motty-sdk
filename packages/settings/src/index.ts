import {
  type Closed,
  type Motty,
  motty,
  type StandardSchema,
} from '@mottyjs/core';
import { hosted } from '@mottyjs/core/host';

type Groups = { readonly [group: string]: StandardSchema };

type Values<Given extends Groups> = {
  [Group in keyof Given]: Given[Group] extends StandardSchema<
    unknown,
    infer Output
  >
    ? Output
    : never;
};

export type Settings<Part> =
  Part extends Motty<infer Context>
    ? Context extends { readonly settings: infer Held }
      ? Held
      : never
    : never;

type Issues = Extract<
  Awaited<ReturnType<StandardSchema['~standard']['validate']>>,
  { issues: object }
>['issues'];

function said(issues: Issues): string {
  return issues.map((issue) => issue.message).join('; ');
}

// Each value came out of its own group's schema, which no type follows
// through a loop: this checks that no group is missing and names the whole.
function assertWhole<Given extends Groups>(
  groups: Given,
  held: { readonly [group: string]: unknown },
): asserts held is Closed<Values<Given>> {
  for (const group of Object.keys(groups)) {
    if (!Object.hasOwn(held, group)) {
      throw new Error(`The settings group "${group}" has no value`);
    }
  }
}

// One value is read by every request that follows, so a write to it throws
// in the motty that makes it. Only plain data is walked: nothing else can be
// closed by freezing it.
function frozen(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  const kind: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) || kind === Object.prototype || kind === null) {
    Object.freeze(value);
    for (const held of Object.values(value)) frozen(held);
  }
  return value;
}

// Loading awaits nothing, so a group is checked only by a schema that
// validates at once. No prototype: a group of any name is a key of its own.
function defaultsOf(groups: Groups): { [group: string]: unknown } {
  const defaults: { [group: string]: unknown } = { __proto__: null };
  for (const [group, schema] of Object.entries(groups)) {
    const result = schema['~standard'].validate({});
    if ('then' in result) {
      throw new Error(
        `The settings group "${group}" validates asynchronously, so it cannot be checked at load`,
      );
    }
    if (result.issues) {
      throw new Error(
        `The settings group "${group}" must accept {}, so that every setting has a default: ${said(result.issues)}`,
      );
    }
    defaults[group] = frozen(result.value);
  }
  return Object.freeze(defaults);
}

async function overridden(
  groups: Groups,
  defaults: { readonly [group: string]: unknown },
  overrides: NonNullable<ReturnType<typeof hosted>['settings']>,
): Promise<{ [group: string]: unknown }> {
  const held: { [group: string]: unknown } = { __proto__: null, ...defaults };
  for (const [group, schema] of Object.entries(groups)) {
    if (!Object.hasOwn(overrides, group)) continue;
    const result = await schema['~standard'].validate(overrides[group]);
    if (result.issues) {
      throw new Error(
        `The host's settings for the group "${group}" are not valid: ${said(result.issues)}`,
      );
    }
    held[group] = frozen(result.value);
  }
  return Object.freeze(held);
}

// Every settings part grows from this one motty, so the core tells two
// definitions apart and refuses the second where it is used.
const base = motty({ name: 'settings' });

export function settings<Given extends Groups>(groups: Given) {
  const defaults = defaultsOf(groups);
  return base.derive(async () => {
    const overrides = hosted().settings;
    const held =
      overrides === undefined
        ? defaults
        : await overridden(groups, defaults, overrides);
    assertWhole(groups, held);
    const settings: Closed<Values<Given>> = held;
    return { settings };
  });
}
