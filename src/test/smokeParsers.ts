import * as path from 'node:path';
import { setWasmRoot, parseSource } from '../parsers/treeSitter';
import { extractTypeScript } from '../parsers/typescript';
import { extractPython } from '../parsers/python';
import { extractJava } from '../parsers/java';
import { SymbolFlag, SymbolKind } from '../index/types';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  setWasmRoot(path.resolve(__dirname, '..', 'resources', 'wasm'));

  // ---- TypeScript ----
  const tsSource = `
export class User {}
export function greet(): string { return 'hi'; }
export const x = 1, y = 2;
export type UserId = number;
export interface IUser {}
export enum Color { Red, Green }
export default class DefaultCls {}
export { Foo, Bar as Baz } from './other';
export * from './barrel';
export * as NS from './ns';
export type { SomeType } from './types';
`;
  const tsTree = await parseSource('typescript', tsSource);
  const tsRes = extractTypeScript(tsTree);
  const names = tsRes.exports.map((e) => e.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['Color', 'DefaultCls', 'IUser', 'User', 'UserId', 'greet', 'x', 'y']),
    `TS exports mismatch: ${JSON.stringify(names)}`,
  );
  assert(
    tsRes.exports.find((e) => e.name === 'DefaultCls')?.flags === SymbolFlag.DefaultExport,
    'DefaultCls should be DefaultExport',
  );
  assert(
    tsRes.exports.find((e) => e.name === 'UserId')?.kind === SymbolKind.TypeAlias,
    'UserId should be TypeAlias',
  );
  assert(tsRes.reExports.length >= 4, `TS re-exports expected >=4, got ${tsRes.reExports.length}`);
  const starAll = tsRes.reExports.find((r) => r.fromPath === './barrel' && r.names === 'all');
  assert(starAll !== undefined, 'star re-export from ./barrel expected');
  const aliased = tsRes.reExports.find((r) => r.fromPath === './other');
  assert(
    aliased !== undefined && aliased.names !== 'all' && aliased.names.some((n) => n.exportedName === 'Baz' && n.sourceName === 'Bar'),
    'aliased re-export Bar as Baz expected',
  );
  console.log(`TS ok — ${tsRes.exports.length} exports, ${tsRes.reExports.length} re-exports`);

  // ---- Python ----
  const pySource = `
__all__ = ['User', 'greet', 'CONFIG']

CONFIG = {'key': 'value'}

def greet():
    pass

class User:
    pass

def _private():
    pass

class Internal:
    pass

from .sub import SubClass, Helper as H
from .utils import *
`;
  const pyTree = await parseSource('python', pySource);
  const pyRes = extractPython(pyTree, true);
  const pyNames = pyRes.exports.map((e) => e.name).sort();
  assert(
    JSON.stringify(pyNames) === JSON.stringify(['CONFIG', 'User', 'greet']),
    `Python __all__ filter failed: ${JSON.stringify(pyNames)}`,
  );

  const pyResNoAll = extractPython(pyTree, false);
  const pyNamesNoAll = pyResNoAll.exports.map((e) => e.name).sort();
  assert(
    pyNamesNoAll.includes('Internal') && !pyNamesNoAll.includes('_private'),
    `Python no-__all__ should include Internal and exclude _private: ${JSON.stringify(pyNamesNoAll)}`,
  );

  assert(pyRes.reExports.length >= 2, `Python re-exports expected >=2, got ${pyRes.reExports.length}`);
  const subRe = pyRes.reExports.find((r) => r.fromPath === '.sub');
  assert(subRe !== undefined && subRe.names !== 'all', '.sub re-export expected');
  const utilsStar = pyRes.reExports.find((r) => r.fromPath === '.utils' && r.names === 'all');
  assert(utilsStar !== undefined, '.utils wildcard re-export expected');
  console.log(`Python ok — ${pyRes.exports.length} exports, ${pyRes.reExports.length} re-exports`);

  // ---- Java ----
  const javaSource = `
package com.example;

public class Outer {
    public static class Inner {}
    public static final class Config {}
    public class NonStaticInner {}
    private static class PrivateInner {}
    public static int CONST = 1;
}

class NonPublic {}

public interface IFoo {
    public static interface Nested {}
}

public enum Color { RED, GREEN, BLUE }

public record Point(int x, int y) {}
`;
  const javaTree = await parseSource('java', javaSource);
  const javaRes = extractJava(javaTree, true);
  const javaNames = javaRes.exports.map((e) => e.parentQualifier ? `${e.parentQualifier}.${e.name}` : e.name).sort();
  assert(
    javaNames.includes('Outer') &&
      javaNames.includes('Outer.Inner') &&
      javaNames.includes('Outer.Config') &&
      javaNames.includes('IFoo') &&
      javaNames.includes('IFoo.Nested') &&
      javaNames.includes('Color') &&
      javaNames.includes('Point'),
    `Java expected Outer, Outer.Inner, Outer.Config, IFoo, IFoo.Nested, Color, Point. Got: ${JSON.stringify(javaNames)}`,
  );
  assert(
    !javaNames.includes('NonPublic') && !javaNames.includes('Outer.NonStaticInner') && !javaNames.includes('Outer.PrivateInner'),
    `Java should exclude non-public / non-static inner: ${JSON.stringify(javaNames)}`,
  );

  const javaResNoInner = extractJava(javaTree, false);
  const hasInner = javaResNoInner.exports.some((e) => e.parentQualifier !== undefined);
  assert(!hasInner, 'Java with includeInner=false should have no inner classes');
  console.log(`Java ok — ${javaRes.exports.length} exports (inner=on), ${javaResNoInner.exports.length} (inner=off)`);

  console.log('OK — all parsers');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
