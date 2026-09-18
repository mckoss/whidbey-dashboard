// Small, dependency-free HTML helpers.
//
// Deliberately not a DOM parser. The harvester never depends on a specific
// class name or element nesting, so tolerant scanning is enough — and it keeps
// the "no build step, minimal dependencies" shape of the sibling dashboard.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', deg: '°', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(input) {
  if (!input) return '';
  let out = String(input);
  // Repeat once to handle double-encoded text (&amp;#39; -> &#39; -> ').
  for (let pass = 0; pass < 2; pass += 1) {
    out = out.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    });
  }
  return out;
}

export function stripTags(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse an HTML attribute list into a lowercase-keyed object.
export function parseAttributes(tagText) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  // Skip the tag name itself.
  const body = String(tagText).replace(/^<\s*\/?[a-zA-Z0-9-]+/, '');
  let match;
  while ((match = re.exec(body)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

// Yield every occurrence of a tag as { tag, attrs, index, raw }.
export function findTags(html, tagName) {
  const out = [];
  if (!html) return out;
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let match;
  while ((match = re.exec(html)) !== null) {
    out.push({ raw: match[0], attrs: parseAttributes(match[0]), index: match.index });
  }
  return out;
}

// Yield each <tag ...>...</tag> block, with nesting handled for the common case
// of one level (figure inside figure is not a thing we need to support).
export function findBlocks(html, tagName) {
  const out = [];
  if (!html) return out;
  const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let match;
  while ((match = open.exec(html)) !== null) {
    const start = match.index;
    const close = new RegExp(`</${tagName}\\s*>`, 'gi');
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    const stop = end ? end.index + end[0].length : Math.min(html.length, start + 20000);
    out.push({
      openTag: match[0],
      attrs: parseAttributes(match[0]),
      inner: html.slice(open.lastIndex, end ? end.index : stop),
      html: html.slice(start, stop),
      index: start,
    });
  }
  return out;
}

// Extract <script> payloads that hold JSON: __NEXT_DATA__, application/json,
// application/ld+json, and `window.__SOMETHING__ = { ... };` assignments.
export function findScriptJson(html) {
  const results = [];
  if (!html) return results;
  for (const block of findBlocks(html, 'script')) {
    const type = (block.attrs.type || '').toLowerCase();
    const id = block.attrs.id || '';
    const body = block.inner.trim();
    if (!body) continue;

    const isJsonType = type.includes('json');
    if (isJsonType) {
      const parsed = tryParseJson(body);
      if (parsed !== undefined) {
        results.push({
          kind: type.includes('ld+json') ? 'ld+json' : 'application/json',
          id,
          data: parsed,
          bytes: body.length,
        });
      }
      continue;
    }

    // `window.__NATGEO__ = {...};` / `var __DATA__ = {...};`
    const assignment = body.match(
      /(?:window|self|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*([[{])/,
    );
    if (assignment) {
      const start = body.indexOf(assignment[2], assignment.index);
      const slice = sliceBalanced(body, start);
      const parsed = slice === null ? undefined : tryParseJson(slice);
      if (parsed !== undefined) {
        results.push({ kind: 'inline-assignment', id: assignment[1], data: parsed, bytes: slice.length });
      }
    }
  }
  return results;
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Walk forward from an opening brace/bracket to its balanced partner,
// respecting string literals and escapes.
export function sliceBalanced(text, start) {
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : openChar === '[' ? ']' : null;
  if (!closeChar) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Depth-limited walk over any parsed JSON value.
export function walkJson(root, visit, { maxNodes = 200000, maxDepth = 60 } = {}) {
  let seen = 0;
  const stack = [{ node: root, depth: 0, path: '$' }];
  const visited = new Set();
  while (stack.length) {
    const { node, depth, path } = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > maxDepth) continue;
    if (visited.has(node)) continue;
    visited.add(node);
    seen += 1;
    if (seen > maxNodes) break;
    visit(node, path);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], depth: depth + 1, path: `${path}[${i}]` });
      }
    } else {
      for (const key of Object.keys(node)) {
        stack.push({ node: node[key], depth: depth + 1, path: `${path}.${key}` });
      }
    }
  }
  return seen;
}
