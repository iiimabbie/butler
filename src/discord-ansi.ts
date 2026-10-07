export function hasAnsiProgress(text: string): boolean {
  const lines = text.split(/(?<=\n)/);
  let active: { marker: '`' | '~'; length: number } | undefined;
  for (const line of lines) {
    const source = line.replace(/\r?\n$/, '');
    const fence = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(source);
    if (!active) {
      if (!fence) continue;
      const marker = fence[2]![0] as '`' | '~';
      const ansi = /(?:^|\s)ansi(?:\s|$)/i.test(fence[3]!.trim());
      if (ansi) return true;
      active = { marker, length: fence[2]!.length };
      continue;
    }
    const closing = /^( {0,3})(`+|~+)[ \t]*$/.exec(source);
    const closes = closing && closing[2]![0] === active.marker && closing[2]!.length >= active.length;
    if (closes) active = undefined;
  }
  return false;
}
