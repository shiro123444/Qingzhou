/**
 * Tolerant JSON recovery for model output.
 *
 * Providers occasionally answer with JavaScript-flavoured objects
 * (`{"visuals":[{"id":"visual-1",renderer:"image"}]}`), single-quoted strings,
 * Python literals or trailing commas even when strict JSON was requested.
 * Rejecting that answer costs an entire pipeline stage, so syntax is normalized
 * here while schema validation stays the only gate on content.
 *
 * Repair never fabricates missing structure: an unterminated string or object
 * stays invalid so truncated answers keep flowing into the harvest path.
 */

/** Literals that are not JSON but appear in model output. */
const FOREIGN_LITERALS: Record<string, string> = {
  False: 'false',
  Infinity: 'null',
  NaN: 'null',
  None: 'null',
  True: 'true',
  undefined: 'null',
};

/** Real JSON literals must survive bare-token repair untouched. */
const JSON_LITERALS = new Set(['false', 'null', 'true']);

const IDENTIFIER_PART = /[$\w-]/u;
const IDENTIFIER_START = /[A-Za-z_$]/u;
const LEADING_NOISE = /^[\u200B\u200E\u200F\s]+/u;
/** Characters after which a JSON string may legally open. */
const STRING_STARTERS = new Set(['', '(', ',', ':', '[', '{']);

const isWhitespace = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && isWhitespace(text.charAt(index))) index += 1;
  return index;
};

/** Raw control characters are invalid inside JSON strings; escape them. */
const escapeControlCharacter = (char: string): string => {
  if (char === '\n') return '\\n';
  if (char === '\r') return '\\r';
  if (char === '\t') return '\\t';
  return char.charCodeAt(0) < 0x20
    ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    : char;
};

const copyDoubleQuoted = (text: string, start: number): { chunk: string; next: number } => {
  let chunk = '"';
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      const escape = text.charAt(index + 1);
      if (!escape) {
        index += 1;
        continue;
      }
      // A backslash before a real newline is a line continuation, not an escape.
      if (escape !== '\n' && escape !== '\r') chunk += char + escape;
      index += 2;
      continue;
    }
    if (char === '"') return { chunk: `${chunk}"`, next: index + 1 };
    chunk += escapeControlCharacter(char);
    index += 1;
  }
  // Unterminated: leave it open so the caller still sees invalid JSON.
  return { chunk, next: text.length };
};

const copySingleQuoted = (text: string, start: number): { chunk: string; next: number } => {
  let chunk = '"';
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      const escape = text.charAt(index + 1);
      if (escape === "'") {
        chunk += "'";
        index += 2;
        continue;
      }
      if (!escape) {
        index += 1;
        continue;
      }
      chunk += escape === '"' ? '\\"' : char + escape;
      index += 2;
      continue;
    }
    if (char === "'") return { chunk: `${chunk}"`, next: index + 1 };
    chunk += char === '"' ? '\\"' : escapeControlCharacter(char);
    index += 1;
  }
  return { chunk, next: text.length };
};

/** `renderer:"image"` and `kind:scientific-diagram` are bare keys or bare strings. */
const copyBareToken = (text: string, start: number): { chunk: string; next: number } => {
  let index = start;
  while (index < text.length && IDENTIFIER_PART.test(text.charAt(index))) index += 1;
  const token = text.slice(start, index);
  if (JSON_LITERALS.has(token)) return { chunk: token, next: index };
  return { chunk: FOREIGN_LITERALS[token] ?? JSON.stringify(token), next: index };
};

const previousNonSpace = (text: string, index: number): string => {
  let cursor = index - 1;
  while (cursor >= 0 && isWhitespace(text.charAt(cursor))) cursor -= 1;
  return cursor < 0 ? '' : text.charAt(cursor);
};

/**
 * In JSON a string may only start after `{`, `[`, `,`, `:` or `(`. Anywhere else
 * the quote is model noise such as the stray quote in `brief":"value"`.
 */
const opensString = (text: string, index: number): boolean =>
  STRING_STARTERS.has(previousNonSpace(text, index));

/** Rewrites common model syntax deviations into strict JSON text. */
export const repairModelJson = (text: string): string => {
  let repaired = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"' || char === "'") {
      // A quote that cannot be a string opener is model noise; drop it.
      if (!opensString(text, index)) {
        index += 1;
        continue;
      }
      const { chunk, next } =
        char === '"' ? copyDoubleQuoted(text, index) : copySingleQuoted(text, index);
      repaired += chunk;
      index = next;
      continue;
    }
    if (char === '/' && text.charAt(index + 1) === '/') {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    if (char === '/' && text.charAt(index + 1) === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      const { chunk, next } = copyBareToken(text, index);
      repaired += chunk;
      index = next;
      continue;
    }
    if (char === ',') {
      const follower = text.charAt(skipWhitespace(text, index + 1));
      if (follower === '}' || follower === ']') {
        index += 1;
        continue;
      }
    }
    repaired += char;
    index += 1;
  }
  return repaired;
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Advances past a quoted run, honouring escapes; returns the index after the closing quote. */
const skipQuoted = (text: string, start: number, quote: string): number => {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return text.length;
};

/**
 * Balanced `{...}` / `[...]` spans in appearance order, scanned string-aware so
 * braces inside prose or quoted values never unbalance the JSON.
 */
export const balancedJsonCandidates = (text: string): string[] => {
  const candidates: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const starts = [text.indexOf('{', cursor), text.indexOf('[', cursor)].filter(
      (index) => index >= 0,
    );
    if (!starts.length) break;
    const start = Math.min(...starts);
    let depth = 0;
    let index = start;
    let closed = false;
    while (index < text.length) {
      const char = text.charAt(index);
      if ((char === '"' || char === "'") && opensString(text, index)) {
        index = skipQuoted(text, index, char);
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          closed = true;
          index += 1;
          break;
        }
      }
      index += 1;
    }
    cursor = closed ? index : Math.max(index, start + 1);
  }
  return candidates;
};

const stripReasoningAndFences = (content: string): string =>
  content
    .replaceAll(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/giu, '')
    .replaceAll(/<\/?think(?:ing)?>/giu, '')
    .replace(/^\s*```(?:json|javascript|js)?\s*/iu, '')
    .replace(/\s*```\s*$/u, '')
    .replace(LEADING_NOISE, '')
    .trim();

/** Extract a JSON value from fences, think-tags, repaired syntax, or mixed model prose. */
export const extractModelJson = (content: string): unknown => {
  const cleaned = stripReasoningAndFences(content);
  const direct = tryParseJson(cleaned);
  if (direct !== undefined) return direct;
  const candidates = balancedJsonCandidates(cleaned);
  // Payloads are objects, so prose brackets such as "see [1]" must never shadow them.
  const ordered = [
    ...candidates.filter((candidate) => candidate.startsWith('{')),
    ...candidates.filter((candidate) => !candidate.startsWith('{')),
  ];
  for (const candidate of ordered) {
    const parsed = tryParseJson(candidate) ?? tryParseJson(repairModelJson(candidate));
    if (parsed !== undefined) return parsed;
  }
  throw new SyntaxError('Model response was not valid JSON');
};
