// 静态检查：设置页组件里有没有 hook 引用「在它之后才声明」的变量。
//
// 这类错误在浏览器里表现为整页崩溃：
//   Cannot access 'rows' before initialization
// 因为 useCallback/useMemo 的工厂函数在 hook 阶段就被求值，而 const 声明还在下面。
// 这个坑在本项目已经踩过两次，所以用脚本挡住它。
//
// 精度处理：
//   · 先剥掉注释与字符串，避免把文档里的 "const x = ..." 当成真实声明；
//   · 忽略 hook 自己的形参；
//   · 只检查组件体内的顶层声明（2 空格缩进的 const/let/function）。
//
// 用法: node scripts/check-hooks.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'client', 'index.jsx');

const raw = readFileSync(SOURCE, 'utf8');
const lines = raw.split('\n');

/** Replace comments and string/template literals with spaces, preserving length
 *  and newlines so line numbers stay valid. */
function stripNoise(src) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (ch === "'") { state = 'single'; out += ' '; i += 1; continue; }
      if (ch === '"') { state = 'double'; out += ' '; i += 1; continue; }
      if (ch === '`') { state = 'template'; out += ' '; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // inside a quoted literal
    if (ch === '\\') { out += '  '; i += 2; continue; }
    const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (ch === closer) { state = 'code'; out += ' '; i += 1; continue; }
    out += ch === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

const code = stripNoise(raw).split('\n');

/**
 * Scope the analysis to the settings-page COMPONENT only.
 *
 * Scanning the whole file picks up `const t = ctx.locale.bind(NS)` inside the
 * unrelated `apply()` plugin entry and reports it as a later declaration — a
 * false positive that would make this check useless.
 */
const componentStart = code.findIndex((l) => /^function\s+TtsSection\s*\(/.test(l));
if (componentStart === -1) {
  console.error('[check-hooks] could not find the TtsSection component — update this script.');
  process.exit(2);
}
// The component ends at the first top-level closing brace after its opening
// line. Brace counting is fragile here (template literals contain braces), and
// this file's style puts every nested brace indented, so a column-0 `}` is a
// reliable terminator.
let componentEnd = code.length;
for (let i = componentStart + 1; i < code.length; i += 1) {
  if (/^\}/.test(code[i])) { componentEnd = i; break; }
}
if (componentEnd - componentStart < 50) {
  console.error(`[check-hooks] component body looks wrong (${componentStart + 1}..${componentEnd + 1}) — update this script.`);
  process.exit(2);
}

/**
 * Top-level declarations inside the component body (2-space indent).
 *
 * Scoped to the component on purpose: the outer `apply()` plugin entry also has
 * a 2-space `const t = ...`, and including it would report `t` (a prop here) as a
 * later declaration — a false positive that would make the check useless.
 * If the terminator were ever mis-detected, the size sanity check above fires
 * instead of silently narrowing the scan.
 */
const DECL = /^ {2}(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/;
const declLineOf = new Map();
for (let i = componentStart; i < componentEnd; i += 1) {
  const m = DECL.exec(code[i]);
  if (m && !declLineOf.has(m[1])) declLineOf.set(m[1], i);
}

const HOOK = /\bReact\.(useCallback|useMemo|useState|useEffect|useRef|useLayoutEffect)\s*\(/;

// Names that are not component-local state/props worth flagging.
const IGNORE = new Set([
  'React', 'window', 'document', 'console', 'Object', 'Array', 'JSON', 'String',
  'Number', 'Boolean', 'Math', 'Promise', 'Error', 'Map', 'Set', 'Date', 'RegExp',
  'undefined', 'null', 'true', 'false', 'return', 'if', 'else', 'function', 'const',
  'let', 'var', 'new', 'typeof', 'void', 'await', 'async', 'catch', 'try', 'finally',
  'for', 'while', 'switch', 'case', 'break', 'continue', 'default', 'throw', 'in', 'of',
]);

const problems = [];
let hooks = 0;

for (let i = 0; i < code.length; i += 1) {
  const m = HOOK.exec(code[i]);
  if (!m) continue;
  hooks += 1;

  // Balanced argument text of this hook call. Normalize the indentation first so
  // a multi-line hook still yields its identifiers on one logical line.
  let depth = 0;
  let body = '';
  for (let j = i; j < code.length; j += 1) {
    body += code[j].trim() + ' ';
    for (const ch of code[j]) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth <= 0) break;
  }

  // Hook's own parameters must not be treated as outer references.
  const ownParams = new Set();
  for (const pm of body.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of pm[1].split(',')) ownParams.add(name.trim());
  }
  for (const pm of body.matchAll(/\(([^()]*)\)\s*\{/g)) {
    for (const name of pm[1].split(',')) ownParams.add(name.trim());
  }

  const seen = new Set();
  for (const name of body.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
    if (seen.has(name) || IGNORE.has(name) || ownParams.has(name)) continue;
    seen.add(name);
    const decl = declLineOf.get(name);
    if (decl === undefined) continue;      // import / prop / global
    if (decl > i) problems.push({ hookLine: i + 1, hook: m[1], name, declLine: decl + 1 });
  }
}

if (problems.length === 0) {
  console.log(`[check-hooks] OK — ${hooks} hooks, none reads a later declaration`);
  process.exit(0);
}

console.error('[check-hooks] FAIL — a hook closes over something declared after it:');
for (const p of problems) {
  const where = p.declLine ? ` (declared at line ${p.declLine})` : '';
  console.error(`  line ${p.hookLine}: ${p.hook} -> '${p.name}'${where}`);
}
console.error('\nFix: derive it inline (no hook) or move the declaration above the hook.');
process.exit(1);
