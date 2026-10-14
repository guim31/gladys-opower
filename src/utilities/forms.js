// -----------------------------------------------------------------------------
// Just enough HTML reading for the sign-in pages: their <input>s and a few
// attributes. Only the authentication pages are parsed this way;
// the data itself comes from the Opower JSON API.
// -----------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower in ENTITIES) {
      return ENTITIES[lower];
    }
    if (lower.startsWith('#x')) {
      return String.fromCodePoint(parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith('#')) {
      return String.fromCodePoint(Number(lower.slice(1)));
    }
    return whole;
  });
}

/** The attributes of one tag (`<input name="a" value='b' checked>`), names lower-cased. */
export function parseAttributes(tag) {
  const attributes = {};
  const body = tag.replace(/^<\s*[a-z0-9-]+/i, '').replace(/\/?>$/, '');
  const pattern = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const value = match[2] ?? match[3] ?? match[4];
    attributes[match[1].toLowerCase()] = value === undefined ? '' : decodeEntities(value);
  }
  return attributes;
}

/** Every tag of a kind, with its attributes, in document order. */
export function findTags(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  return [...html.matchAll(pattern)].map((match) => ({
    index: match.index,
    attributes: parseAttributes(match[0]),
  }));
}

/** Every named <input> of the page, name → value, whatever its form. */
export function parseAllInputs(html) {
  const inputs = {};
  for (const { attributes } of findTags(html, 'input')) {
    if (attributes.name) {
      inputs[attributes.name] = attributes.value ?? '';
    }
  }
  return inputs;
}
