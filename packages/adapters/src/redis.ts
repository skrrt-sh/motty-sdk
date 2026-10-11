import type { Storage } from '@mottyjs/core/host';
import { RedisClient } from 'bun';
import { parsed } from './json.ts';

// The server counts whole milliseconds and refuses none. A time that is no
// count is the caller's mistake, so it is named before any call.
function milliseconds(ttl: number): number {
  const ms = Math.ceil(ttl * 1000);
  if (!(ms >= 1) || !Number.isSafeInteger(ms)) {
    throw new Error(
      `A time to live is a positive, finite number of seconds, and ${ttl} is not`,
    );
  }
  return ms;
}

// Run by the server as one step, so no other command comes between the read
// and the addition. The expiry is set only on the key this call made.
const adding = `
local held = redis.call('GET', KEYS[1])
local before = 0
if held then
  -- Only the text JSON has for a number is added to: the reading done here
  -- also takes hex, a plus sign and words, which no read gives as a number.
  local number = string.match(held, '^[ \\t\\n\\r]*(.-)[ \\t\\n\\r]*$')
  local whole, rest = string.match(number, '^%-?(%d+)(.*)$')
  if not whole or string.find(whole, '^0%d') then return false end
  rest = string.gsub(rest, '^%.%d+', '', 1)
  rest = string.gsub(rest, '^[eE][+-]?%d+', '', 1)
  if rest ~= '' then return false end
  before = tonumber(number)
end
-- The server's own addition is in a wider float and prints a rounded decimal.
-- A double written in seventeen digits is read back as that double, so the
-- total is the one the same additions give anywhere else.
local total = before + tonumber(ARGV[1])
local text = string.format('%.17g', total)
if total ~= total or total == math.huge or total == -math.huge then
  return text
end
if held then
  redis.call('SET', KEYS[1], text, 'KEEPTTL')
elseif ARGV[2] ~= '' then
  redis.call('SET', KEYS[1], text, 'PX', ARGV[2])
else
  redis.call('SET', KEYS[1], text)
end
return text
`;

export function redis(options: { url: string | undefined }): Storage {
  const { url } = options;
  if (url === undefined || url === '') {
    throw new Error('The redis adapter was given no url');
  }
  // The client takes text that is no address and fails on the first call.
  // The url is not quoted: it may hold a password.
  if (!URL.canParse(url)) {
    throw new Error('The redis adapter was given a url that cannot be parsed');
  }
  // The client's own reconnecting holds a call for half a minute while the
  // server is down and never recovers after; connecting again on the next
  // call fails at once and recovers. Pipelining is off: one call, one command.
  const client = new RedisClient(url, {
    autoReconnect: false,
    enableAutoPipelining: false,
  });
  const linked = async () => {
    if (!client.connected) await client.connect();
    return client;
  };
  return {
    get: async (key) => {
      const text = await (await linked()).get(key);
      if (text === null) return undefined;
      try {
        return parsed(text);
      } catch (cause) {
        // Read as missing, it would be overwritten: it is another writer's.
        throw new Error(`The value stored under ${key} is not JSON`, { cause });
      }
    },
    set: async (key, value, options) => {
      const text = JSON.stringify(value);
      if (options?.ttl === undefined) {
        await (await linked()).set(key, text);
        return;
      }
      const ms = milliseconds(options.ttl);
      await (await linked()).set(key, text, 'PX', ms);
    },
    delete: async (key) => {
      await (await linked()).del(key);
    },
    increment: async (key, by, options) => {
      if (!Number.isFinite(by)) {
        throw new Error(`An increment is a finite number, and ${by} is not`);
      }
      const ms =
        options?.ttl === undefined ? '' : `${milliseconds(options.ttl)}`;
      const text: unknown = await (await linked()).send('EVAL', [
        adding,
        '1',
        key,
        `${by}`,
        ms,
      ]);
      if (typeof text !== 'string') {
        throw new Error(`The value stored under ${key} is not a number`);
      }
      const total = Number(text);
      if (!Number.isFinite(total)) {
        throw new Error(
          `The total stored under ${key} would not be a finite number`,
        );
      }
      return total;
    },
  };
}
