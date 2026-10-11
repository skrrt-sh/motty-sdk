import type { Part } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, given } from '../wire/json.ts';
import { filename } from '../wire/openai-file.ts';
import { unsupported } from '../wire/refusals.ts';
import type { Dialect } from './dialect.ts';
import { hinted } from './family.ts';

// This wire takes inline bytes of a named type as a data address.
function address(media: {
  url?: string;
  data?: string;
  mediaType?: string;
}): string | undefined {
  const { url, data, mediaType } = media;
  if (url !== undefined) return url;
  return data === undefined || mediaType === undefined
    ? undefined
    : `data:${mediaType};base64,${data}`;
}

export function image(
  left: Leaving,
  dialect: Dialect,
  part: Extract<Part, { type: 'image' }>,
): Dict {
  if (part.id !== undefined) {
    if (dialect.files === 'pictures') {
      return { ...hinted(part.hints), type: 'file', file_id: part.id };
    }
    unsupported('Chat Completions cannot carry an image given by id');
  }
  const url = address(part);
  if (url === undefined) left.without('image.untyped', part);
  return {
    type: 'image_url',
    image_url: { url: url ?? '', ...hinted(part.hints) },
  };
}

const formats: { [mediaType: string]: string } = {
  'audio/wav': 'wav',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
};

export function audio(
  dialect: Dialect,
  part: Extract<Part, { type: 'audio' }>,
): Dict {
  const { data, mediaType = '' } = part;
  if (dialect.sound === 'none') {
    unsupported(`Chat Completions cannot carry audio to ${dialect.name}`);
  }
  const every = dialect.sound === 'any';
  const [, named] = /^audio\/(.+)$/.exec(mediaType) ?? [];
  const format = formats[mediaType] ?? (every ? named : undefined);
  if (data === undefined || format === undefined) {
    unsupported(
      `Chat Completions cannot carry audio that is not inline${every ? '' : ' wav or mp3'}`,
    );
  }
  return {
    type: 'input_audio',
    input_audio: { ...hinted(part.hints), data, format },
  };
}

export function file(
  dialect: Dialect,
  part: Extract<Part, { type: 'file' }>,
): Dict {
  const { id, url, data, mediaType, name } = part;
  const located = address(part);
  if (
    dialect.video === true &&
    located !== undefined &&
    mediaType?.startsWith('video/')
  ) {
    return {
      type: 'video_url',
      video_url: { ...hinted(part.hints), url: located },
    };
  }
  const pictures = dialect.files === 'pictures';
  if (url !== undefined && dialect.files !== 'any') {
    unsupported('Chat Completions cannot carry a file given by address');
  }
  const taken =
    dialect.files === 'any' ||
    mediaType === undefined ||
    (pictures
      ? mediaType.startsWith('image/')
      : mediaType === 'application/pdf');
  if (!taken) unsupported(`Chat Completions takes no ${mediaType} file`);
  // Bytes with no type named are a form of OpenAI's own alone.
  if (
    located === undefined &&
    id === undefined &&
    dialect.files !== undefined
  ) {
    unsupported(
      'Chat Completions cannot carry file bytes of no named media type',
    );
  }
  if (pictures && id !== undefined && name !== undefined) {
    unsupported(
      `Chat Completions cannot carry the name of a file given by id to ${dialect.name}`,
    );
  }
  const fields = {
    ...hinted(part.hints),
    ...given({
      file_data: id === undefined ? (located ?? data) : undefined,
      file_id: id,
      filename: pictures ? name : filename(part),
    }),
  };
  return pictures
    ? { type: 'file', ...fields }
    : { type: 'file', file: fields };
}
