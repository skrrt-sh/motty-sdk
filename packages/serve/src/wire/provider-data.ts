import type { ProviderData, ReadonlyJson } from '@mottyjs/core/host';
import type { LeftOut } from '../codec.ts';
import { copied, type Dict, dict, picked, without } from './json.ts';
import { unsupported } from './refusals.ts';

// A null, an empty list and an empty object say what leaving the field out
// says, so none of them is worth failing a call of another family for.
function says(value: ReadonlyJson): boolean {
  if (value === null) return false;
  if (typeof value !== 'object') return true;
  return Object.keys(value).length > 0;
}

export function meant(fields: Dict): Dict {
  return picked(fields, (_name, value) => says(value));
}

// One per wire API, not per provider: two APIs of one provider name the same
// options in other shapes, so neither may read what was written for the
// other. The name is what the API goes by when a call is refused.
export function providerData(
  key: string,
  api: string,
  vendor?: string,
  elsewhere?: ReadonlySet<string>,
) {
  // A call the caller's own tools run is read this way, with no refusal: what
  // it holds for another API alone came with an answer the author copied, and
  // failing on it would end a conversation on its first turn across families.
  function mine(data: ProviderData | undefined): Dict {
    const fields = data?.[key];
    return fields === undefined ? {} : dict(copied(fields));
  }

  // Which API of a provider is spoken is the host's choice, not the author's,
  // so a provider with two has a key both read. This API's own entry is the
  // author addressing it, and wins a clash, field by whole field.
  function hinted(data: ProviderData | undefined): Dict {
    const shared = vendor === undefined ? undefined : data?.[vendor];
    return shared === undefined
      ? mine(data)
      : { ...dict(copied(shared)), ...mine(data) };
  }

  // The fields are named so an author knows what to take out, and by name
  // alone, since a value may be a secret. A long list ends in a count. An
  // entry that says nothing, as one an author emptied, carries nothing.
  function refused(data: ProviderData | undefined, what: string): void {
    const [other] = Object.keys(data ?? {}).filter((name) =>
      says(data?.[name] ?? null),
    );
    if (other === undefined) return;
    const fields = data?.[other];
    const names =
      typeof fields === 'object' && fields !== null && !Array.isArray(fields)
        ? Object.keys(fields)
        : [];
    const more = names.length - 5;
    const listed =
      more > 0
        ? `${names.slice(0, 5).join(', ')} and ${more} more`
        : names.join(', ');
    unsupported(
      `${api} cannot carry ${what} of ${other}${listed === '' ? '' : `: ${listed}`}`,
    );
  }

  // A map with no entry for this API changes the meaning in a way this wire
  // cannot say, so the call fails and a fallback can move on. A provider's
  // two APIs share no shape for a tool, a choice or a part, so its key is none.
  function own(data: ProviderData | undefined, what: string): Dict {
    if (data?.[key] === undefined) refused(data, what);
    return mine(data);
  }

  // Sent on, such a field would be dropped by an upstream that ignores what
  // it does not know. A field no list names is sent as said, so a list that
  // has gone stale never leaves one out.
  function strays(data: ProviderData | undefined): Dict {
    const shared = vendor === undefined ? undefined : data?.[vendor];
    if (shared === undefined || elsewhere === undefined) return {};
    const said = mine(data);
    return picked(
      dict(copied(shared)),
      (name) => elsewhere.has(name) && !Object.hasOwn(said, name),
    );
  }

  function kept(fields: Dict, alien: Dict): Dict {
    const names = Object.keys(alien);
    return names.length === 0 ? fields : without(fields, names);
  }

  // A request's options are where an API's own fields are named, so there
  // the provider's key is an entry. A field of the other API alone fails the
  // call as an option, unless it says nothing, and is reported as a hint.
  function addressed(options: {
    provider?: ProviderData;
    hints?: ProviderData;
  }): { provider: Dict; hints: Dict; leftOut: LeftOut[] } {
    const { provider, hints } = options;
    const alien = strays(provider);
    const [stray] = Object.keys(meant(alien));
    if (stray !== undefined) {
      unsupported(
        `${api} cannot carry ${stray}, which another API of ${vendor} has`,
      );
    }
    if (
      provider?.[key] === undefined &&
      (vendor === undefined || provider?.[vendor] === undefined)
    ) {
      refused(provider, 'an option');
    }
    const dropped = strays(hints);
    return {
      provider: kept(hinted(provider), alien),
      hints: kept(hinted(hints), dropped),
      leftOut: Object.keys(dropped).map((name) => ({
        setting: `${vendor}.${name}`,
        detail: `${api} has no field for ${name}`,
      })),
    };
  }

  function marked(fields: Dict): { provider?: ProviderData } {
    const kept = meant(fields);
    return Object.keys(kept).length === 0 ? {} : { provider: { [key]: kept } };
  }

  function noted(fields: Dict): { hints?: ProviderData } {
    return Object.keys(fields).length === 0 ? {} : { hints: { [key]: fields } };
  }

  return { hinted, own, mine, addressed, marked, noted };
}
