/** 安全定位正文标签，跳过代码、属性和链接目标。 / Locate prose tags, excluding literal Markdown. */
export interface IconTag {
  id: string;
  from: number;
  to: number;
}

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const createIconTagRegex = (delimiter: string): RegExp =>
  new RegExp(
    `${escapeRegex(delimiter)}([\\w-]{1,128}(?::\\d{17,20})?)${escapeRegex(delimiter)}`,
    'g',
  );

export function findIconTags(text: string, delimiter: string): IconTag[] {
  if (!delimiter) return [];
  const protectedRanges: Array<[number, number]> = [];
  // 先按行识别 YAML 与围栏，避免跨行代码中的标签被转换。 / Protect YAML and fenced code first.
  let offset = 0;
  let fence: { char: string; length: number; start: number } | undefined;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let frontmatter = /^(?:\uFEFF)?---\s*$/.test(lines[0]?.trimEnd() ?? '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) {
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(line.trimEnd())) {
        protectedRanges.push([0, offset + line.length]);
        frontmatter = false;
      }
    } else {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (!fence && match) {
        fence = { char: match[1][0], length: match[1].length, start: offset };
      } else if (
        fence &&
        match &&
        match[1][0] === fence.char &&
        match[1].length >= fence.length &&
        /^\s*$/.test(line.slice(match[0].length))
      ) {
        protectedRanges.push([fence.start, offset + line.length]);
        fence = undefined;
      } else if (!fence && /^( {4}|\t)/.test(line)) {
        protectedRanges.push([offset, offset + line.length]);
      }
    }
    offset += line.length;
  }
  if (frontmatter) protectedRanges.push([0, text.length]);
  if (fence) protectedRanges.push([fence.start, text.length]);
  const literal =
    /(`+)[\s\S]*?\1(?!`)|<!--[\s\S]*?(?:-->|$)|<svg\b[\s\S]*?<\/svg\s*>|<[^>\n]+>|!?\[\[[^\]\n]*\]\]|\]\([^\n]*?\)|^ {0,3}\[[^\]\n]+\]:[^\n]*/gim;
  for (const match of text.matchAll(literal)) {
    protectedRanges.push([match.index, match.index + match[0].length]);
  }
  // HTML 代码与裸 URL 同样属于字面内容。 / HTML code and bare URLs are literals too.
  for (const pattern of [
    /<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    /(?:https?:\/\/|obsidian:\/\/|mailto:)[^\s<>]+/gi,
  ]) {
    for (const match of text.matchAll(pattern))
      protectedRanges.push([match.index, match.index + match[0].length]);
  }
  protectedRanges.sort((a, b) => a[0] - b[0]);
  const regex = createIconTagRegex(delimiter);
  const tags: IconTag[] = [];
  let range = 0;
  for (const match of text.matchAll(regex)) {
    const from = match.index;
    while (range < protectedRanges.length && protectedRanges[range][1] <= from)
      range++;
    if (protectedRanges[range]?.[0] < from + match[0].length) continue;
    let slashes = 0;
    for (let i = from - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    if (slashes % 2) continue;
    tags.push({ id: match[1], from, to: from + match[0].length });
  }
  return tags;
}

/** 从后往前替换以保留源文档偏移。 / Replace backwards to preserve source offsets. */
export function replaceIconTags(
  text: string,
  tags: IconTag[],
  replacements: Map<string, string>,
): string {
  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i];
    const replacement = replacements.get(tag.id);
    if (replacement !== undefined)
      text = text.slice(0, tag.from) + replacement + text.slice(tag.to);
  }
  return text;
}
