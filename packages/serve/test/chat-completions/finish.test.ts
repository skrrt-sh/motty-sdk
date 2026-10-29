import { expect, test } from 'bun:test';
import {
  reasonFailed,
  reasonRead,
  reasonWritten,
  replyFields,
} from '../../src/chat-completions/finish.ts';

test('a provider`s own name for filtered content is the content-filter ending', () => {
  expect(reasonRead('sensitive')).toBe('content_filter');
});

test('a context window that ran out is an ending by length', () => {
  expect(reasonRead('model_context_window_exceeded')).toBe('length');
});

test('a provider that ran out of capacity failed, and did not end the reply', () => {
  expect(reasonFailed('deepseek', 'insufficient_system_resource')).toEqual({
    code: 'overloaded',
    message: 'The upstream ran out of capacity before it finished',
    provider: { deepseek: { finish_reason: 'insufficient_system_resource' } },
    upstream: true,
  });
});

test('a provider that lost its connection failed, and may be asked again', () => {
  expect(reasonFailed('openai.chat', 'network_error')).toEqual({
    code: 'upstream_failed',
    message: 'The upstream lost its connection before it finished',
    retryable: true,
    provider: { 'openai.chat': { finish_reason: 'network_error' } },
    upstream: true,
  });
});

test('an ending is no failure, listed by the API or not', () => {
  expect(reasonFailed('openai.chat', 'eos')).toBeUndefined();
});

test('a dialect`s own word for an ending that failed is a failure worth another try, and the same word from another dialect is an ending read as other', () => {
  expect(reasonFailed('mistral', 'error', ['error'])).toEqual({
    code: 'upstream_failed',
    message: 'The upstream failed before it finished',
    retryable: true,
    provider: { mistral: { finish_reason: 'error' } },
    upstream: true,
  });
  expect(reasonFailed('openai.chat', 'error')).toBeUndefined();
  expect(reasonFailed('mistral', 'stop', ['error'])).toBeUndefined();
  expect(reasonRead('error')).toBe('other');
});

test('a dialect`s own word for an ending is read as the ending it names, and no other word is', () => {
  expect(reasonRead('model_length', { model_length: 'length' })).toBe('length');
  expect(reasonRead('eos', { eos: 'stop' })).toBe('stop');
  expect(reasonRead('eos', { model_length: 'length' })).toBe('other');
  expect(reasonRead('constructor', { eos: 'stop' })).toBe('other');
});

test('a reason the API lists is read as the API means it, whatever a dialect says', () => {
  expect(reasonRead('length', { length: 'stop' })).toBe('length');
});

test('a paused or unknown ending is written as a stop', () => {
  expect(reasonWritten('pause')).toBe('stop');
  expect(reasonWritten('other')).toBe('stop');
});

test('what another family said of its reply is not written', () => {
  expect(
    replyFields({
      type: 'finish',
      reason: 'stop',
      provider: { anthropic: { stop_sequence: null } },
    }),
  ).toEqual({});
  expect(replyFields({ type: 'finish', reason: 'stop' })).toEqual({});
});
