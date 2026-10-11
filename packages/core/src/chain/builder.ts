import type { Contract, mark } from '../contract.ts';
import type { ChatRequest, Draft } from '../data/message.ts';
import type { Answer } from '../request/answer.ts';
import type { Calls } from '../request/context.ts';

export const chain = Symbol('chain');

// Never set: it carries the paths in the type, so whether a motty answers is
// one property to compare and not the whole chain.
declare const paths: unique symbol;

type Awaitable<Value> = Value | Promise<Value>;

// The intersection drops this alias, so an error lists the properties.
type Flat<Type> = { [Key in keyof Type]: Type[Key] } & unknown;

export type Reroute<Name extends string = string> = { readonly reroute: Name };

export type Outcome = 'completed' | 'aborted' | 'failed';

export type Base = {
  readonly request: ChatRequest;
  readonly prompt: Draft;
  readonly signal: AbortSignal;
  readonly calls: Calls;
};

type Reserved = keyof Base | 'route' | 'path' | 'answer' | 'outcome';

type AfterAnswer = 'Only after hooks may follow the answer';
type AnswersTwice =
  'A motty answers once: this one already has a route or a handle';
type ReservedName =
  'A derived value cannot be named request, prompt, signal, calls, route, path, answer or outcome';
type TakenName =
  'A derived value cannot take the name of a value the chain already has';
type UnknownNames =
  'A derived value needs a known name: put a map of any names under one';
type NoEntries = 'A route needs at least one named entry';
type SymbolName = 'An entry is named by a string, never a symbol';
type NoAnswer = 'A motty used as an entry needs a route or a handle';
type StrayReroute = 'A reroute names another entry of its own table';
type Uncalled = 'A function that makes a part is called first: use(part())';
type Untyped =
  'A part is used with the types it was built with, not held as any motty';

// Of each member of a union by itself: the names all members share would
// leave out one that only some of them take.
type Names<Derived> = Derived extends unknown ? keyof Derived : never;

// A failure may come before a derive ran, or be that derive.
type Partway<Context> = Base & Partial<Omit<Context, keyof Base>>;

type With<Context, Added> = Flat<Omit<Context, keyof Added> & Added>;

type AfterHandle<Context, Paths extends string[]> = Flat<
  Context & {
    readonly route: Before<Paths, string | undefined, Paths[0]>;
    readonly path: Readonly<Paths>;
    answer: Answer;
  }
>;

type AfterResponse<Context, Paths extends string[]> =
  | Flat<
      Context & {
        readonly outcome: 'completed';
        readonly route: Before<Paths, string | undefined, Paths[0]>;
        readonly path: Readonly<Paths>;
        readonly answer: Answer;
      }
    >
  | Flat<
      Partway<Context> & {
        readonly outcome: Exclude<Outcome, 'completed'>;
        readonly route?: Paths[0];
        readonly path: readonly string[];
        readonly answer?: Answer;
      }
    >;

// Paths start as any list of names and become tuples once the motty answers.
type Before<Paths, Allowed, Refusal> = string[] extends Paths
  ? Allowed
  : Refusal;

type Answered = [] | [string, ...string[]];

type Early = Awaitable<Answer | undefined> | Awaitable<void>;

// What was given is inferred whole, so a function gets its sentence and a
// motty held without its types is not taken for one that adds nothing.
type Usable<Given> = Given extends (...given: never[]) => unknown
  ? Uncalled
  : Given extends AnyMotty
    ? 'use' extends keyof Given
      ? Given
      : Untyped
    : Motty;

type Brought<Given> =
  Given extends Motty<infer Added, infer AddedPaths>
    ? [Added, AddedPaths]
    : [unknown, string[]];

type Named<Key> = Key extends string | number ? `${Key}` : never;

type Handler<Context, Other extends string> = (
  context: Context,
) => Awaitable<Answer | Reroute<Other>>;

type TableEntry<Context, Other extends string> =
  | Handler<Context, Other>
  | AnsweringMotty
  | Caught<AnsweringMotty, Other, Context>;

// A table is checked once before it is inferred, when an entry reads as never:
// then any motty passes, so the sentence comes with the check that knows it.
type Slot<Given, Context, Other extends string> = [Given] extends [never]
  ? TableEntry<Context, Other> | AnyMotty | Caught<AnyMotty, string, Context>
  : // Given back as itself: met with the entry type again, a motty that passed
    // would have its paths compared with every answered path, tuple by tuple.
    [Given] extends [infer Passed extends TableEntry<Context, Other>]
    ? Passed
    : [Given] extends [TableEntry<Context, string>]
      ? StrayReroute
      : [Given] extends [AnyMotty | Caught<AnyMotty, string>]
        ? NoAnswer
        : // Met with the handler alone, so the error is about what it returns.
          [Given] extends [(...given: never[]) => unknown]
          ? Handler<Context, Other>
          : TableEntry<Context, Other>;

type Nested<Routed> = (
  Routed extends { readonly entry: infer Inner }
    ? Inner
    : Routed
) extends { readonly [paths]?: infer Paths extends string[] | undefined }
  ? Exclude<Paths, undefined>
  : [];

