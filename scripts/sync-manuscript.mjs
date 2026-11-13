import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.resolve(root, '../deepseek-harness-book');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'book.json'), 'utf8'));
const sourceBase = `${meta.source_repository}/blob/${meta.source_commit}/`;
const files = ['preface.md', 'conclusion.md', 'epub/00-trial-notice.md', 'epub/style.css',
  ...fs.readdirSync(path.join(source, 'chapters')).filter(f => f.endsWith('.md')).map(f => `chapters/${f}`),
  ...fs.readdirSync(path.join(source, 'assets')).filter(f => /\.(svg|png)$/.test(f)).map(f => `assets/${f}`),
  'epub/cover.svg', 'epub/cover.png'];

for (const rel of files) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), {recursive:true});
  const content = fs.readFileSync(path.join(source, rel));
  if (!rel.endsWith('.md')) { fs.writeFileSync(dest, content); continue; }
  let text = content.toString('utf8');
  text = text.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, (all, label, target) => {
    if (target.startsWith('../../../')) return `[${label}](${sourceBase}${target.slice(9)})`;
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return all;
    const oldTarget = path.resolve(path.dirname(path.join(source, rel)), target.split('#')[0]);
    const oldLab = path.relative(path.dirname(source), oldTarget);
    const legacy = path.join(root, 'examples/legacy/upstream-tmp', oldLab);
    if (/^(?:cordis|session-event|llm-request|agent-loop|tool-pipeline|agent-continuity)-tutorial(?:[/\\]|$)/.test(oldLab)
      && fs.existsSync(legacy)) {
      return `[${label}](${path.relative(path.dirname(dest), legacy).split(path.sep).join('/')})`;
    }
    const actual = path.resolve(path.dirname(path.join(root, rel)), target.split('#')[0]);
    // Preserve chapter navigation and images; authoring notes stay out of public book.
    if (/^(?:\.\.\/)?(?:chapters\/)?\d{2}-[^/]+\.md(?:#.*)?$/.test(target)
      || ['preface.md', 'conclusion.md'].includes(path.basename(actual))) return all;
    return label;
  });
  fs.writeFileSync(dest, text);
}
console.log(`Synced ${files.length} explicit manuscript/image files; runtime data excluded.`);
