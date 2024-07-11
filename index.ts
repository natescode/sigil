console.log("Silicon v2024.01");
import { toAST } from 'ohm-js/extras'
import siliconGrammar from './SiliconGrammar';
import addEvalSemantics from './eval';
const evalSemantics = addEvalSemantics(siliconGrammar);
// TESTS
// let sourceCode = '5 - 1 + 2 * 3 / 2;'
// let sourceCode = '"hello, " + "world!";'
// let sourceCode = '5 - 1 + (2 * 3) / 2;'
// let sourceCode = '0x10 + 0x11;'
// let sourceCode = '1.2 + 1.8;'
// let sourceCode = "'hello, ' ++ 'world!';";
let result;
let sourceCode = `1 + (@let x = 2);`
const match = siliconGrammar.match(sourceCode);
if (match.succeeded()) {
  result = evalSemantics(match).eval();  // Evaluate the expression.
} else {
  result = match.message;  // Extract the error message.
}

console.log(`Result = ${result}`)
// TODO covert match tree to AST
// const ast = toAST(match, {
//   Program: { type: 'program', statements: 0 },
//   // SourceElement_sourceExp: { type: 'source_element', exp: 0 },
//   EXP_binaryExp: { type: 'binary_exp', left: 0, op: 1, right: 2 },
//   EXP_expr: { type: 'expression', exp: 0 },
//   EXP_letEXP: { type: 'let_exp', _let: 0, id: 1, eq: 2, exp: 3 },
//   EXPR_lit: { type: 'expr_literal', value: 0 },
//   // EXPR_paren: { type: 'paren_exp', lparen: 0, exp: 1, rparen: 2 },
//   binOp: { type: 'operator', op: 0 },
//   keyword: { type: 'keyword', at: 0, id: 1 },
//   literal: { type: 'literal', exp: 0 },
//   literal_str: { type: 'string_literal', lit: 0 },
//   literal_num: { type: 'numeric_literal', lit: 0 },
//   binLiteral: { type: 'binary_literal', lit: 0 },
//   hexLiteral: { type: 'hexadecimal_literal', lit: 0 },
//   octLiteral: { type: 'octal_literal', lit: 0 },
//   floatLiteral: { type: 'float_literal', lit: 0 },
//   intLiteral: { type: 'integer_literal', lit: 0 },
//   literal_bln: { type: 'boolean_literal', lit: 0 },
//   identifier_discard: { type: 'discard', id: 0 },
//   identifier_pub: { type: 'identifier', id: 0 },
//   identifier_priv: { type: 'identifier', id: 0 },
//   bit: { type: 'bit', value: 0 },
//   discard: { type: 'discard_identifier', id: 0 },
// })

// Bun.write('ast.json', JSON.stringify(ast))

// console.log(`AST
//   ${JSON.stringify(ast)}`)

// // output result of eval
// // let sc = sourceCode.slice(0, -1)
// // console.log(`${sc} = ${result}`)