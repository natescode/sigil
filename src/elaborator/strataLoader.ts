/**
 * Strata Loader
 *
 * Responsible for building the ElaboratorRegistry from strata definitions.
 * This is a distinct phase from AST elaboration: the loader EVALUATES strata
 * (parses .si files, transforms Elaboration nodes into StrataNodes, registers
 * them) so the elaborator can consume the result as a plain data structure.
 *
 * Pipeline position: between AST construction and elaboration.
 *
 *   Parse → AST → buildStrataRegistry → elaborate(ast, registry) → TypeCheck → Codegen
 *
 * Keeping this separate from the elaborator means:
 * - The elaborator is a pure AST walker with no embedded mini-compiler.
 * - Future Strata phases (type-level, macro expansion) can be added here
 *   without touching the elaboration walk.
 */

import {
  type Program,
  type Elaboration,
} from '../ast/astNodes'
import {
  createElaboratorRegistry,
  registerElaborator,
  registerTypedOperator,
  registerTypedKeyword,
  registerDefExpander,
  type ElaboratorRegistry,
} from './registry'
import { StrataType, type StrataNode, type StrataData, strataTypeFromIntrinsic } from './strataenum'
import { intrinsicSignature } from '../types/intrinsicSig'
import { registerDefKind, type CodegenKind } from './defkinds'
import { getIRKind } from '../ir/irKinds'
import { loadBuiltinStrata } from '../strata/index'
import { builtinDefExpanders } from '../strata/defExpanders'
import {
  isRichBody,
  compileBodyToDefExpander,
  compileBodyToExpanderFn,
  compileBodyToDeclHandler,
  compileBodyToFinalizeHandler,
  compileBodyToCallSiteHandler,
} from './strataBody'
import { createStateBucket } from '../compiler-api'
import { registerExpander } from './registry'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an ElaboratorRegistry from all strata visible in the program.
 *
 * Three sources are processed in order (later entries override earlier ones):
 *   1. Built-in strata from .si files in src/strata/ (always loaded first).
 *   2. Extra strata sources — Silicon source strings from external strata
 *      files loaded by the caller (e.g. via the --strata CLI flag).
 *   3. Inline user-defined @stratum_operator / @stratum_keyword definitions
 *      found in the top-level elements of `ast`.
 *
 * @param ast          The user's parsed program AST.
 * @param extraSources Optional Silicon source strings to mine for strata
 *                     definitions before processing the program AST.
 *                     Each string is the full contents of a strata .si file.
 */
