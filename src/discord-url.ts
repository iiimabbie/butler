const URL_CANDIDATE = /https?:\/\/[^\s<>"'`，。！？；：、…“”‘’「」『』]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、…]+$/u;
const WRAPPING_QUOTES = new Set(['"', "'", '“', '”', '‘', '’', '「', '」', '『', '』']);

export function formatDiscordUrls(text: string): string {
  const codeMask = new Uint8Array(text.length);
  protectCode(text, codeMask);
  text = wrapMarkdownDestinations(text, codeMask);
  const protectedChars = new Uint8Array(text.length);
  protectCode(text, protectedChars);
  protectMarkdownDestinations(text, protectedChars);
  return text.replace(URL_CANDIDATE, (candidate, offset: number) => {
    if (protectedChars[offset]) return candidate;
    let url = candidate;
    const punctuation = url.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    url = url.slice(0, url.length - punctuation.length);
    const emphasis = url.match(/(\*{1,3}|_{1,2})$/)?.[0] ?? '';
    const opener = text.slice(Math.max(0, offset - emphasis.length), offset);
    const beforeOpener = text[offset - emphasis.length - 1] ?? '';
    const afterCloser = text[offset + candidate.length] ?? '';
    const pairedEmphasis = !!emphasis && opener === emphasis && !/[\w@]/u.test(beforeOpener) && !/[\w]/u.test(afterCloser);
    if (pairedEmphasis) url = url.slice(0, -emphasis.length);
    const previous = text[offset - 1] ?? '';
    if (/[\w@]/u.test(previous) && !pairedEmphasis) return candidate;
    while (url && WRAPPING_QUOTES.has(url.at(-1)!)) url = url.slice(0, -1);
    const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['【', '】'], ['「', '」'], ['『', '』']];
    while (true) {
      const pair = pairs.find(([, close]) => url.endsWith(close));
      if (!pair || count(url, pair[1]!) <= count(url, pair[0]!)) break;
      url = url.slice(0, -1);
    }
    if (!url || url.length + 2 > 2000) return candidate;
    return `<${url}>${candidate.slice(url.length)}`;
  });
}

function protectCode(text: string, mask: Uint8Array): void {
  let index = 0;
  let fenceChar = '';
  let fenceLength = 0;
  let inlineLength = 0;
  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === '\n';
    if (!inlineLength && lineStart) {
      const fence = text.slice(index).match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (fence) {
        const marker = fence[1]!;
        const end = text.indexOf('\n', index);
        const line = text.slice(index, end < 0 ? text.length : end);
        if (!fenceChar) { fenceChar = marker[0]!; fenceLength = marker.length; }
        else if (marker[0] === fenceChar && marker.length >= fenceLength && new RegExp(`^[ \\t]{0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(line)) { fenceChar = ''; fenceLength = 0; }
        const next = end < 0 ? text.length : end + 1;
        mask.fill(1, index, next); index = next; continue;
      }
    }
    if (fenceChar) { mask[index++] = 1; continue; }
    if (text[index] === '`' && !isEscaped(text, index)) {
      let length = 1; while (text[index + length] === '`') length++;
      if (!inlineLength) inlineLength = length;
      else if (length === inlineLength) inlineLength = 0;
      mask.fill(1, index, index + length); index += length; continue;
    }
    if (inlineLength) mask[index] = 1;
    index++;
  }
}

function wrapMarkdownDestinations(text: string, mask: Uint8Array): string {
  const links = /!?\[[^\]\n]*\]\(\s*(?:<[^>]*>|https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*|[^\s)]*)\s*(?:"[^"\n]*")?\s*\)/gm;
  return text.replace(links, (link, offset: number) => {
    if (isEscaped(text, offset) || mask[offset]) return link;
    const destinationOpen = link.indexOf('](') + 1;
    const prefix = link.slice(0, destinationOpen + 1);
    const destinationStart = prefix.length + /^\s*/.exec(link.slice(prefix.length))![0].length;
    const content = link.slice(destinationStart, -1);
    if (content.startsWith('<') || isEscaped(text, offset)) return link;
    const scheme = /^https?:\/\//i.exec(content)?.[0];
    if (!scheme) return link;
    let end = scheme.length;
    let depth = 0;
    while (end < content.length) {
      const character = content[end]!;
      if (/\s/u.test(character)) break;
      if (character === '(') depth++;
      else if (character === ')') {
        if (depth === 0) break;
        depth--;
      }
      end++;
    }
    const url = content.slice(0, end);
    if (!url) return link;
    const urlStart = offset + destinationStart;
    if (isEscaped(text, urlStart)) return link;
    return `${link.slice(0, destinationStart)}<${url}>${link.slice(destinationStart + url.length)}`;
  });
}

function protectMarkdownDestinations(text: string, mask: Uint8Array): void {
  const links = /!?\[[^\]\n]*\]\(\s*(?:<[^>]*>|[^\s)]*(?:\([^)]*\)[^\s)]*)*)\s*(?:"[^"\n]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?\S+>?/gm;
  for (const match of text.matchAll(links)) mask.fill(1, match.index!, match.index! + match[0].length);
  for (const match of text.matchAll(/<https?:\/\/[^>]+>/gi)) mask.fill(1, match.index!, match.index! + match[0].length);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === '\\'; at--) slashes++;
  return slashes % 2 === 1;
}

function count(text: string, character: string): number { return [...text].filter(value => value === character).length; }
