// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, the three matching tiers, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` lines of section 2. */
  readonly moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Section 3: a file as lines ----------

interface FileModel {
  br: string;
  lines: string[];
  fin: boolean;
}

function fileModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br: '\n', lines: [], fin: false };
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { br, lines: parts, fin };
}

function serialize(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.fin ? m.br : '');
}

// ---------- Section 5: matching lines at three tiers ----------

const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const both = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trail(a) === trail(b) : both(a) === both(b);
}

/** Every start position at or after `from` where O occurs at `tier` (occurrences may overlap). */
function occAt(lines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with the occurrences there; null when it occurs at no tier. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occAt(lines, O, tier, from, eofOnly);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** A hunk or chunk body line: context, old, new, or a `\` marker referring to the line before it. */
type Item = { kind: 'ctx' | 'del' | 'add' | 'eol'; text: string; emptyLine?: boolean };

/**
 * The lines written where O matched at `pos`: context lines are the file's own matched lines, and at
 * tier 2 every other new line is re-indented from O's first line's indentation to the file's.
 */
function buildWritten(items: Item[], fileLines: string[], pos: number, tier: number): string[] {
  const oFirst = items.find((it) => it.kind === 'ctx' || it.kind === 'del');
  const F = pos < fileLines.length ? leadOf(fileLines[pos]!) : '';
  const P = oFirst ? leadOf(oFirst.text) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else if (it.kind === 'add') {
      let s = it.text;
      if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}

/** The same for a SEARCH/REPLACE block, whose new lines are all "other" lines. */
function buildPlain(O: string[], N: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return [...N];
  const F = leadOf(fileLines[pos]!);
  const P = leadOf(O[0]!);
  return N.map((s) => (s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(P) ? F + s.slice(P.length) : s));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastN(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') return items[i + 1]?.kind === 'eol';
  }
  return false;
}

// ---------- Section 6: unified diffs ----------

interface UHunk {
  a: number;
  items: Item[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path of a `---` or `+++` line: after the four characters, up to the first tab, spaces removed. */
function headPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  let p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function diffPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return m ? [m[1]!, m[2]!] : null;
}

function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m ? parseInt(m[1]!, 10) : null;
}

/** A hunk's body: the lines it is made of, and where the patch continues after it. */
function readBody(lines: string[], start: number): { items: Item[]; next: number } {
  const items: Item[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      items.push({ kind: 'ctx', text: '', emptyLine: true });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ') items.push({ kind: 'ctx', text: line.slice(1) });
    else if (c === '-') items.push({ kind: 'del', text: line.slice(1) });
    else if (c === '+') items.push({ kind: 'add', text: line.slice(1) });
    else if (c === '\\') items.push({ kind: 'eol', text: '' });
    else break;
    i += 1;
  }
  while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.emptyLine === true) items.pop();
  return { items, next: i };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let state: 'out' | 'head' | 'between' = 'out';
  let i = 0;
  const startSection = (): USection => {
    const s: USection = { diffOld: null, diffNew: null, headOld: undefined, headNew: undefined, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dp = diffPaths(line);
      if (dp === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = startSection();
      sec.diffOld = dp[0];
      sec.diffNew = dp[1];
      state = 'head';
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkStart(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = readBody(lines, i + 1);
      sec.hunks.push({ a, items: body.items });
      state = 'between';
      i = body.next;
      continue;
    }
    const isPair = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (isPair && state !== 'head') {
      sec = startSection();
      sec.headOld = headPath(line.slice(4));
      sec.headNew = headPath(lines[i + 1]!.slice(4));
      state = 'head';
      i += 2;
      continue;
    }
    if (state === 'head' && sec !== null) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          sec = sec.headOld === undefined ? sec : startSection();
          sec.headOld = headPath(line.slice(4));
          sec.headNew = headPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) sec.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP: string | null = sec.headOld !== undefined ? sec.headOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld;
    const newP: string | null = sec.headNew !== undefined ? sec.headNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew;
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    let kind: 'create' | 'delete' | 'move' | 'change';
    if (oldP === null && newP !== null) kind = 'create';
    else if (newP === null) kind = 'delete';
    else if (sec.newFile) kind = 'create';
    else if (sec.delFile) kind = 'delete';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';
    if (kind === 'create') {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const all: Item[] = [];
      for (const h of sec.hunks) for (const it of h.items) all.push(it);
      const texts = all.filter((it) => it.kind === 'add').map((it) => it.text);
      let fin = true;
      for (let k = all.length - 1; k >= 0; k -= 1) {
        if (all[k]!.kind === 'add') {
          fin = all[k + 1]?.kind !== 'eol';
          break;
        }
      }
      tree.now.set(p, serialize({ br: '\n', lines: texts, fin }));
      return;
    }
    if (kind === 'delete') {
      const p = oldP ?? '';
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const model = fileModel(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'del').map((it) => it.text);
      const nLen = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'add').length;
      if (O.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, model.lines.length));
        const atEnd = at === model.lines.length;
        const written = buildWritten(h.items, model.lines, at, 0);
        model.lines.splice(at, 0, ...written);
        if (atEnd) model.fin = !backslashAfterLastN(h.items);
      } else {
        const found = findTier(model.lines, O, strict);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let pos = found.occ[0]!;
        for (const q of found.occ) {
          if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
        }
        const written = buildWritten(h.items, model.lines, pos, found.tier);
        const atEnd = pos + O.length === model.lines.length;
        model.lines.splice(pos, O.length, ...written);
        if (atEnd) model.fin = !backslashAfterLastN(h.items);
      }
      d += nLen - O.length;
    }
    const text = serialize(model);
    if (kind === 'move') {
      tree.now.set(newP!, text);
      tree.now.set(p, null);
      tree.moves.push([p, newP!]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, serialize({ br: '\n', lines: b.newLines, fin: true }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = fileModel(before);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const written = buildPlain(b.oldLines, b.newLines, model.lines, pos, found.tier);
    model.lines.splice(pos, b.oldLines.length, ...written);
    tree.now.set(b.path, serialize(model));
  });
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function vSecStart(l: string): { kind: VSection['kind']; path: string } | null {
  if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).trim() };
  if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice(17).trim() };
  if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice(17).trim() };
  return null;
}

function parseVUpdate(sec: VSection, raw: { text: string; num: number }[]): void {
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    sec.moveTo = raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  let chunk: VChunk | null = null;
  let sawChunk = false;
  for (; idx < raw.length; idx += 1) {
    const r = raw[idx]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      const anchor = t.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      sec.chunks.push(chunk);
      sawChunk = true;
      continue;
    }
    if (t === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${r.num}`);
      chunk.eof = true;
      chunk = null;
      continue;
    }
    let item: Item | null = null;
    if (t === '') item = { kind: 'ctx', text: '' };
    else if (t[0] === ' ') item = { kind: 'ctx', text: t.slice(1) };
    else if (t[0] === '-') item = { kind: 'del', text: t.slice(1) };
    else if (t[0] === '+') item = { kind: 'add', text: t.slice(1) };
    if (item !== null) {
      if (chunk === null) {
        if (sawChunk) throw new Exit2(`error: parse ${r.num}`);
        chunk = { anchor: null, eof: false, items: [] };
        sec.chunks.push(chunk);
        sawChunk = true;
      }
      chunk.items.push(item);
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
}

