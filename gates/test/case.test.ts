import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { Options } from '@mottyjs/core/host';
import { $, Glob } from 'bun';
import {
  isBindingElement,
  isClassDeclaration,
  isEnumDeclaration,
  isEnumMember,
  isExportSpecifier,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNamedTupleMember,
  isParameterDeclaration,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeParameterDeclaration,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/async';
import * as tables from '../../packages/adapters/src/fields.ts';
import { named } from '../../packages/serve/src/chat-completions/fields.ts';

const root = join(import.meta.dir, '../..');

// What may stay in snake_case, each by package, since the SDK does not own it.
// Nothing else may.
const allowed: { [name: string]: string } = {
  'decision input_tokens': 'the usage a decision API writes, read as it comes',
  'decision output_tokens': 'the usage a decision API writes, read as it comes',
  'decision answer_confidence': 'a field of the answer Laya writes',
  'decision act_probability': 'a field of the answer Laya writes',
  'decision low_confidence': 'a field of the answer Laya writes',
  'decision abstention_threshold': 'a field of the answer Laya writes',
  'decision x_jev_confidence': 'a field of the answer Laya writes',
};

// The string values that may stay in snake_case, each by package. Each is a word
// of a wire itself, chosen as that word or spoken to it, and never one an author
// reads back from the SDK. Any other value is the SDK's and is in camelCase.
const allowedValues: { [value: string]: string } = {
  'adapters chat_template_kwargs':
    'the field a local server takes its thinking switch in, chosen by its host',
  'serve cache_control': 'the field a router takes a cache marker in',
  'serve chat_template_kwargs':
    'the field a dialect sends a thinking switch in',
  'serve enable_thinking': 'the field a dialect sends a thinking flag in',
  'serve frequency_penalty': "OpenAI's field for the option `frequencyPenalty`",
  'serve json_object':
    'the `response_format` a dialect takes in place of a schema',
  'serve max_completion_tokens': "OpenAI's field for the option `maxTokens`",
  'serve presence_penalty': "OpenAI's field for the option `presencePenalty`",
  'serve prompt_cache_key': "OpenAI's field for the option `cacheKey`",
  'serve prompt_cache_options':
    'the field a dialect takes a cache lifetime in, and the option `cacheOptions`',
  'serve prompt_cache_retention':
    "OpenAI's field for the option `cacheRetention`",
  'serve reasoning_content': 'the field a dialect takes reasoning back in',
  'serve safety_identifier': "OpenAI's field for the option `safetyIdentifier`",
  'serve service_tier': "OpenAI's field for the option `serviceTier`",
};

// Anything with an underscore inside it. What the compiler itself writes for a
// class that extends a call, as `RateLimited_base`, no author ever reads.
const snake = (name: string) =>
  /[A-Za-z0-9]_[A-Za-z0-9]/.test(name) && !/^[A-Z]\w*_base$/.test(name);

// A name a declaration gives: a property, a parameter, a type and so on. What a
// string literal type says is a value and not a name, read by `literalOf`.
function nameOf(node: Node): string | undefined {
  const declares =
    isPropertySignatureDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isMethodDeclaration(node) ||
    isParameterDeclaration(node) ||
    isBindingElement(node) ||
    isNamedTupleMember(node) ||
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isClassDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isVariableDeclaration(node) ||
    isEnumDeclaration(node) ||
    isEnumMember(node) ||
    isTypeParameterDeclaration(node) ||
    isExportSpecifier(node);
  if (!declares) return undefined;
  const { name } = node;
  return name !== undefined && (isIdentifier(name) || isStringLiteral(name))
    ? name.text
    : undefined;
}

// A value an author writes or reads: what a literal type or a constant says.
function literalOf(node: Node): string | undefined {
  const said = isLiteralTypeNode(node)
    ? node.literal
    : isVariableDeclaration(node)
      ? node.initializer
      : undefined;
  return said !== undefined && isStringLiteral(said) ? said.text : undefined;
}

function each(node: Node, visit: (node: Node) => void): void {
  visit(node);
  node.forEachChild((child) => each(child, visit));
}

function saidIn(file: SourceFile, read: (node: Node) => string | undefined) {
  const said: string[] = [];
  each(file, (node) => {
    const word = read(node);
    if (word !== undefined) said.push(word);
  });
  return said;
}

// The fields of the `Options` type as the declarations state them.
function optionsIn(file: SourceFile): string[] {
  const names: string[] = [];
  each(file, (node) => {
    if (!isTypeAliasDeclaration(node) || node.name.text !== 'Options') return;
    if (!isTypeLiteralNode(node.type)) return;
    for (const member of node.type.members) {
      const name = nameOf(member);
      if (name !== undefined) names.push(name);
    }
  });
  return names;
}

// Each package's public entries, as `exports` states them, built into `folder`,
// and the import of each by the name a package imports another by.
async function entries(folder: string) {
  const paths: { [name: string]: string[] } = {};
  const files: string[] = [];
  for await (const manifest of new Glob('packages/*/package.json').scan(root)) {
    const { name, exports: listed } = await Bun.file(
      join(root, manifest),
    ).json();
    const [, folderName = ''] = manifest.split('/');
    for (const [subpath, conditions] of Object.entries<{
      '@mottyjs/source': string;
    }>(listed)) {
      const source = conditions['@mottyjs/source'].replace(/\.ts$/, '.d.ts');
      const file = `./${join(folderName, source)}`;
      paths[join(name, subpath)] = [file];
      files.push(file);
    }
  }
  await Bun.write(
    join(folder, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noLib: true,
        types: [],
        target: 'esnext',
        module: 'preserve',
        allowImportingTsExtensions: true,
        paths,
      },
      files,
    }),
  );
  return files;
}

