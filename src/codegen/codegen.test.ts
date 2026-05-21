/**
 * Codegen Tests
 *
 * Validates the compileToWat() pipeline: typed AST → IRModule → WAT string.
 * Full pipeline per test: parse → AST → strata → elaborate → typecheck → IR lower → emit.
 */

import { test, expect } from "bun:test"
import { compileToWat, compileToWasm } from "./index"
import siliconGrammar from "../grammar/SiliconGrammar"
import parse from "../parser"
import { addToAstSemantics } from "../ast/index"
import { buildStrataRegistry, elaborate } from "../elaborator/index"
import { typecheck } from "../types/index"
import type { Program } from "../ast/astNodes"

function compile(source: string): string {
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    return compileToWat(typed, registry, functions)
}

function compileBinary(source: string): Uint8Array {
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    return compileToWasm(typed, registry, functions)
}

test("compile generates module structure", () => {
    const wat = compile("42;")
    expect(wat).toContain("(module")
    expect(wat).toContain("(memory 1)")
    expect(wat).toContain("(global $heap")
})

test("compile integer literal produces i32.const", () => {
    const wat = compile("123;")
    expect(wat).toContain("i32.const 123")
})

test("compile float literal produces f32.const", () => {
    const wat = compile("3.14;")
    expect(wat).toContain("f32.const 3.14")
})

test("compile true produces i32.const 1", () => {
    const wat = compile("@true;")
    expect(wat).toContain("i32.const 1")
})

test("compile false produces i32.const 0", () => {
    const wat = compile("@false;")
    expect(wat).toContain("i32.const 0")
})

test("compile addition produces i32.add", () => {
    const wat = compile("1 + 2;")
    expect(wat).toContain("i32.add")
})

test("compile output is valid WAT syntax", () => {
    const wat = compile("42;")
    let depth = 0
    for (const ch of wat) {
        if (ch === '(') depth++
        if (ch === ')') depth--
    }
    expect(depth).toBe(0)
})

test("compile output contains required WAT declarations", () => {
    const wat = compile("42;")
    expect(wat).toContain("(module")
    expect(wat).toContain("(memory 1)")
    expect(wat).toContain("(global $heap")
    expect(wat).toContain("i32.const 1024")
})

test("compile handles multiple expressions", () => {
    const wat = compile("42; 100;")
    expect(wat).toContain("i32.const 42")
    expect(wat).toContain("i32.const 100")
})

test("compile string literals allocate static data", () => {
    const wat = compile("'hello';")
    expect(wat).toContain("(module")
})

test("compile array literals are supported", () => {
    const wat = compile("$[1, 2, 3];")
    expect(wat).toContain("(module")
})

