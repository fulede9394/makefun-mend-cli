// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Successful moves, as (old path, new path) pairs, for the `R` output rows. */
  moves: [string, string][] = [];
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

// ---------- section 5: matching lines, and section 3: a file's lines ----------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}
/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, 1, 2; 0 only when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrencesAt(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** The first line at or after `from` equal to `single` at the first tier where one is. */
function findSingle(lines: string[], single: string, strict: boolean, from: number): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(single, lines[i]!, t)) return i;
    }
  }
  return null;
}

interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of N: a context line (write the file's own matched line at O index `o`) or a new line. */
type NItem = { ctx: true; o: number } | { ctx: false; text: string };
function buildReplacement(lines: string[], at: number, O: string[], N: NItem[], tier: number): string[] {
  const F = leadWS(lines[at] ?? '');
  const P = O.length > 0 ? leadWS(O[0]!) : '';
  return N.map((it) => {
    if (it.ctx) return lines[at + it.o]!;
    if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(P)) return F + it.text.slice(P.length);
    return it.text;
  });
}
function applyReplace(lines: string[], at: number, O: string[], N: NItem[], tier: number): string[] {
  const repl = buildReplacement(lines, at, O, N, tier);
  const out = lines.slice();
  out.splice(at, O.length, ...repl);
  return out;
}

/** Split a hunk/chunk body into its O lines and its N items (context lines keep their O index). */
function splitBody(body: BodyLine[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const it of body) {
    if (it.kind === ' ') {
      N.push({ ctx: true, o: O.length });
      O.push(it.text);
    } else if (it.kind === '-') {
      O.push(it.text);
    } else {
      N.push({ ctx: false, text: it.text });
    }
  }
  return { O, N };
}

/** One body line of a unified hunk or a V4A chunk; `noNl` says a `\` line followed it. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  body: BodyLine[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path after `--- ` or `+++ `, up to the first tab, spaces removed, a/ or b/ stripped; null is /dev/null. */
function dashPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s === '/dev/null') return null;
  return s;
}

function isDiffGit(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}
function isBodyLine(line: string): boolean {
  return line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;

  const finishSection = (): void => {
    if (cur === null) return;
    if (dashOld !== undefined) cur.oldPath = dashOld;
    else if (renameFrom !== undefined) cur.oldPath = renameFrom;
    if (dashNew !== undefined) cur.newPath = dashNew;
    else if (renameTo !== undefined) cur.newPath = renameTo;
    sections.push(cur);
    cur = null;
    inHeader = false;
  };
  const startSection = (oldPath: string | null, newPath: string | null): void => {
    finishSection();
    cur = { oldPath, newPath, isCreate: false, isDelete: false, hunks: [] };
    inHeader = true;
    dashOld = undefined;
    dashNew = undefined;
    renameFrom = undefined;
    renameTo = undefined;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (isDiffGit(b)) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(b)) break;
        if (b.startsWith('\\')) {
          const last = hunk.body[hunk.body.length - 1];
          if (last !== undefined) last.noNl = true;
          i += 1;
          continue;
        }
        const kind = b === '' ? ' ' : (b[0] as ' ' | '-' | '+');
        hunk.body.push({ kind, text: b === '' ? '' : b.slice(1), noNl: false });
        i += 1;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && inHeader) {
          if (dashOld === undefined) {
            dashOld = dashPath(line);
            dashNew = dashPath(next);
          }
          i += 2;
          continue;
        }
        startSection(null, null);
        dashOld = dashPath(line);
        dashNew = dashPath(next);
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (renameFrom === undefined) renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (renameTo === undefined) renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  finishSection();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** The last context or `+` line of a hunk body, and whether a `\` line followed it. */
function lastCtxPlusNoNl(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const it = body[k]!;
    if (it.kind === ' ' || it.kind === '+') return it.noNl;
  }
  return false;
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length === 0) {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      const ins = N.map((it) => (it.ctx ? '' : it.text));
      f.lines.splice(pos, 0, ...ins);
      if (atEnd && ins.length > 0) f.final = !lastCtxPlusNoNl(h.body);
      d += N.length;
      continue;
    }
    const found = findTier(f.lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        at = p;
        best = dist;
      }
    }
    const endsAtEnd = at + O.length >= f.lines.length;
    const noNl = lastCtxPlusNoNl(h.body);
    f.lines = applyReplace(f.lines, at, O, N, found.tier);
    if (endsAtEnd) f.final = !noNl;
    d += N.length - O.length;
  }
  return joinFile(f);
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.oldPath;
    const newPath = sec.newPath;
    const isCreate = sec.isCreate || oldPath === null;
    const isDelete = !isCreate && (sec.isDelete || newPath === null);
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastNoNl = false;
      for (const h of sec.hunks) {
        for (const it of h.body) {
          if (it.kind === '+') {
            out.push(it.text);
            lastNoNl = it.noNl;
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (lastNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldPath ?? '';
    const newP = newPath ?? '';
    if (oldP === newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, applyHunks(cur, sec.hunks, strict, oldP));
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const result = applyHunks(cur, sec.hunks, strict, oldP);
    tree.now.set(newP, result);
    tree.now.set(oldP, null);
    tree.moves.push([oldP, newP]);
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const N: NItem[] = newLines.map((t) => ({ ctx: false, text: t }) as NItem);
    f.lines = applyReplace(f.lines, at, oldLines, N, found.tier);
    tree.now.set(path, joinFile(f));
  };
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i += 1;
    const start = i;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      i += 1;
    }
    const secLines: { text: string; num: number }[] = [];
    for (let k = start; k < i; k++) secLines.push({ text: lines[k]!, num: k + 1 });
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, secLines));
    else if (kind === 'delete') edits.push(v4aDeleteEdit(path, secLines));
    else edits.push(v4aUpdateEdit(path, secLines, headerLine, strict));
  }
  return edits;
}

function v4aAddEdit(path: string, secLines: { text: string; num: number }[]): Edit {
  const out: string[] = [];
  for (const { text, num } of secLines) {
    if (text.startsWith('+')) out.push(text.slice(1));
    else if (text === '') out.push('');
    else throw new Exit2(`error: parse ${num}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string, secLines: { text: string; num: number }[]): Edit {
  for (const { num } of secLines) throw new Exit2(`error: parse ${num}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, secLines: { text: string; num: number }[], headerLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to:')) {
    moveTo = secLines[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let started = false;
  for (; idx < secLines.length; idx++) {
    const { text, num } = secLines[idx]!;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), body: [], eof: false };
      started = true;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (started) {
          if (text === '') continue;
          throw new Exit2(`error: parse ${num}`);
        }
        cur = { anchor: null, body: [], eof: false };
        started = true;
      }
      const kind = text === '' ? ' ' : (text[0] as ' ' | '-' | '+');
      cur.body.push({ kind, text: text === '' ? '' : text.slice(1), noNl: false });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const a = findSingle(f.lines, ch.anchor, strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      const { O, N } = splitBody(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = N.map((it) => (it.ctx ? '' : it.text));
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findTier(f.lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at = found.occ[0]!;
      if (ch.eof) {
        const ok = found.occ.filter((p) => p + O.length === f.lines.length);
        if (ok.length === 0) throw new Fail('no-match', path);
        at = ok[0]!;
      }
      f.lines = applyReplace(f.lines, at, O, N, found.tier);
      cursor = at + N.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
