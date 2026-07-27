/**
 * A deliberately small SQL-like parser for efchSQL.
 *
 * Supported shape:
 *   SELECT * FROM feed
 *   WHERE language = 'ko' AND ageHours <= 48
 *   PREFER database: 2, ads: -1
 *   LIMIT 20
 *   MODE EXACT
 *
 * MODE may also be APPROX or BUDGET.  APPROX/BUDGET can be followed by an
 * integer row-scoring budget (or `BUDGET <integer>`).
 */

const CLAUSES = new Set(["PREFER", "LIMIT", "MODE"]);
const COMPARISON_OPERATORS = new Set(["=", "!=", "<>", "<", "<=", ">", ">="]);

export class QuerySyntaxError extends SyntaxError {
  constructor(message, token) {
    const suffix = token ? ` at character ${token.start}` : "";
    super(`${message}${suffix}`);
    this.name = "QuerySyntaxError";
    this.position = token?.start ?? null;
  }
}

function isIdentifierStart(char) {
  return /[\p{L}_$#@]/u.test(char);
}

function isIdentifierPart(char) {
  return /[\p{L}\p{N}_.$#@/\-]/u.test(char);
}

function tokenize(input) {
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === "-" && input[index + 1] === "-") {
      index += 2;
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const start = index;
      let value = "";
      index += 1;
      let closed = false;

      while (index < input.length) {
        if (input[index] === quote) {
          if (input[index + 1] === quote) {
            value += quote;
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        if (input[index] === "\\" && index + 1 < input.length) {
          const escaped = input[index + 1];
          const escapes = { n: "\n", r: "\r", t: "\t" };
          value += escapes[escaped] ?? escaped;
          index += 2;
          continue;
        }
        value += input[index];
        index += 1;
      }

      if (!closed) {
        throw new QuerySyntaxError("Unterminated quoted value", { start });
      }

      tokens.push({
        type: quote === "'" ? "string" : "quoted",
        value,
        raw: input.slice(start, index),
        start,
      });
      continue;
    }

    const two = input.slice(index, index + 2);
    if ([">=", "<=", "!=", "<>"].includes(two)) {
      tokens.push({ type: "operator", value: two, raw: two, start: index });
      index += 2;
      continue;
    }

    if ("=<>:,()*;".includes(char)) {
      const type = "=<>".includes(char) ? "operator" : "punctuation";
      tokens.push({ type, value: char, raw: char, start: index });
      index += 1;
      continue;
    }

    const numberMatch = input.slice(index).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (numberMatch) {
      const raw = numberMatch[0];
      tokens.push({ type: "number", value: Number(raw), raw, start: index });
      index += raw.length;
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < input.length && isIdentifierPart(input[index])) index += 1;
      const raw = input.slice(start, index);
      tokens.push({ type: "word", value: raw, raw, start });
      continue;
    }

    throw new QuerySyntaxError(`Unexpected character ${JSON.stringify(char)}`, {
      start: index,
    });
  }

  return tokens;
}

function keyword(token, value) {
  return token?.type === "word" && token.value.toUpperCase() === value;
}

function tokenLabel(token) {
  if (!token) return "end of query";
  return token.raw ?? String(token.value);
}

class Parser {
  constructor(input) {
    this.input = input;
    this.tokens = tokenize(input);
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset];
  }

  consume() {
    const token = this.peek();
    if (token) this.index += 1;
    return token;
  }

  matchKeyword(value) {
    if (!keyword(this.peek(), value)) return false;
    this.index += 1;
    return true;
  }

  expectKeyword(value) {
    const token = this.consume();
    if (!keyword(token, value)) {
      throw new QuerySyntaxError(`Expected ${value}, got ${tokenLabel(token)}`, token);
    }
    return token;
  }

  matchValue(value) {
    if (this.peek()?.value !== value) return false;
    this.index += 1;
    return true;
  }

  expectValue(value) {
    const token = this.consume();
    if (token?.value !== value) {
      throw new QuerySyntaxError(`Expected ${value}, got ${tokenLabel(token)}`, token);
    }
    return token;
  }

  expectIdentifier(message = "Expected an identifier") {
    const token = this.consume();
    if (!token || !["word", "quoted"].includes(token.type)) {
      throw new QuerySyntaxError(message, token);
    }
    return token.value;
  }

  atClauseBoundary() {
    const token = this.peek();
    return !token || (token.type === "word" && CLAUSES.has(token.value.toUpperCase()));
  }

  parse() {
    this.expectKeyword("SELECT");
    const select = this.parseProjection();
    this.expectKeyword("FROM");
    const from = this.expectIdentifier("Expected a source after FROM");

    let where = null;
    let prefer = Object.create(null);
    let limit = 20;
    let mode = "exact";
    let budget = null;
    const seen = new Set();

    while (this.peek() && this.peek().value !== ";") {
      if (this.matchKeyword("WHERE")) {
        if (seen.has("WHERE")) this.duplicateClause("WHERE");
        seen.add("WHERE");
        where = this.parseOr();
        if (!this.atClauseBoundary() && this.peek()?.value !== ";") {
          throw new QuerySyntaxError(`Unexpected token ${tokenLabel(this.peek())}`, this.peek());
        }
        continue;
      }

      if (this.matchKeyword("PREFER")) {
        if (seen.has("PREFER")) this.duplicateClause("PREFER");
        seen.add("PREFER");
        prefer = this.parsePreferences();
        continue;
      }

      if (this.matchKeyword("LIMIT")) {
        if (seen.has("LIMIT")) this.duplicateClause("LIMIT");
        seen.add("LIMIT");
        limit = this.parseNonNegativeInteger("LIMIT");
        continue;
      }

      if (this.matchKeyword("MODE")) {
        if (seen.has("MODE")) this.duplicateClause("MODE");
        seen.add("MODE");
        ({ mode, budget } = this.parseMode());
        continue;
      }

      throw new QuerySyntaxError(
        `Expected WHERE, PREFER, LIMIT, or MODE; got ${tokenLabel(this.peek())}`,
        this.peek(),
      );
    }

    if (this.matchValue(";") && this.peek()) {
      throw new QuerySyntaxError("Unexpected content after semicolon", this.peek());
    }

    return {
      type: "select",
      select,
      from,
      where,
      prefer: { ...prefer },
      limit,
      mode,
      budget,
      source: this.input,
    };
  }

  duplicateClause(name) {
    throw new QuerySyntaxError(`${name} may only appear once`, this.peek());
  }

  parseProjection() {
    if (this.matchValue("*")) return ["*"];

    const fields = [];
    while (this.peek() && !keyword(this.peek(), "FROM")) {
      fields.push(this.expectIdentifier("Expected a field name in SELECT"));
      if (keyword(this.peek(), "FROM")) break;
      this.expectValue(",");
      if (keyword(this.peek(), "FROM")) {
        throw new QuerySyntaxError("Trailing comma in SELECT", this.peek());
      }
    }

    if (fields.length === 0) {
      throw new QuerySyntaxError("SELECT requires at least one field", this.peek());
    }
    return fields;
  }

  parsePreferences() {
    const weights = Object.create(null);
    let count = 0;

    while (!this.atClauseBoundary() && this.peek()?.value !== ";") {
      const token = this.consume();
      if (!token || !["word", "quoted", "string"].includes(token.type)) {
        throw new QuerySyntaxError("Expected a symbol after PREFER", token);
      }
      const symbol = String(token.value);

      if (this.peek()?.value === ":" || this.peek()?.value === "=") this.consume();
      const weightToken = this.consume();
      if (weightToken?.type !== "number" || !Number.isFinite(weightToken.value)) {
        throw new QuerySyntaxError(`Expected a finite weight for ${symbol}`, weightToken);
      }
      weights[symbol] = weightToken.value;
      count += 1;

      if (this.matchValue(",")) {
        if (this.atClauseBoundary() || this.peek()?.value === ";") {
          throw new QuerySyntaxError("Trailing comma in PREFER", this.peek());
        }
        continue;
      }
      if (!this.atClauseBoundary() && this.peek()?.value !== ";") {
        throw new QuerySyntaxError("Expected a comma between preferences", this.peek());
      }
    }

    if (count === 0) {
      throw new QuerySyntaxError("PREFER requires at least one symbol and weight", this.peek());
    }
    return weights;
  }

  parseNonNegativeInteger(label) {
    const token = this.consume();
    if (token?.type !== "number" || !Number.isInteger(token.value) || token.value < 0) {
      throw new QuerySyntaxError(`${label} must be a non-negative integer`, token);
    }
    return token.value;
  }

  parseMode() {
    const token = this.consume();
    if (!token || token.type !== "word") {
      throw new QuerySyntaxError("MODE requires EXACT, APPROX, or BUDGET", token);
    }

    const raw = token.value.toUpperCase();
    if (raw === "EXACT") return { mode: "exact", budget: null };
    if (raw !== "APPROX" && raw !== "BUDGET") {
      throw new QuerySyntaxError(`Unknown MODE ${token.value}`, token);
    }

    let budget = null;
    if (this.matchKeyword("BUDGET")) {
      budget = this.parseNonNegativeInteger("BUDGET");
    } else if (this.peek()?.type === "number") {
      budget = this.parseNonNegativeInteger("BUDGET");
    }
    return { mode: "approx", budget };
  }

  parseOr() {
    let expression = this.parseAnd();
    while (this.matchKeyword("OR")) {
      expression = { type: "or", left: expression, right: this.parseAnd() };
    }
    return expression;
  }

  parseAnd() {
    let expression = this.parseNot();
    while (this.matchKeyword("AND")) {
      expression = { type: "and", left: expression, right: this.parseNot() };
    }
    return expression;
  }

  parseNot() {
    if (this.matchKeyword("NOT")) {
      return { type: "not", expression: this.parseNot() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    if (this.matchValue("(")) {
      const expression = this.parseOr();
      this.expectValue(")");
      return expression;
    }
    return this.parsePredicate();
  }

  parsePredicate() {
    const fieldToken = this.peek();
    const field = this.expectIdentifier("Expected a field in WHERE");

    if (this.matchKeyword("IS")) {
      const negated = this.matchKeyword("NOT");
      this.expectKeyword("NULL");
      return { type: "predicate", field, operator: negated ? "is not null" : "is null", value: null };
    }

    let negated = false;
    if (this.matchKeyword("NOT")) negated = true;

    if (this.matchKeyword("IN")) {
      this.expectValue("(");
      const values = [];
      if (!this.matchValue(")")) {
        do {
          values.push(this.parseLiteral());
        } while (this.matchValue(","));
        this.expectValue(")");
      }
      return { type: "predicate", field, operator: negated ? "not in" : "in", value: values };
    }

    if (this.matchKeyword("CONTAINS")) {
      return {
        type: "predicate",
        field,
        operator: negated ? "not contains" : "contains",
        value: this.parseLiteral(),
      };
    }

    if (negated) {
      throw new QuerySyntaxError("NOT must be followed by IN or CONTAINS", this.peek());
    }

    const operator = this.consume();
    if (!operator || operator.type !== "operator" || !COMPARISON_OPERATORS.has(operator.value)) {
      throw new QuerySyntaxError(
        `Expected a comparison operator after ${field}`,
        operator ?? fieldToken,
      );
    }
    return { type: "predicate", field, operator: operator.value, value: this.parseLiteral() };
  }

  parseLiteral() {
    const token = this.consume();
    if (!token) throw new QuerySyntaxError("Expected a value", token);
    if (token.type === "number" || token.type === "string") return token.value;
    if (token.type === "quoted") return token.value;
    if (token.type === "word") {
      const upper = token.value.toUpperCase();
      if (upper === "TRUE") return true;
      if (upper === "FALSE") return false;
      if (upper === "NULL") return null;
      return token.value;
    }
    throw new QuerySyntaxError(`Expected a value, got ${tokenLabel(token)}`, token);
  }
}

export function parseQuery(sql) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new TypeError("parseQuery(sql) requires a non-empty string");
  }
  return new Parser(sql).parse();
}

export default parseQuery;
