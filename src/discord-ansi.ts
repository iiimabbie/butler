export function stripAnsiProgress(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const output: string[] = [];
  let active: { marker: '`' | '~'; length: number; ansi: boolean } | undefined;
  for (const line of lines) {
    const source = line.replace(/\r?\n$/, '');
    const fence = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(source);
    if (!active) {
      if (fence) {
        const marker = fence[2]![0] as '`' | '~';
        const ansi = /(?:^|\s)ansi(?:\s|$)/i.test(fence[3]!.trim());
        active = { marker, length: fence[2]!.length, ansi };
        if (!ansi) output.push(line);
      } else output.push(line);
      continue;
    }
    const closing = /^( {0,3})(`+|~+)[ \t]*$/.exec(source);
    const closes = closing && closing[2]![0] === active.marker && closing[2]!.length >= active.length;
    if (!active.ansi) output.push(line);
    if (closes) active = undefined;
  }
  return output.join('').trim();
}