// A motty entry may answer before any entry of its own ran.
type PathsOf<Table> = {
  [Key in keyof Table]: Key extends symbol
    ? never
    : [Named<Key>] | [Named<Key>, ...Nested<Table[Key]>];
}[keyof Table];

// With no parent named its context is never, so any recover fits.
export type Caught<Inner, Name extends string, Outer = never> = {
  readonly entry: Inner;
  readonly recover: (
    thrown: unknown,
    context: Outer,
  ) => Awaitable<Answer | Reroute<Name> | undefined> | Awaitable<void>;
};

export type AnyMotty = {
  readonly [chain]: Chain;
  readonly [mark]: Contract;
};

export type AnsweringMotty = AnyMotty & {
  readonly [paths]?: Answered | undefined;
};

// With no context named it is any motty, finished or not: the builder's
// methods come only with the context they are typed by.
export type Motty<
  Context = unknown,
  Paths extends string[] = string[],
> = (unknown extends Context ? AnyMotty : Builder<Context, Paths>) & {
  readonly [paths]?: Paths | undefined;
};

export type Builder<Context, Paths extends string[]> = {
  readonly use: <Given>(
    part: Before<Paths, Usable<Given>, AfterAnswer>,
  ) => Motty<With<Context, Brought<Given>[0]>, Brought<Given>[1]>;
  readonly derive: <Derived extends { readonly [name: string]: unknown }>(
    fn: Before<
      Paths,
      Extract<Names<Derived>, Reserved> extends never
        ? string extends Names<Derived>
          ? // As what the function returns: its context is typed before its
            // result is known, and until then the result is any names at all.
            (context: Context) => UnknownNames
          : Extract<Names<Derived>, keyof Context> extends never
            ? (context: Context) => Awaitable<Derived>
            : TakenName
        : ReservedName,
      AfterAnswer
    >,
  ) => Motty<Flat<Context & Derived>, Paths>;
  readonly beforeHandle: (
    fn: Before<Paths, (context: Context) => Early, AfterAnswer>,
  ) => Motty<Context, Paths>;
  readonly route: <Name extends PropertyKey, Table>(
    chooser: Before<
      Paths,
      [Named<Name>] extends [never]
        ? NoEntries
        : (context: Context) => Awaitable<Named<NoInfer<Name>>>,
      AnswersTwice
    >,
    table: Before<
      Paths,
      Table & {
        readonly [Routed in Name]: Routed extends symbol
          ? SymbolName
          : Slot<
              Table[Routed & keyof Table],
              Context,
              Exclude<Named<NoInfer<Name>>, Named<Routed>>
            >;
      },
      AnswersTwice
    >,
  ) => Motty<Context, PathsOf<Table>>;
  readonly handle: (
    fn: Before<Paths, (context: Context) => Awaitable<Answer>, AnswersTwice>,
  ) => Motty<Context, []>;
  readonly afterHandle: (
    fn: (context: AfterHandle<Context, Paths>) => Awaitable<void>,
  ) => Motty<Context, Paths>;
  readonly afterResponse: (
    fn: (context: AfterResponse<Context, Paths>) => Awaitable<void>,
  ) => Motty<Context, Paths>;
  readonly onError: (
    fn: (thrown: unknown, context: Flat<Partway<Context>>) => Early,
  ) => Motty<Context, Paths>;
  readonly catch: <Name extends string = never, Outer = Base>(
    recover: Caught<never, Name, Outer>['recover'],
  ) => Caught<Motty<Context, Paths>, NoInfer<Name>, Outer>;
  readonly [chain]: Chain;
  readonly [mark]: Contract;
};

// The context whoever runs a step supplies, derived values under their names.
export type Supplied = Base & {
  route?: string;
  path: readonly string[];
  answer?: Answer;
  outcome?: Outcome;
  [derived: string]: unknown;
};

// The accumulated context is erased here. Declared as methods, whose parameter
// is compared both ways, so a hook typed by its chain fits and can be called.
type Erased = {
  hook(context: Supplied): unknown;
  boundary(thrown: unknown, context: Supplied): unknown;
};

type ErasedHook = Erased['hook'];

export type Target =
  | { readonly handler: ErasedHook }
  | { readonly part: Chain; readonly recover?: Erased['boundary'] };

export type Step =
  | { readonly kind: 'use'; readonly part: Chain }
  | {
      readonly kind:
        | 'derive'
        | 'beforeHandle'
        | 'handle'
        | 'afterHandle'
        | 'afterResponse';
      readonly run: ErasedHook;
    }
  | {
      readonly kind: 'onError';
      readonly run: Erased['boundary'];
    }
  | {
      readonly kind: 'route';
      readonly choose: ErasedHook;
      readonly table: { readonly [name: string]: Target };
    };

export type Chain = {
  readonly name: string;
  readonly identity: string;
  readonly origin: symbol;
  readonly parts: ReadonlyMap<string, Chain>;
  readonly steps: readonly Step[];
  readonly answers: boolean;
};
