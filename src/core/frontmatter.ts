import { isSkillType, type SkillFrontmatter } from '../types.js';

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
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) {
      i++;
      continue;
    }
    const idx = raw.indexOf(':');
    if (idx === -1) {
      i++;
      continue;
    }
    const key = raw.slice(0, idx).trim();
    const rest = raw.slice(idx + 1).trim();

    // Block scalar: `key: |` or `key: >` with optional chomp indicator (-/+)
    const blockMatch = rest.match(/^([|>])([-+]?)\s*$/);
    if (blockMatch) {
      const style = blockMatch[1];
      const chomp = blockMatch[2];
      const collected: string[] = [];
      let blockIndent: number | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const r = lines[j];
        if (r.trim() === '') {
          collected.push('');
          j++;
          continue;
        }
        const ind = r.match(/^(\s*)/)?.[1].length ?? 0;
        if (blockIndent === null) {
          if (ind === 0) break;
          blockIndent = ind;
        }
        if (ind < blockIndent) break;
        collected.push(r.slice(blockIndent));
        j++;
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

      let value: string;
      if (style === '|') {
        value = collected.join('\n');
      } else {
        const parts: string[] = [];
        let para: string[] = [];
        for (const ln of collected) {
          if (ln === '') {
            if (para.length > 0) {
              parts.push(para.join(' '));
              para = [];
            }
            parts.push('');
          } else {
            para.push(ln);
          }
        }
        if (para.length > 0) parts.push(para.join(' '));
        const folded: string[] = [];
        for (let k = 0; k < parts.length; k++) {
          if (parts[k] === '' && (k === 0 || parts[k - 1] === '')) continue;
          folded.push(parts[k]);
        }
        value = folded.join('\n').replace(/\n+$/, '');
      }

      if (chomp !== '+') value = value.replace(/\n+$/, '');
      out[key] = value;
      i = j;
      continue;
    }

    // Empty value: could be a list on subsequent lines
    if (rest === '') {
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const r = lines[j];
        if (r.trim() === '') {
          j++;
          continue;
        }
        if (/^\s*-\s+/.test(r)) {
          buf.push(stripQuotes(r.replace(/^\s*-\s+/, '').trim()));
          j++;
          continue;
        }
        break;
      }
      if (buf.length > 0) out[key] = buf;
      i = j;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      i++;
      continue;
    }

    out[key] = stripQuotes(rest);
    i++;
  }
  const fm: SkillFrontmatter = {
    name: typeof out.name === 'string' ? out.name : '',
    description: typeof out.description === 'string' ? out.description : undefined,
    keywords: Array.isArray(out.keywords) ? (out.keywords as string[]) : undefined,
    type: isSkillType(out.type) ? out.type : undefined,
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
  if (data.type !== undefined) {
    lines.push(`type: ${data.type}`);
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
