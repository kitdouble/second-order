// A tiny, safe expression language for exclusions, pilot checks and stop rules.
//
//   accuracy < 0.60
//   attn.passed == false
//   bf10 >= 10 or bf10 <= 0.1
//   not (conf_sd > 0) and fast_rt <= 0.1
//   type == 'incongruent' and correct == true      (row filters)
//
// Identifiers may contain dots. No function calls, no assignment, nothing that
// can reach outside the values passed in. Unknown identifiers are an error.

const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|'([^'\\]{0,200})'|"([^"\\]{0,200})"|(==|!=|<=|>=|<|>|\(|\)|&&|\|\||-)|(\S))/y;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) {
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) {
      const w = m[2];
      if (w === "and") out.push({ t: "op", v: "&&" });
      else if (w === "or") out.push({ t: "op", v: "||" });
      else if (w === "not") out.push({ t: "op", v: "not" });
      else if (w === "true" || w === "false") out.push({ t: "bool", v: w === "true" });
      else if (w === "null") out.push({ t: "null" });
      else out.push({ t: "id", v: w });
    } else if (m[3] !== undefined) out.push({ t: "str", v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "str", v: m[4] });
    else if (m[5] !== undefined) out.push({ t: "op", v: m[5] });
    else if (m[6] !== undefined) {
      if (m[6].trim() === "") continue;
      throw new ExprError(`Unexpected character "${m[6]}".`);
    }
  }
  return out;
}

export class ExprError extends Error {}

/** Parses an expression into an AST. Throws ExprError with a readable message. */
export function parseExpr(src) {
  if (typeof src !== "string" || !src.trim()) throw new ExprError("Expression is empty.");
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const isOp = (v) => peek() && peek().t === "op" && peek().v === v;

  function orExpr() {
    let left = andExpr();
    while (isOp("||")) {
      take();
      left = { k: "or", a: left, b: andExpr() };
    }
    return left;
  }
  function andExpr() {
    let left = notExpr();
    while (isOp("&&")) {
      take();
      left = { k: "and", a: left, b: notExpr() };
    }
    return left;
  }
  function notExpr() {
    if (isOp("not")) {
      take();
      return { k: "not", a: notExpr() };
    }
    return cmp();
  }
  function cmp() {
    const left = atom();
    const p = peek();
    if (p && p.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(p.v)) {
      take();
      return { k: "cmp", op: p.v, a: left, b: atom() };
    }
    return left;
  }
  function atom() {
    const tk = take();
    if (!tk) throw new ExprError("Expression ends too early.");
    if (tk.t === "num") return { k: "lit", v: tk.v };
    if (tk.t === "bool") return { k: "lit", v: tk.v };
    if (tk.t === "str") return { k: "lit", v: tk.v };
    if (tk.t === "null") return { k: "lit", v: null };
    if (tk.t === "id") return { k: "id", v: tk.v };
    if (tk.t === "op" && tk.v === "(") {
      const e = orExpr();
      const close = take();
      if (!close || close.v !== ")") throw new ExprError("Missing closing bracket.");
      return e;
    }
    if (tk.t === "op" && tk.v === "-") {
      const n = take();
      if (n && n.t === "num") return { k: "lit", v: -n.v };
    }
    throw new ExprError(`Unexpected "${tk.v ?? tk.t}".`);
  }

  const ast = orExpr();
  if (i < toks.length) throw new ExprError(`Unexpected "${toks[i].v ?? toks[i].t}" after the expression.`);
  return ast;
}

/** Lists the identifiers an expression uses. */
export function exprIdentifiers(src) {
  const ids = new Set();
  const walk = (n) => {
    if (!n) return;
    if (n.k === "id") ids.add(n.v);
    walk(n.a);
    walk(n.b);
  };
  walk(parseExpr(src));
  return [...ids];
}

/**
 * Evaluates an expression against a flat object of values ({ "attn.passed": true }).
 * Comparisons involving null/undefined/NaN are false, so a missing measure never
 * silently excludes or includes someone; callers should flag missing values.
 */
export function evalExpr(src, values) {
  const ast = typeof src === "string" ? parseExpr(src) : src;
  const ev = (n) => {
    switch (n.k) {
      case "lit":
        return n.v;
      case "id":
        if (!(n.v in values)) throw new ExprError(`Unknown name "${n.v}".`);
        return values[n.v];
      case "not":
        return !truthy(ev(n.a));
      case "and":
        return truthy(ev(n.a)) && truthy(ev(n.b));
      case "or":
        return truthy(ev(n.a)) || truthy(ev(n.b));
      case "cmp": {
        const a = ev(n.a);
        const b = ev(n.b);
        if (n.op === "==") return a === b;
        if (n.op === "!=") return a !== b;
        if (!isNum(a) || !isNum(b)) return false;
        if (n.op === "<") return a < b;
        if (n.op === "<=") return a <= b;
        if (n.op === ">") return a > b;
        return a >= b;
      }
      default:
        throw new ExprError("Bad expression.");
    }
  };
  return truthy(ev(ast));
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const truthy = (x) => x === true || (isNum(x) && x !== 0);