// Every declaration a public entry reaches, through what its files import, is
// walked over the built declarations, as an author's editor reads them. A file
// the compiler never meets from an entry is nobody's public surface.
async function surface() {
  const folder = await mkdtemp(join(tmpdir(), 'motty-case-'));
  const started = performance.now();
  try {
    for (const config of ['tsconfig.build.json', 'tsconfig.workers.json']) {
      await $`bun tsc -p ${config} --emitDeclarationOnly --outDir ${folder}`
        .cwd(root)
        .nothrow()
        .quiet();
    }
    const listed = await entries(folder);
    await using api = {
      opened: new API({ cwd: folder }),
      [Symbol.asyncDispose]() {
        return this.opened.close();
      },
    };
    const snapshot = await api.opened.updateSnapshot({
      openProject: join(folder, 'tsconfig.json'),
    });
    const [project] = snapshot.getProjects();
    if (project === undefined) throw new Error('The compiler opened nothing');
    const found: { name: string; file: string; where: string }[] = [];
    const values: { value: string; file: string; where: string }[] = [];
    let options: string[] = [];
    const reached = await project.program.getSourceFileNames();
    for (const fileName of reached) {
      const file = relative(folder, fileName);
      if (file.startsWith('..')) continue;
      const source = await project.program.getSourceFile(fileName);
      if (source === undefined) continue;
      const [where = ''] = file.split(sep);
      for (const name of saidIn(source, nameOf)) {
        found.push({ name, file, where });
      }
      for (const value of saidIn(source, literalOf)) {
        values.push({ value, file, where });
      }
      if (file === join('core', 'src', 'data', 'message.d.ts')) {
        options = optionsIn(source);
      }
    }
    return {
      found,
      values,
      options,
      listed,
      reached: reached.map((name) => relative(folder, name)),
      took: performance.now() - started,
    };
  } finally {
    await rm(folder, { recursive: true });
  }
}

// Measured once for every test here, the first of which waits for it.
const measured = surface();

afterAll(async () => {
  const { took } = await measured;
  console.log(
    `the declarations were built and walked in ${Math.round(took)} ms`,
  );
});

test('every public entry of every package is walked', async () => {
  const { listed, reached } = await measured;

  expect(listed.length).toBeGreaterThan(30);
  for (const file of listed) {
    expect(reached).toContain(file.slice(2));
  }
  // What an entry only reaches through an import, across packages too.
  expect(reached).toContain(
    join('serve', 'src', 'chat-completions', 'dialect.d.ts'),
  );
  expect(reached).toContain(join('core', 'src', 'data', 'message.d.ts'));
});

test('no snake_case name is reachable from a package`s public declarations unless it is allowed', async () => {
  const { found } = await measured;

  const stray = found
    .filter(
      ({ name, where }) => snake(name) && !(`${where} ${name}` in allowed),
    )
    .map(({ name, file }) => `${name} in ${file}`);

  expect([...new Set(stray)]).toEqual([]);
});

test('every name allowed is still there to allow, so the list does not outlive its cause', async () => {
  const { found } = await measured;
  const reachable = new Set(found.map(({ name, where }) => `${where} ${name}`));

  expect(Object.keys(allowed).filter((name) => !reachable.has(name))).toEqual(
    [],
  );
});

test('no snake_case string value is reachable from a package`s public declarations unless it is allowed', async () => {
  const { values } = await measured;

  const stray = values
    .filter(
      ({ value, where }) =>
        snake(value) && !(`${where} ${value}` in allowedValues),
    )
    .map(({ value, file }) => `${value} in ${file}`);

  expect([...new Set(stray)]).toEqual([]);
});

test('every value allowed is still there to allow, so the list does not outlive its cause', async () => {
  const { values } = await measured;
  const reachable = new Set(
    values.map(({ value, where }) => `${where} ${value}`),
  );

  expect(
    Object.keys(allowedValues).filter((value) => !reachable.has(value)),
  ).toEqual([]);
});

test('the values that make the SDK`s own vocabulary are read at all', async () => {
  const { values } = await measured;
  const read = values.map(({ value }) => value);

  // A union, a list given `as const`, and a wire word: a walk that read none of
  // them would find nothing wrong anywhere.
  expect(read).toContain('toolCall');
  expect(read).toContain('contentFilter');
  expect(read).toContain('json_object');
});

test('every key of a provider`s table and of the option map is in camelCase', () => {
  const stated = [
    ...Object.keys(named),
    ...Object.values(tables).flatMap((table) => Object.keys(table)),
  ];

  expect(stated.filter((key) => !/^[a-z][a-zA-Z0-9]*$/.test(key))).toEqual([]);
});

test('every table says what an option goes out as, under a name the map holds', () => {
  const names = [...Object.keys(named), 'streamOptions'];

  const strays = Object.values(tables)
    .flatMap((table) => Object.keys(table))
    .filter((key) => !names.includes(key));

  expect(strays).toEqual([]);
});

test('every option the map names is a field of `Options`', async () => {
  // Read by the compiler, which refuses a map that says otherwise as well.
  type Stray = Exclude<keyof typeof named, keyof Options>;
  const none: [Stray] extends [never] ? true : false = true;
  const { options } = await measured;

  expect(none).toBe(true);
  expect(Object.keys(named).filter((key) => !options.includes(key))).toEqual(
    [],
  );
});
