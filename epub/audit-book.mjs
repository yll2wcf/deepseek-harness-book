import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const epubDir = path.dirname(fileURLToPath(import.meta.url));
const bookDir = path.dirname(epubDir);
const chaptersDir = path.join(bookDir, "chapters");
const chapterFiles = fs
  .readdirSync(chaptersDir)
  .filter((name) => /^\d{2}-.*\.md$/.test(name))
  .sort()
  .map((name) => path.join(chaptersDir, name));
const manuscriptFiles = [
  path.join(bookDir, "preface.md"),
  ...chapterFiles,
  path.join(bookDir, "conclusion.md"),
];

const errors = [];
const links = [];
const images = [];
let hanCharacters = 0;
let chapterHanCharacters = 0;

function recordError(file, message) {
  errors.push(`${path.relative(bookDir, file)}: ${message}`);
}

function headingIds(markdown) {
  const ids = new Set();
  const counts = new Map();
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    const explicit = match[1].match(/\s+\{#([^}]+)\}\s*$/);
    if (explicit) {
      ids.add(explicit[1]);
      continue;
    }
    const base = match[1]
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[\s]+/g, "-")
      .replace(/[^\p{Letter}\p{Number}_-]/gu, "")
      .replace(/^-+|-+$/g, "");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function splitTarget(rawTarget) {
  const withoutTitle = rawTarget
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/\s+["'].*["']\s*$/, "");
  const hash = withoutTitle.indexOf("#");
  if (hash === -1) return { pathname: withoutTitle, fragment: "" };
  return {
    pathname: withoutTitle.slice(0, hash),
    fragment: decodeURIComponent(withoutTitle.slice(hash + 1)),
  };
}

for (const [index, file] of manuscriptFiles.entries()) {
  const buffer = fs.readFileSync(file);
  const markdown = buffer.toString("utf8");
  const fileHanCharacters = markdown.match(/\p{Script=Han}/gu)?.length ?? 0;
  hanCharacters += fileHanCharacters;
  if (index > 0 && index <= chapterFiles.length) {
    chapterHanCharacters += fileHanCharacters;
  }

  if (markdown.includes("\r")) recordError(file, "contains CR characters");
  if (!markdown.endsWith("\n") || markdown.endsWith("\n\n")) {
    recordError(file, "must end with exactly one newline");
  }

  const lines = markdown.split("\n");
  lines.forEach((line, lineIndex) => {
    if (/[ \t]+$/.test(line)) {
      recordError(file, `line ${lineIndex + 1} has trailing whitespace`);
    }
  });

  let fence = null;
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!match) return;
    const marker = match[1][0];
    const length = match[1].length;
    if (!fence) {
      fence = { marker, length, line: lineIndex + 1 };
    } else if (fence.marker === marker && length >= fence.length) {
      fence = null;
    }
  });
  if (fence) recordError(file, `unclosed code fence from line ${fence.line}`);

  const h1 = lines.filter((line) => /^#\s+/.test(line));
  if (h1.length !== 1) recordError(file, `expected one H1, found ${h1.length}`);

  if (index > 0 && index <= chapterFiles.length) {
    const chapterNumber = index;
    if (!h1[0]?.startsWith(`# 第${chapterNumber}章`)) {
      recordError(file, `H1 does not match chapter ${chapterNumber}`);
    }
    const h2 = lines.filter((line) => /^##\s+/.test(line));
    if (!h2.at(-1)?.startsWith("## 本章回顾")) {
      recordError(file, "last H2 is not 本章回顾");
    }
  }

  for (const match of markdown.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
    const isImage = match[1] === "!";
    const alt = match[2];
    const rawTarget = match[3];
    const { pathname, fragment } = splitTarget(rawTarget);
    const entry = { file, pathname, fragment, alt };
    (isImage ? images : links).push(entry);

    if (/^[a-z][a-z0-9+.-]*:/i.test(pathname) || pathname.startsWith("//")) {
      continue;
    }

    let targetFile = file;
    if (pathname) {
      try {
        targetFile = path.resolve(path.dirname(file), decodeURIComponent(pathname));
      } catch {
        recordError(file, `cannot decode link target ${rawTarget}`);
        continue;
      }
      if (!fs.existsSync(targetFile)) {
        recordError(file, `missing target ${rawTarget}`);
        continue;
      }
    }

    if (isImage && !alt.trim()) recordError(file, `image ${rawTarget} has empty alt text`);
    if (fragment && targetFile.endsWith(".md")) {
      const targetMarkdown = fs.readFileSync(targetFile, "utf8");
      if (!headingIds(targetMarkdown).has(fragment)) {
        recordError(file, `missing anchor #${fragment} in ${path.relative(bookDir, targetFile)}`);
      }
    }
  }
}

const uniqueImages = new Set(images.map(({ file, pathname }) => path.resolve(path.dirname(file), pathname)));
const summary = {
  manuscriptFiles: manuscriptFiles.length,
  chapters: chapterFiles.length,
  hanCharacters,
  chapterHanCharacters,
  links: links.length,
  imageReferences: images.length,
  uniqueImages: uniqueImages.size,
  errors: errors.length,
};

console.log(JSON.stringify(summary, null, 2));
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
}
