import { expect, test } from 'bun:test';
import * as host from '../src/host.ts';

test('the host entry exports exactly the held values', () => {
  expect(Object.keys(host).sort()).toEqual([
    'adapted',
    'bound',
    'buffered',
    'counted',
    'credentials',
    'disclosed',
    'forwarded',
    'fromFacts',
    'givenId',
    'hosted',
    'hosting',
    'isMarked',
    'isTerminal',
    'mark',
    'toFacts',
    'version',
  ]);
});

test('the host entry exports exactly the held types', async () => {
  const text = await Bun.file(
    new URL('../src/host.ts', import.meta.url),
  ).text();

  expect(
    [...text.matchAll(/export (type )?\{([^}]*)\}/g)]
      .flatMap(([, allTypes, names = '']) =>
        names
          .split(',')
          .map((name) => name.trim())
          .filter((name) => allTypes !== undefined || name.startsWith('type '))
          .map((name) => name.replace('type ', '')),
      )
      .filter((name) => name !== '')
      .sort(),
  ).toEqual([
    'AuthAdapter',
    'Cache',
    'Caller',
    'ChatRequest',
    'Chunk',
    'Closed',
    'Content',
    'Contract',
    'DecisionCall',
    'Description',
    'ErrorFacts',
    'EventStream',
    'Failed',
    'Finish',
    'FinishReason',
    'Host',
    'HostOptions',
    'Json',
    'JsonOutput',
    'JsonSchema',
    'KnownCode',
    'Limits',
    'Marked',
    'Media',
    'Message',
    'ModelAdapter',
    'ModelCall',
    'MottyError',
    'Options',
    'Overrides',
    'Part',
    'Progress',
    'Prompt',
    'ProviderData',
    'ReadonlyJson',
    'Report',
    'RequestRecord',
    'Role',
    'RunStream',
    'Storage',
    'StreamEvent',
    'Terminal',
    'Tool',
    'ToolChoice',
    'Usage',
  ]);
});
