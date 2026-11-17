/**
 * Three-valued evaluator for the subset of GitHub Actions expressions that can be decided before dispatch.
 *
 * Anything that depends on runtime state (step/job outputs, vars, secrets, matrix values, unknown event
 * fields) evaluates to UNKNOWN. Callers treat UNKNOWN as "GitHub decides natively"; they must not invent a
 * result for it. Semantics follow https://docs.github.com/en/actions/reference/workflows-and-actions/expressions:
 * string comparison ignores case, `||`/`&&` return operand values, and functions are case-insensitive.
 */

export const UNKNOWN: unique symbol = Symbol('unknown')
export type ExpressionValue = string | number | boolean | null | ExpressionValue[] | { [key: string]: ExpressionValue }
export type MaybeValue = ExpressionValue | typeof UNKNOWN

export interface ExpressionContext {
  /** Known context values, keyed by lower-case dotted path (for example `github.event_name`). */
  values: Record<string, ExpressionValue>
  /** Result of `success()`, `failure()` and `cancelled()` for this job, or UNKNOWN. */
  status: { success: boolean | typeof UNKNOWN; failure: boolean | typeof UNKNOWN; cancelled: boolean }
}

type Token =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i] as string
    if (/\s/.test(ch)) {
      i++
    } else if (ch === "'") {
      let value = ''
      i++
      for (;;) {
        if (i >= source.length) throw new Error('Unterminated string literal')
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        value += source[i]
        i++
      }
      tokens.push({ kind: 'string', value })
    } else if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^-?(0x[0-9a-f]+|[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?)/i.exec(source.slice(i))
      if (!match) throw new Error(`Invalid number at ${i}`)
      tokens.push({ kind: 'number', value: Number(match[0]) })
      i += match[0].length
    } else if (/[A-Za-z_]/.test(ch)) {
      // Property paths such as github.event.pull_request.labels.*.name or matrix['os'] stay one token.
      const match = /^[A-Za-z_][A-Za-z0-9_-]*(?:(?:\.(?:\*|[A-Za-z0-9_-]+))|(?:\[[^\]]*\]))*/.exec(source.slice(i))
      if (!match) throw new Error(`Invalid identifier at ${i}`)
      tokens.push({ kind: 'ident', value: match[0] })
      i += match[0].length
    } else {
      const two = source.slice(i, i + 2)
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        tokens.push({ kind: 'op', value: two })
        i += 2
      } else if ('!<>(),'.includes(ch)) {
        tokens.push({ kind: 'op', value: ch })
        i++
      } else throw new Error(`Unexpected character "${ch}"`)
    }
  }
  return tokens
}

type Node =
  | { type: 'literal'; value: ExpressionValue }
  | { type: 'path'; path: string }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'not'; operand: Node }
  | { type: 'binary'; op: string; left: Node; right: Node }

function parse(tokens: Token[]): Node {
  let position = 0
  const peek = () => tokens[position]
  const isOp = (value: string) => {
    const token = peek()
    return token?.kind === 'op' && token.value === value
  }
  const expect = (value: string) => {
    if (!isOp(value)) throw new Error(`Expected "${value}"`)
    position++
  }
  const binary = (next: () => Node, ops: string[]) => (): Node => {
    let left = next()
    for (;;) {
      const token = peek()
      if (token?.kind !== 'op' || !ops.includes(token.value)) return left
      position++
      left = { type: 'binary', op: token.value, left, right: next() }
    }
  }
  const primary = (): Node => {
    const token = peek()
    if (!token) throw new Error('Unexpected end of expression')
    position++
    if (token.kind === 'string' || token.kind === 'number') return { type: 'literal', value: token.value }
    if (token.kind === 'op') {
      if (token.value === '(') {
        const inner = or()
        expect(')')
        return inner
      }
      if (token.value === '!') return { type: 'not', operand: primary() }
      throw new Error(`Unexpected "${token.value}"`)
    }
    const lower = token.value.toLowerCase()
    if (lower === 'true' || lower === 'false') return { type: 'literal', value: lower === 'true' }
    if (lower === 'null') return { type: 'literal', value: null }
    if (isOp('(')) {
      position++
      const args: Node[] = []
      if (!isOp(')')) {
        for (;;) {
          args.push(or())
          if (isOp(')')) break
          expect(',')
        }
      }
      expect(')')
      return { type: 'call', name: lower, args }
    }
    return { type: 'path', path: token.value }
  }
  const comparison = binary(primary, ['<', '<=', '>', '>='])
  const equality = binary(comparison, ['==', '!='])
  const and = binary(equality, ['&&'])
  const or = binary(and, ['||'])
  const tree = or()
  if (position !== tokens.length) throw new Error('Unexpected trailing tokens')
  return tree
}

function truthy(value: ExpressionValue): boolean {
  if (value === null || value === false || value === 0 || value === '') return false
  return !(typeof value === 'number' && Number.isNaN(value))
}

function toNumber(value: ExpressionValue): number {
  if (value === null) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value)
  return Number.NaN
}

