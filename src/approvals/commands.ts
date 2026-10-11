// Pure helpers for proposed terminal commands: destructive-command detection and output cleanup.

const RULES: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r\b)/i, 'deletes files recursively'],
  [/\b(rmdir|rd)\s+\/s\b/i, 'deletes a folder tree'],
  [/\bdel\s+.*\/[sq]\b/i, 'deletes files in bulk'],
  [/\bRemove-Item\b.*-Recurse/i, 'deletes files recursively'],
  [/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)/i, 'force-pushes and can overwrite remote history'],
  [/\bgit\s+reset\s+--hard\b/i, 'discards uncommitted changes'],
  [/\bgit\s+clean\b.*-[a-z]*f/i, 'deletes untracked files'],
  [/\bgit\s+checkout\s+(--\s+)?\.(\s|$)/i, 'discards uncommitted changes'],
  [/\bgit\s+(branch\s+-D|stash\s+(drop|clear))\b/i, 'discards branches or stashes'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, 'runs a script downloaded from the internet'],
  [/\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|\s*iex\b/i, 'runs a script downloaded from the internet'],
  [/\bsudo\b/, 'runs with administrator rights'],
  [/\b(mkfs|format)\b(\.\w+)?\s/i, 'formats a disk'],
  [/\bdd\s+if=/i, 'writes raw data to a device'],
  [/\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b/i, 'shuts down or restarts the machine'],
  [/\bchmod\s+-R\s+0?777\b/, 'makes files writable by everyone'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'is a fork bomb'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, 'publishes a package'],
  [/\bdrop\s+(database|table)\b/i, 'drops database objects'],
];

/** Returns why a command looks destructive, or undefined. A heuristic, not a sandbox. */
export function commandWarning(command: string): string | undefined {
  const hits = RULES.filter(([re]) => re.test(command)).map(([, why]) => why);
  return hits.length ? `This command ${[...new Set(hits)].join(' and ')}.` : undefined;
}

// CSI, OSC (BEL or ST terminated) and two-character escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Removes terminal escape codes and collapses carriage-return progress redraws. */
export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}

/** Keeps the last `max` characters, cutting at a line boundary when possible. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf('\n');
  return `…\n${nl !== -1 && nl < max / 4 ? cut.slice(nl + 1) : cut}`;
}