function parseV4a(lines: string[]): VSection[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = lines.length - 1;
  while (lb > fb && blank(lines[lb]!)) lb -= 1;
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const st = vSecStart(line);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: st.kind, path: st.path, line: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    const raw: { text: string; num: number }[] = [];
    while (i < lb && vSecStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (sec.kind === 'delete') {
      for (const r of raw) throw new Exit2(`error: parse ${r.num}`);
    } else {
      parseVUpdate(sec, raw);
    }
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, serialize({ br: '\n', lines: sec.addLines, fin: true }));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = fileModel(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (lineEq(model.lines[k]!, ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const O = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'del').map((it) => it.text);
      if (O.length === 0) {
        const add = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...add);
        cursor = at + add.length;
      } else {
        const found = findTier(model.lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', sec.path);
        const pos = found.occ[0]!;
        const written = buildWritten(ch.items, model.lines, pos, found.tier);
        model.lines.splice(pos, O.length, ...written);
        cursor = pos + written.length;
      }
    }
    const text = serialize(model);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move whose old path is gone and whose new path is new prints as one `R` line, sorted by the new path.
  const moveTo = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) moveTo.set(n, o);
  }
  const moveFrom = new Set(moveTo.values());
  const keyed: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (now === null && moveFrom.has(p)) continue;
    keyed.push({ key: p, line: was === null && moveTo.has(p) ? `R ${moveTo.get(p)!} -> ${p}` : `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  const rows = keyed.map((k) => k.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