export function buildStrataRegistry(
  ast: Program,
  extraSources: string[] = [],
): ElaboratorRegistry {
  const registry = createElaboratorRegistry()

  // Phase A: built-in strata from .si files.
  for (const elab of parseBuiltinStrata()) {
    registerElaboration(registry, elab)
  }

  // Phase B: external strata files supplied by the caller.
  for (const source of extraSources) {
    for (const elab of parseStrataSource(source)) {
      registerElaboration(registry, elab)
    }
  }

  // Phase C: inline user-defined strata from the program AST.
  for (const element of ast.elements as any[]) {
    let elab: Elaboration | undefined
    if (element.type === 'Elaboration') {
      elab = element as Elaboration
    } else if (element.type === 'Element' && element.kind === 'elaboration') {
      elab = element.value as Elaboration
    }
    if (elab) registerElaboration(registry, elab)
  }

  // Phase D: register built-in definition expanders (definition-kind lowering hooks).
  // Only registers if a strata rich body hasn't already claimed the codegen kind —
  // rich bodies win so users can override built-in behaviour from Silicon.
  for (const [codegenKind, exp] of Object.entries(builtinDefExpanders)) {
    if (!registry.defExpanders.has(codegenKind)) {
      registerDefExpander(registry, codegenKind, exp)
    }
  }

  return registry
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Register a single Elaboration node into the registry. */
function registerElaboration(registry: ElaboratorRegistry, elab: Elaboration): void {
  if (elab.kind === 'stratum') {
    registerStratumDef(registry, elab)
    return
  }
  const baseNode = elaborationToStrataNode(elab)
  const symbol = symbolToString(elab.symbol)
  const sig = baseNode.data?.typeSignature

  if (elab.kind === 'operator' && sig && sig.params.length > 0) {
    const typeKind = sig.params[0].kind  // 'Int', 'Float', 'Bool', etc.

    // Tag as Constraint when another variant of this symbol is already registered.
    const isConstraint = registry.operators[symbol] != null
    const node: StrataNode = isConstraint
      ? { ...baseNode, type: StrataType.Constraint }
      : baseNode

    // Store under compound typed key (e.g. '+:Float').
    registerTypedOperator(registry, symbol, typeKind, node)

    // Also set as the primary entry if this is the first registration for this symbol.
    if (!registry.operators[symbol]) {
      registerElaborator(registry, 'operator', symbol, baseNode)
    }
  } else if (elab.kind === 'keyword' && sig && sig.params.length > 0) {
    const typeKind = sig.params[0].kind  // 'Int', 'Float', etc.

    // Tag as Constraint when another variant of this keyword is already registered.
    const isConstraint = registry.keywords[symbol] != null
    const node: StrataNode = isConstraint
      ? { ...baseNode, type: StrataType.Constraint }
      : baseNode

    // Store under compound typed key (e.g. '@toFloat:Int').
    registerTypedKeyword(registry, symbol, typeKind, node)

    // Also set as the primary entry if this is the first registration for this keyword.
    if (!registry.keywords[symbol]) {
      registerElaborator(registry, 'keyword', symbol, baseNode)
    }
  } else {
    // No type constraint: plain registration (last-one-wins primary).
    registerElaborator(registry, elab.kind, symbol, baseNode)
  }

  const codegenKind = codegenKindFromIntrinsic(baseNode.data?.intrinsic)
  if (codegenKind) {
    registerDefKind(registry.defKinds, {
      keyword: symbol,
      codegenKind,
      allowsParams: codegenKind === 'function' || codegenKind === 'extern',
      allowsBinding: codegenKind !== 'extern' && codegenKind !== 'export',
      allowsGenerics: codegenKind === 'function',
    })
  }

  // Rich body: contains &Compiler:: calls or @local bindings.  Compile the
  // body into a closure and register it.  Definition-kind bodies override
  // the hardcoded TS def expander (if any); other bodies become an
  // IRExpanderFn keyed on the intrinsic.
  if (isRichBody(elab.semantics)) {
    const nodeParamName = elab.nodeParamName
    if (codegenKind) {
      registry.defExpanders.set(codegenKind, compileBodyToDefExpander(elab.semantics, nodeParamName))
    } else if (baseNode.data?.intrinsic) {
      registry.expanders.set(baseNode.data.intrinsic, compileBodyToExpanderFn(elab.semantics, nodeParamName))
    }
  }
}

/** Parse a Silicon source string and return all Elaboration nodes found. */
function parseStrataSource(source: string): Elaboration[] {
  const match = parse(source)
  const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
  return (ast.elements as any[]).filter(el => el.type === 'Elaboration') as Elaboration[]
}

/** Built-in strata loaded from .si files in src/strata/. */
function parseBuiltinStrata(): Elaboration[] {
  return parseStrataSource(loadBuiltinStrata())
}

/** Normalize an Elaboration symbol to a plain string. */
function symbolToString(symbol: any): string {
  if (typeof symbol === 'string') return symbol
  if (symbol && symbol.type === 'StringLiteral') return symbol.value
  return String(symbol)
}

/** Map an IR::def_* or IR::meta_* intrinsic to the corresponding codegen kind. */
function codegenKindFromIntrinsic(intrinsic: string | undefined): CodegenKind | undefined {
  return getIRKind(intrinsic ?? '')?.codegenKind
}

/**
 * Convert an Elaboration AST node to a StrataNode.
 * Extracts the WASM intrinsic and body template from the body so downstream
 * phases (codegen, type checker) can use them without re-walking the AST.
 * The raw body AST is NOT stored — only the derived data is kept.
 */
function elaborationToStrataNode(elaboration: Elaboration): StrataNode {
  const intrinsic = extractIntrinsicFromBody(elaboration.semantics)
  const bodyTemplate = extractBodyTemplate(elaboration.semantics as any, elaboration.nodeParamName)
  const kind = elaboration.kind as 'operator' | 'keyword'
  const data: StrataData = {
    nodeParamName: elaboration.nodeParamName,
    intrinsic,
    bodyTemplate,
    typeSignature: intrinsic ? intrinsicSignature(intrinsic) : undefined,
  }
  return {
    type: strataTypeFromIntrinsic(intrinsic, kind),
    discriminant: symbolToString(elaboration.symbol),
    data,
  }
}

/**
 * Walk the strata body AST and extract ALL WASM function calls as an ordered
 * sequence of steps.  Each step captures the intrinsic name and which node
 * references (left / right) appear as explicit arguments.
 *
 * Steps with no argRefs implicitly consume the top of the WAT operand stack
 * (i.e. the result produced by the previous step).
 */
function extractBodyTemplate(
  body: any,
  nodeParamName: string
): StrataData['bodyTemplate'] {
  if (!body || !Array.isArray(body.items)) return undefined
  const steps: NonNullable<StrataData['bodyTemplate']> = []
  for (const item of body.items) {
    if (!item || typeof item !== 'object') continue
    const fc = findFunctionCall(item.value ?? item)
    if (!fc) continue

    const argRefs = (fc.args ?? []).map((arg: any): 'left' | 'right' | 'unknown' => {
      const ns = findNamespace(arg)
      if (!ns) return 'unknown'
      const nsStr = (ns.path as string[]).join('.')
      if (nsStr === `${nodeParamName}.left`) return 'left'
      if (nsStr === `${nodeParamName}.right`) return 'right'
      return 'unknown'
    })

    const name = fc.name
    if (!name) continue

    if (name.type === 'Namespace') {
      const path = name.path as string[]
      if (path[0] === 'WASM' || path[0] === 'IR') {
        // WASM/IR intrinsic — existing behaviour
        steps.push({ intrinsic: path.join('::'), argRefs })
      } else if (path.length === 1) {
        // Plain Silicon function call (e.g. &str_concat)
        steps.push({ userFunc: path[0], argRefs })
      }
    } else if (typeof name === 'string') {
      steps.push({ userFunc: name, argRefs })
    }
  }
  return steps.length > 0 ? steps : undefined
}

/** Walk an AST node tree looking for the first FunctionCall whose name is a WASM namespace. */
function extractIntrinsicFromBody(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = extractIntrinsicFromBody(child)
      if (r) return r
    }
    return undefined
  }
  if (node.type === 'FunctionCall') {
    const name = node.name
    if (name && Array.isArray(name.path) && (name.path[0] === 'WASM' || name.path[0] === 'IR')) {
      return name.path.join('::')
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'sourceLocation' || key === 'inferredType') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      const r = extractIntrinsicFromBody(child)
      if (r) return r
    }
  }
  return undefined
}

