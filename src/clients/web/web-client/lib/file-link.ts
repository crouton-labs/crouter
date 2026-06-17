/**
 * Path linkifier utilities for the file peek panel.
 *
 * `isPeekablePath` identifies absolute paths with text-ish extensions that are
 * safe and useful to peek; `extractPeekablePaths` finds all such paths in a
 * string of text.
 */

// TEXT-ISH extensions that are safe/useful to peek
const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.css', '.html', '.htm', '.yaml', '.yml', '.toml', '.log', '.sh', '.py',
  '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.env', '.gitignore',
]);

/** Returns true if `path` looks like a peekable file path */
export function isPeekablePath(path: string): boolean {
  // Must be absolute (starts with /) with at least 2 segments
  // Must have a text-ish extension
  if (!path.startsWith('/')) return false;
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  const dotIdx = last.lastIndexOf('.');
  if (dotIdx < 1) return false; // no extension or hidden file (dot at index 0)
  const ext = last.slice(dotIdx).toLowerCase();
  return TEXT_EXTS.has(ext);
}

/** Extract all peekable paths from a string of text */
export function extractPeekablePaths(text: string): string[] {
  // Match absolute paths: /word[/word]*.ext
  const re = /\/[a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]+/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (isPeekablePath(m[0])) matches.push(m[0]);
  }
  return [...new Set(matches)]; // deduplicate
}