/** GitHub's `==`: strings ignore case, arrays/objects compare by instance, other mixed types compare as numbers. */
function looseEquals(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase()
  // null is not an object here: GitHub coerces it to 0, so null == '', null == false and null == 0 hold.
  const isObject = (value: ExpressionValue) => typeof value === 'object' && value !== null
  if (isObject(left) || isObject(right)) return left === right
  if (typeof left === typeof right) return left === right
  return toNumber(left) === toNumber(right)
}

function asString(value: ExpressionValue): string {
  if (value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Resolve `a.b.*.c` against known context; unknown paths stay UNKNOWN rather than null. */
function resolvePath(path: string, context: ExpressionContext): MaybeValue {
  const normalized = path.replace(/\[\s*'([^']*)'\s*\]/g, '.$1').toLowerCase()
  if (normalized in context.values) return context.values[normalized] as ExpressionValue
  return UNKNOWN
}

function evaluateNode(node: Node, context: ExpressionContext): MaybeValue {
  switch (node.type) {
    case 'literal':
      return node.value
    case 'path':
      return resolvePath(node.path, context)
    case 'not': {
      const value = evaluateNode(node.operand, context)
      return value === UNKNOWN ? UNKNOWN : !truthy(value)
    }
    case 'binary': {
      const left = evaluateNode(node.left, context)
      if (node.op === '&&') {
        if (left !== UNKNOWN && !truthy(left)) return left
        const right = evaluateNode(node.right, context)
        if (left === UNKNOWN) return right !== UNKNOWN && !truthy(right) ? false : UNKNOWN
        return right
      }
      if (node.op === '||') {
        if (left !== UNKNOWN && truthy(left)) return left
        const right = evaluateNode(node.right, context)
        if (left === UNKNOWN) return right !== UNKNOWN && truthy(right) ? true : UNKNOWN
        return right
      }
      const right = evaluateNode(node.right, context)
      if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN
      if (node.op === '==') return looseEquals(left, right)
      if (node.op === '!=') return !looseEquals(left, right)
      const l = toNumber(left)
      const r = toNumber(right)
      if (node.op === '<') return l < r
      if (node.op === '<=') return l <= r
      if (node.op === '>') return l > r
      return l >= r
    }
    case 'call': {
      if (node.name === 'always') return true
      if (node.name === 'success') return context.status.success
      if (node.name === 'failure') return context.status.failure
      if (node.name === 'cancelled') return context.status.cancelled
      const evaluatedArgs = node.args.map((arg) => evaluateNode(arg, context))
      if (evaluatedArgs.some((arg) => arg === UNKNOWN)) return UNKNOWN
      const args = evaluatedArgs as ExpressionValue[]
      const [a, b] = args
      if (a === undefined) return UNKNOWN
      switch (node.name) {
        case 'startswith':
          return b !== undefined && asString(a).toLowerCase().startsWith(asString(b).toLowerCase())
        case 'endswith':
          return b !== undefined && asString(a).toLowerCase().endsWith(asString(b).toLowerCase())
        case 'contains':
          if (b === undefined) return UNKNOWN
          return Array.isArray(a)
            ? a.some((item) => looseEquals(item, b))
            : asString(a).toLowerCase().includes(asString(b).toLowerCase())
        case 'fromjson':
          try {
            return JSON.parse(asString(a)) as ExpressionValue
          } catch {
            return UNKNOWN
          }
        case 'tojson':
          return JSON.stringify(a)
        case 'format':
          return asString(a).replace(/\{(\d+)\}/g, (_, index: string) => asString(args[Number(index) + 1] ?? ''))
        case 'join':
          return Array.isArray(a) ? a.map(asString).join(b === undefined ? ',' : asString(b)) : asString(a)
        default:
          return UNKNOWN
      }
    }
  }
}

export interface ConditionResult {
  /** true/false when decidable before dispatch; undefined when GitHub must evaluate it natively. */
  value: boolean | undefined
  usesStatusFunction: boolean
  parseError?: string
}

/** Strip a single `${{ }}` wrapper; job/step `if:` values may be written either way. */
export function unwrapExpression(text: string): string {
  const trimmed = text.trim()
  const match = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed)
  return (match?.[1] ?? trimmed).trim()
}

/**
 * Evaluate an `if:` condition. Like GitHub, a condition without a status function is implicitly
 * `success() && (condition)`.
 */
export function evaluateCondition(text: string, context: ExpressionContext): ConditionResult {
  const source = unwrapExpression(text)
  let tree: Node
  try {
    tree = parse(tokenize(source))
  } catch (error) {
    return {
      value: undefined,
      usesStatusFunction: false,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }
  const usesStatusFunction = /\b(success|failure|cancelled|always)\s*\(/i.test(source)
  const evaluated = evaluateNode(tree, context)
  const conditionValue = evaluated === UNKNOWN ? undefined : truthy(evaluated)
  if (usesStatusFunction) return { value: conditionValue, usesStatusFunction }
  const success = context.status.success
  if (success === false) return { value: false, usesStatusFunction }
  if (success === UNKNOWN) return { value: conditionValue === false ? false : undefined, usesStatusFunction }
  return { value: conditionValue, usesStatusFunction }
}