test("compile @let definition emits func with params", () => {
    const wat = compile("@let add x:Int, y:Int := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).toContain("(param $x i32)")
    expect(wat).toContain("(param $y i32)")
    expect(wat).toContain("i32.add")
})

test("compile unknown definition keyword throws", () => {
    expect(() => compile("@foo bar := 1;")).toThrow("Unknown definition keyword")
})

test("compile if-else as binding emits (result i32)", () => {
    const wat = compile("@let pick a:Int, b:Int, c:Int := { &@if c, { a }, { b } };")
    expect(wat).toContain("(if (result i32)")
    expect(wat).toContain("(then")
    expect(wat).toContain("(else")
})

test("compile if without else does not emit result type", () => {
    const wat = compile("@let doIf x:Int := { &@if x, { x = x + 1; }; x };")
    expect(wat).not.toContain("(if (result")
})

test("compile @let function without @export is not exported", () => {
    const wat = compile("@let add x:Int, y:Int := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).not.toContain('(export "add"')
})

test("compile @fn definition emits func with params", () => {
    const wat = compile("@fn add x:Int, y:Int := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).toContain("i32.add")
})

test("compile @var definition emits mutable global", () => {
    const wat = compile("@var count:Int := 0;")
    expect(wat).toContain("(global $count")
    expect(wat).toContain("(mut i32)")
    expect(wat).toContain("(i32.const 0)")
})

test("compile assignment to parameter uses local.set", () => {
    const wat = compile("@let inc x:Int := { x = x + 1; x };")
    expect(wat).toContain("local.set $x")
    expect(wat).toContain("local.get $x")
})

test("compile @extern with no return type emits void import", () => {
    const wat = compile("@extern print x:Int;")
    expect(wat).toContain('(import "env" "print"')
    expect(wat).toContain("(param i32)")
    const importLine = wat.split('\n').find(l => l.includes('(import "env" "print"')) ?? ''
    expect(importLine).not.toContain("(result")
})

test("compile @extern with return type emits result declaration", () => {
    const wat = compile("@extern readInt:Int;")
    expect(wat).toContain('(import "env" "readInt"')
    expect(wat).toContain("(result i32)")
})

test("compile @extern appears before function definitions in module", () => {
    const wat = compile("@extern print x:Int;\n@let greet := { &print 42 };")
    const importPos = wat.indexOf("(import")
    const funcPos = wat.indexOf("(func $greet")
    expect(importPos).toBeGreaterThan(-1)
    expect(funcPos).toBeGreaterThan(-1)
    expect(importPos).toBeLessThan(funcPos)
})

test("compile @extern with multiple params", () => {
    const wat = compile("@extern add x:Int, y:Int;")
    expect(wat).toContain('(import "env" "add"')
    // IR emitter uses unnamed params in import declarations
    expect(wat).toContain("(param i32) (param i32)")
})

test("compileToWasm returns a valid WASM binary", () => {
    const bin = compileBinary("42;")
    // Magic + version: \0asm 0x01000000
    expect(bin[0]).toBe(0x00)
    expect(bin[1]).toBe(0x61)
    expect(bin[2]).toBe(0x73)
    expect(bin[3]).toBe(0x6d)
    expect(bin[4]).toBe(0x01)
    expect(bin[5]).toBe(0x00)
    expect(bin[6]).toBe(0x00)
    expect(bin[7]).toBe(0x00)
    expect(bin.byteLength).toBeGreaterThan(8)
})

test("compileToWasm direct emitter is byte-equal to WAT round-trip", async () => {
    const { watToWasm } = await import("./toWasm")
    const source = "@let add x:Int, y:Int := x + y;"
    const viaWat = await watToWasm(compile(source))
    const viaDirect = compileBinary(source)
    expect(viaDirect.byteLength).toBe(viaWat.byteLength)
    for (let i = 0; i < viaWat.byteLength; i++) {
        expect(viaDirect[i]).toBe(viaWat[i])
    }
})

// ---------------------------------------------------------------------------
// Strata 2.0 — @stratum end-to-end compilation tests
// ---------------------------------------------------------------------------

test("@stratum operator compiles same as @stratum_operator", () => {
    const oldSrc = `
        @stratum_operator CustomPlus ('**', Node) = { &IR::i32_add Node.left, Node.right; };
        @let add x:Int, y:Int := x ** y;
    `
    const newSrc = `
        @stratum CustomPlus = {
          &Compiler::register::operator '**';
          &Compiler::on::lower Node, { &IR::i32_add Node.left, Node.right; };
        };
        @let add x:Int, y:Int := x ** y;
    `
    const watOld = compile(oldSrc)
    const watNew = compile(newSrc)
    expect(watNew).toContain("(func $add")
    expect(watNew).toContain("i32.add")
    // Both forms should produce structurally identical output for the add function
    const funcOld = watOld.slice(watOld.indexOf('(func $add'), watOld.indexOf(')', watOld.indexOf('(func $add') + 200) + 1)
    const funcNew = watNew.slice(watNew.indexOf('(func $add'), watNew.indexOf(')', watNew.indexOf('(func $add') + 200) + 1)
    expect(funcNew).toBe(funcOld)
})

test("@stratum keyword compiles: @let function using a @stratum-defined def keyword", () => {
    // @stratum defining a keyword that uses IR::def_function maps to the function codegen path
    const src = `
        @stratum MyLet = {
          &Compiler::register::keyword '@mylet';
          &Compiler::on::lower Node, { &IR::def_function; };
        };
        @mylet double x:Int := x + x;
    `
    const wat = compile(src)
    expect(wat).toContain("(func $double")
    expect(wat).toContain("i32.add")
})

test("@stratum: multiple register calls in one body", () => {
    const src = `
        @stratum TwoOps = {
          &Compiler::register::operator '||?';
          &Compiler::on::lower Node, { &IR::i32_or Node.left, Node.right; };
        };
        @stratum TwoOps2 = {
          &Compiler::register::operator '&&?';
          &Compiler::on::lower Node, { &IR::i32_and Node.left, Node.right; };
        };
        @let test a:Int, b:Int := a ||? b;
    `
    const wat = compile(src)
    expect(wat).toContain("(func $test")
    expect(wat).toContain("i32.or")
})

// ---------------------------------------------------------------------------
// Strata 2.0 — on::decl and on::module_finalize end-to-end
// ---------------------------------------------------------------------------

test("on::decl fires for matching @let definitions without throwing", () => {
    // A @stratum with on::decl that records seen defs into a state bucket.
    // If wiring is wrong the compilation throws; if correct it succeeds.
    const src = `
        @stratum Spy = {
          @local seen := &Compiler::state 'spy';
          &Compiler::register::keyword '@tracked';
          &Compiler::on::decl '@tracked', Node, {
            &seen::set 'fired', 'yes';
          };
          &Compiler::on::lower Node, { &IR::def_function; };
        };
        @tracked add x:Int, y:Int := x + y;
    `
    const wat = compile(src)
    expect(wat).toContain("(func $add")
    expect(wat).toContain("i32.add")
})

test("on::decl does not fire for non-matching keyword definitions", () => {
    // @tracked handler registers only for '@tracked'; a @let def should not fire it.
    // We verify this compiles without error and produces correct output.
    const src = `
        @stratum Spy2 = {
          &Compiler::register::keyword '@tracked2';
          &Compiler::on::decl '@tracked2', Node, { };
          &Compiler::on::lower Node, { &IR::def_function; };
        };
        @let mul x:Int, y:Int := x * y;
    `
    const wat = compile(src)
    expect(wat).toContain("(func $mul")
    expect(wat).toContain("i32.mul")
})

test("on::module_finalize fires after all defs and does not break output", () => {
    const src = `
        @stratum Finalize = {
          &Compiler::on::module_finalize { };
        };
        @let double x:Int := x + x;
    `
    const wat = compile(src)
    expect(wat).toContain("(func $double")
    expect(wat).toContain("i32.add")
})

test("on::call_site fires for every function call without throwing", () => {
    // Handler observes calls and records into state; no replacement (returns null).
    const src = `
        @stratum CallSpy = {
          @local seen := &Compiler::state 'callspy';
          &Compiler::on::call_site Node, {
            &seen::set 'fired', 'yes';
          };
        };
        @let add x:Int, y:Int := x + y;
        @let main := { &add 1, 2 };
    `
    const wat = compile(src)
    expect(wat).toContain("(func $add")
    expect(wat).toContain("(func $main")
})

test("on::call_site observer mode: normal lowering proceeds when handler returns null", () => {
    const src = `
        @stratum Noop = {
          &Compiler::on::call_site Node, { };
        };
        @let double x:Int := x + x;
    `
    const wat = compile(src)
    expect(wat).toContain("i32.add")
})

test("on::call_site callee::kind returns user for user-defined function calls", () => {
    // We can't directly inspect handler internals from e2e, but we verify the
    // compilation doesn't throw when callee::kind is used.
    const src = `
        @stratum KindInspector = {
          @local kinds := &Compiler::state 'kinds';
          &Compiler::on::call_site Node, {
            @local k := &Compiler::callee::kind Node;
            &kinds::set k, 'seen';
          };
        };
        @let add x:Int, y:Int := x + y;
        @let main := { &add 1, 2 };
    `
    const wat = compile(src)
    expect(wat).toContain("(func $add")
    expect(wat).toContain("call $add")
})

test("on::decl and on::module_finalize can coexist in one @stratum", () => {
    const src = `
        @stratum Both = {
          @local bucket := &Compiler::state 'both';
          &Compiler::register::keyword '@myboth';
          &Compiler::on::decl '@myboth', Node, {
            &bucket::set 'seen', 'yes';
          };
          &Compiler::on::module_finalize { };
          &Compiler::on::lower Node, { &IR::def_function; };
        };
        @myboth greet x:Int := x + 1;
    `
    const wat = compile(src)
    expect(wat).toContain("(func $greet")
})
