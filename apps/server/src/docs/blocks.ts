/**
 * Fenced config blocks inside docs/*.md, written as:
 *
 *   ```json clearpath:<name>
 *   { ...JSON... }
 *   ```
 *
 * Only these blocks are machine-read or machine-written; the prose around them is left alone.
 */

export class BlockError extends Error {
  override name = "BlockError";
}

function blockRegex(name: string): RegExp {
  return new RegExp("^```json clearpath:" + name + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$", "gm");
}

function findOne(markdown: string, name: string, file: string): RegExpExecArray {
  const matches = [...markdown.matchAll(blockRegex(name))];
  if (matches.length === 0) throw new BlockError(`${file}: no \`\`\`json clearpath:${name} block found`);
  if (matches.length > 1) throw new BlockError(`${file}: more than one clearpath:${name} block`);
  return matches[0]!;
}

export function readBlock(markdown: string, name: string, file = "document"): unknown {
  const body = findOne(markdown, name, file)[1]!;
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new BlockError(`${file}: clearpath:${name} block is not valid JSON (${(err as Error).message})`);
  }
}

/** Returns the markdown with the block's JSON replaced; everything else is byte-identical. */
export function writeBlock(markdown: string, name: string, value: unknown, file = "document"): string {
  const match = findOne(markdown, name, file);
  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const json = JSON.stringify(value, null, 2).replace(/\n/g, eol);
  const replacement = "```json clearpath:" + name + eol + json + eol + "```";
  const start = match.index!;
  return markdown.slice(0, start) + replacement + markdown.slice(start + match[0].length);
}