function findFunctionCall(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'FunctionCall') return node
  for (const key of Object.keys(node)) {
    if (key === 'sourceLocation' || key === 'inferredType') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      const r = findFunctionCall(child)
      if (r) return r
    }
  }
  return undefined
}

function findNamespace(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'Namespace') return node
  for (const key of Object.keys(node)) {
    if (key === 'sourceLocation' || key === 'inferredType') continue
    const child = node[key]
    if (child && typeof child === 'object') {
      const r = findNamespace(child)
      if (r) return r
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Strata 2.0 — @stratum registration DSL
// ---------------------------------------------------------------------------

/**
 * Peel off wrapper nodes (Element / Item / Statement / ExpressionStart /
 * ExpressionEnd / Literal) down to the inner semantic node.
 */
function deepUnwrap(node: any): any {
  if (!node || typeof node !== 'object') return node
  const wrappers = new Set(['Element', 'Item', 'Statement', 'ExpressionStart', 'ExpressionEnd', 'Literal'])
  if (wrappers.has(node.type)) return deepUnwrap(node.value)
  return node
}

/** Extract a string literal value from an AST node. */
function extractStringFromNode(node: any): string | undefined {
  const n = deepUnwrap(node)
  if (!n) return undefined
  if (n.type === 'StringLiteral') return n.value
  return undefined
}

/** Extract a single-segment identifier from a Namespace node. */
function extractIdentFromNode(node: any): string | undefined {
  const n = deepUnwrap(node)
  if (!n) return undefined
  if (n.type === 'Namespace' && Array.isArray(n.path) && n.path.length === 1) return n.path[0]
  return undefined
}

/** Extract a Block node from an AST node. */
function extractBlockFromNode(node: any): any | undefined {
  const n = deepUnwrap(node)
  if (!n) return undefined
  if (n.type === 'Block') return n
  return undefined
}

/**
 * Evaluate a simple load-time expression in a @stratum body.
 * Only handles constructs available before a CompilerAPI exists:
 *   - Literal values (string, int, bool)
 *   - &Compiler::state 'name' → fresh StateBucket
 */
function evalLoadTimeExpr(node: any): any {
  const n = deepUnwrap(node)
  if (!n) return undefined
  if (n.type === 'StringLiteral') return n.value
  if (n.type === 'IntLiteral') return parseInt(n.value, 10)
  if (n.type === 'BooleanLiteral') return n.value
  if (n.type === 'FunctionCall') {
    const path: string[] = n.name?.path ?? []
    if (path[0] === 'Compiler' && path[1] === 'state') return createStateBucket()
  }
  return undefined
}

/**
 * Process a `@stratum Name = { body }` definition (Strata 2.0 unified DSL).
 *
 * Walks the body looking for:
 *   - `@local name = expr` — load-time bindings (e.g. state buckets)
 *   - `&Compiler::register::keyword/operator 'token'` calls
 *   - `&Compiler::on::lower NodeParam, { body }` handler registrations
 *   - `&Compiler::on::decl 'token', NodeParam, { body }` — decl-phase handlers
 *   - `&Compiler::on::module_finalize { body }` — post-lower handlers
 *
 * For each registration + on::lower pair, creates a synthetic Elaboration and
 * routes it through the existing registerElaboration path so all downstream
 * machinery (codegenKind lookup, defExpander, expander) works unchanged.
 *
 * New keywords/operators without an &IR::* intrinsic in the handler body use
 * a synthetic 'user::token' intrinsic key so lowerBuiltinCall can dispatch to
 * the compiled expander.
 */
function registerStratumDef(registry: ElaboratorRegistry, elab: Elaboration): void {
  const body = elab.semantics as any  // Block AST from StrataBody
  if (!body || !Array.isArray(body.items)) return

  // Load-time scope: @local bindings evaluated eagerly (e.g. state buckets).
  const loadTimeScope: Record<string, any> = {}

  // Collect everything declared in the body
  const registrations: Array<{ axis: 'operator' | 'keyword', token: string }> = []
  let onLowerNodeParam = 'Node'
  let onLowerBody: any = undefined

  // Collected on::decl, on::call_site, and on::module_finalize items — processed after
  // the full walk so that they can reference tokens registered later in the same body.
  const onDeclItems: Array<{ token: string | undefined; paramName: string; handlerBody: any }> = []
  const onCallSiteItems: Array<{ paramName: string; handlerBody: any }> = []
  const onFinalizeItems: Array<any> = []

  for (const item of body.items as any[]) {
    const node = deepUnwrap(item)
    if (!node) continue

    // @local name = expr — evaluate eagerly for load-time bindings
    if (node.type === 'Definition' && node.keyword === '@local') {
      const name: string | undefined = node.name?.name
      if (typeof name === 'string') {
        const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
        const expr = binding?.expression ?? binding
        loadTimeScope[name] = evalLoadTimeExpr(deepUnwrap(expr))
      }
      continue
    }

    if (node.type !== 'FunctionCall') continue

    const callName = node.name
    if (!callName || callName.type !== 'Namespace') continue
    const path: string[] = callName.path ?? []
    if (path[0] !== 'Compiler') continue

    if (path[1] === 'register') {
      // &Compiler::register::keyword/operator/annotation 'token'
      const axis = path[2] as string
      if (axis !== 'keyword' && axis !== 'operator') continue  // annotation deferred
      const token = extractStringFromNode((node.args ?? [])[0])
      if (token !== undefined) {
        registrations.push({ axis: axis as 'keyword' | 'operator', token })
      }
    } else if (path[1] === 'on' && path[2] === 'lower') {
      // &Compiler::on::lower NodeParam, { body }   (two args)
      // &Compiler::on::lower { body }              (one arg — no explicit param)
      const args: any[] = node.args ?? []
      if (args.length >= 2) {
        onLowerNodeParam = extractIdentFromNode(args[0]) ?? 'Node'
        onLowerBody = extractBlockFromNode(args[args.length - 1])
      } else if (args.length === 1) {
        onLowerBody = extractBlockFromNode(args[0])
      }
    } else if (path[1] === 'on' && path[2] === 'decl') {
      // &Compiler::on::decl 'token', NodeParam, { body }   (3 args)
      // &Compiler::on::decl NodeParam, { body }            (2 args, no explicit token)
      // &Compiler::on::decl { body }                       (1 arg)
      const args: any[] = node.args ?? []
      let token: string | undefined
      let paramName = 'Node'
      let handlerBody: any
      if (args.length >= 3) {
        token = extractStringFromNode(args[0])
        paramName = extractIdentFromNode(args[1]) ?? 'Node'
        handlerBody = extractBlockFromNode(args[args.length - 1])
      } else if (args.length === 2) {
        const tok = extractStringFromNode(args[0])
        if (tok !== undefined) {
          token = tok
          handlerBody = extractBlockFromNode(args[1])
        } else {
          paramName = extractIdentFromNode(args[0]) ?? 'Node'
          handlerBody = extractBlockFromNode(args[1])
        }
      } else if (args.length === 1) {
        handlerBody = extractBlockFromNode(args[0])
      }
      if (handlerBody !== undefined) {
        onDeclItems.push({ token, paramName, handlerBody })
      }
    } else if (path[1] === 'on' && path[2] === 'call_site') {
      // &Compiler::on::call_site NodeParam, { body }   (two args)
      // &Compiler::on::call_site { body }              (one arg — no explicit param)
      const args: any[] = node.args ?? []
      let paramName = 'Node'
      let handlerBody: any
      if (args.length >= 2) {
        paramName = extractIdentFromNode(args[0]) ?? 'Node'
        handlerBody = extractBlockFromNode(args[args.length - 1])
      } else if (args.length === 1) {
        handlerBody = extractBlockFromNode(args[0])
      }
      if (handlerBody !== undefined) {
        onCallSiteItems.push({ paramName, handlerBody })
      }
    } else if (path[1] === 'on' && path[2] === 'module_finalize') {
      // &Compiler::on::module_finalize { body }
      const args: any[] = node.args ?? []
      const handlerBody = args.length >= 1 ? extractBlockFromNode(args[args.length - 1]) : undefined
      if (handlerBody !== undefined) {
        onFinalizeItems.push(handlerBody)
      }
    }
  }

  // Register on::decl handlers — after full walk so all registrations are known
  for (const { token, paramName, handlerBody } of onDeclItems) {
    const capturedScope = { ...loadTimeScope }
    const handler = compileBodyToDeclHandler(handlerBody, paramName, capturedScope)
    const tokens = token !== undefined ? [token] : registrations.map(r => r.token)
    for (const t of tokens) {
      const list = registry.declHandlers.get(t) ?? []
      if (list.length === 0) registry.declHandlers.set(t, list)
      list.push(handler)
    }
  }

  // Register on::call_site handlers
  for (const { paramName, handlerBody } of onCallSiteItems) {
    const capturedScope = { ...loadTimeScope }
    registry.callSiteHandlers.push(compileBodyToCallSiteHandler(handlerBody, paramName, capturedScope))
  }

  // Register on::module_finalize handlers
  for (const handlerBody of onFinalizeItems) {
    const capturedScope = { ...loadTimeScope }
    registry.moduleFinalizeHandlers.push(compileBodyToFinalizeHandler(handlerBody, capturedScope))
  }

  // Nothing registered (no operator/keyword token) — decl/finalize handlers already processed above
  if (registrations.length === 0) return

  for (const { axis, token } of registrations) {
    if (onLowerBody === undefined) {
      // Naked registration: register a minimal StrataNode with no body
      const nakedNode: StrataNode = {
        type: axis === 'operator' ? StrataType.Operator : StrataType.Keyword,
        discriminant: token,
        data: { nodeParamName: 'Node', intrinsic: undefined, bodyTemplate: undefined },
      }
      registerElaborator(registry, axis, token, nakedNode)
      continue
    }

    const intrinsic = extractIntrinsicFromBody(onLowerBody)

    if (intrinsic !== undefined) {
      // Body has an &IR::* / &WASM::* intrinsic marker — use existing path.
      const syntheticElab: Elaboration = {
        type: 'Elaboration',
        kind: axis,
        name: elab.name,
        symbol: token,
        nodeParamName: onLowerNodeParam,
        semantics: onLowerBody,
      }
      registerElaboration(registry, syntheticElab)
    } else {
      // No intrinsic marker — new keyword/operator defined purely via Compiler API.
      // Use a synthetic intrinsic key so lowerBuiltinCall can dispatch.
      const syntheticKey = `user::${token}`
      const strataNode: StrataNode = {
        type: axis === 'operator' ? StrataType.Operator : StrataType.Keyword,
        discriminant: token,
        data: {
          nodeParamName: onLowerNodeParam,
          intrinsic: syntheticKey,
          bodyTemplate: extractBodyTemplate(onLowerBody as any, onLowerNodeParam),
        },
      }
      registerElaborator(registry, axis, token, strataNode)
      if (isRichBody(onLowerBody)) {
        registerExpander(registry, syntheticKey, compileBodyToExpanderFn(onLowerBody, onLowerNodeParam))
      }
    }
  }
}
