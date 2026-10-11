import { expect, test } from 'bun:test';
import { inline } from '../../src/wire/data-url.ts';

test('inline bytes are split from their media type', () => {
  expect(inline('data:image/png;base64,iVBORw0KGgo=')).toEqual({
    mediaType: 'image/png',
    data: 'iVBORw0KGgo=',
  });
  expect(inline('data:application/pdf;base64,')).toEqual({
    mediaType: 'application/pdf',
    data: '',
  });
});

test('an address that holds no bytes is not split', () => {
  expect(inline('https://example.com/cat.png')).toBeUndefined();
  expect(inline('data:text/plain,hello')).toBeUndefined();
  expect(inline('iVBORw0KGgo=')).toBeUndefined();
});
