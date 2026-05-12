import type { SkillFrontmatter } from '../types.js';

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export interface ParsedFrontmatter {
  data: SkillFrontmatter | null;
  body: string;
  raw: string;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { data: null, body: source, raw: '' };
  }
  const raw = match[1];
  const body = source.slice(match[0].length);
  return { data: parseSimpleYaml(raw), body, raw };
}

function parseSimpleYaml(yaml: string): SkillFrontmatter {
  const lines = yaml.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let listBuffer: string[] | null = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (raw.startsWith('  - ') || raw.startsWith('- ')) {
      const value = raw.replace(/^\s*-\s+/, '').trim();
      if (currentKey && listBuffer) listBuffer.push(stripQuotes(value));
      continue;
    }
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    if (currentKey && listBuffer) {
      out[currentKey] = listBuffer;
      listBuffer = null;
    }
    const key = raw.slice(0, idx).trim();
    const rest = raw.slice(idx + 1).trim();
    currentKey = key;
    if (rest === '') {
      listBuffer = [];
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      currentKey = null;
      continue;
    }
    out[key] = stripQuotes(rest);
    currentKey = null;
  }
  if (currentKey && listBuffer) out[currentKey] = listBuffer;
  const fm: SkillFrontmatter = {
    name: typeof out.name === 'string' ? out.name : '',
    description: typeof out.description === 'string' ? out.description : undefined,
    keywords: Array.isArray(out.keywords) ? (out.keywords as string[]) : undefined,
  };
  return fm;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function serializeFrontmatter(data: SkillFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${quoteIfNeeded(data.name)}`);
  if (data.description !== undefined) {
    lines.push(`description: ${quoteIfNeeded(data.description)}`);
  }
  if (data.keywords && data.keywords.length) {
    const inline = `[${data.keywords.map(quoteIfNeeded).join(', ')}]`;
    lines.push(`keywords: ${inline}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function quoteIfNeeded(s: string): string {
  if (/[:#\-\[\]{},&*?|<>=!%@`]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}
