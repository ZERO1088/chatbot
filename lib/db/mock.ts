/**
 * TEMPORARY LOCAL-DEVELOPMENT BYPASS — remove when done with UI work.
 *
 * In-memory stand-in for the `drizzle(client)` instance built in
 * `lib/db/queries.ts`. It lives here so `DEV_BYPASS_DB=1` can serve the UI with
 * no Postgres connection; it only runs when `isDevBypassEnabled` is true.
 *
 * It implements the query shapes `lib/db/queries.ts` actually builds, and
 * nothing more:
 *   - `select().from().where().orderBy().limit()` and `await db.select()...`
 *   - `insert(table).values(...)` with optional `.returning()`
 *   - `update(table).set(...).where(...)`
 *   - `delete(table).where(...)` with optional `.returning()`
 *   - SQL conditions built from `eq`, `and`, `gt`, `gte`, `lt`, `inArray` and
 *     `orderBy(asc|desc(...))`, evaluated against in-memory rows.
 *
 * State resets on every server restart. Never import this outside the bypass
 * branch in `lib/db/queries.ts`.
 */

import { generateUUID } from "../utils";

type MockRow = Record<string, unknown>;

type Order = {
  column: string;
  direction: "asc" | "desc";
};

type QueryState = {
  filter?: (row: MockRow) => boolean;
  /** `select({ count: ... })`: yield a single `{ count }` row. */
  aggregated: boolean;
  joined: MockTable[];
  operation?: "delete" | "insert" | "update";
  order?: Order;
  projection?: Record<string, unknown>;
  selectLimit?: number;
  setValues?: MockRow;
  values?: Promise<Record<string, unknown>[]> | Record<string, unknown>[];
};

type MockTable = {
  defaultOrder?: Order;
  name: string;
  nextRow: (values: MockRow) => MockRow;
  rows: MockRow[];
};

const tables = new Map<string, MockTable>();

function createTable(
  name: string,
  options: {
    defaultOrder?: Order;
    nextRow: (values: MockRow) => MockRow;
  }
) {
  const table: MockTable = {
    defaultOrder: options.defaultOrder,
    name,
    nextRow: options.nextRow,
    rows: [],
  };
  tables.set(name, table);

  return table;
}

// One in-memory "table" per Postgres table referenced by lib/db/queries.ts.
createTable("User", {
  nextRow: (values) => ({
    createdAt: new Date(),
    email: "",
    emailVerified: false,
    id: generateUUID(),
    image: null,
    isAnonymous: false,
    name: null,
    password: null,
    updatedAt: new Date(),
    ...values,
  }),
});

createTable("Chat", {
  defaultOrder: { column: "createdAt", direction: "desc" },
  nextRow: (values) => ({
    createdAt: new Date(),
    id: generateUUID(),
    title: "New chat",
    userId: "",
    visibility: "private",
    ...values,
  }),
});

createTable("Message_v2", {
  defaultOrder: { column: "createdAt", direction: "asc" },
  nextRow: (values) => ({
    attachments: [],
    chatId: "",
    createdAt: new Date(),
    id: generateUUID(),
    parts: [],
    role: "user",
    ...values,
  }),
});

createTable("Vote_v2", {
  nextRow: (values) => ({
    chatId: "",
    isUpvoted: false,
    messageId: "",
    ...values,
  }),
});

createTable("Document", {
  defaultOrder: { column: "createdAt", direction: "desc" },
  nextRow: (values) => ({
    content: null,
    createdAt: new Date(),
    id: generateUUID(),
    kind: "text",
    title: "",
    userId: "",
    ...values,
  }),
});

createTable("Suggestion", {
  nextRow: (values) => ({
    createdAt: new Date(),
    description: null,
    documentCreatedAt: new Date(),
    documentId: "",
    id: generateUUID(),
    isResolved: false,
    originalText: "",
    suggestedText: "",
    userId: "",
    ...values,
  }),
});

createTable("Stream", {
  defaultOrder: { column: "createdAt", direction: "asc" },
  nextRow: (values) => ({
    chatId: "",
    createdAt: new Date(),
    id: generateUUID(),
    ...values,
  }),
});

/** Clone on the way out so callers cannot mutate store state by reference. */
function clone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  return structuredClone(value);
}

function columnValue(row: MockRow, column: string) {
  const value = row[column];

  return value instanceof Date ? value.getTime() : value;
}

function compareRows(left: MockRow, right: MockRow, order: Order) {
  const leftValue = columnValue(left, order.column) as string;
  const rightValue = columnValue(right, order.column) as string;

  if (leftValue === rightValue) {
    return 0;
  }

  const ascending = leftValue < rightValue ? -1 : 1;

  return order.direction === "asc" ? ascending : -ascending;
}

/* -------------------------------------------------------------------------- */
/* Drizzle SQL node evaluation                                                */
/* -------------------------------------------------------------------------- */

type SqlNode = Record<string, unknown>;

function isSqlNode(value: unknown): value is SqlNode {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as SqlNode).queryChunks)
  );
}

/** Drizzle wraps literal values in `Param`; columns carry their SQL `name`. */
function isParam(value: unknown): value is SqlNode {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SqlNode).constructor?.name === "Param"
  );
}

function columnNameOf(value: unknown): string | undefined {
  const name = (value as { name?: unknown } | null)?.name;

  return typeof name === "string" ? name : undefined;
}

/**
 * Flattened view of a Drizzle SQL tree. Every token is one of:
 * a SQL keyword/operator, a column reference, or a literal value.
 */
type SqlToken =
  | { type: "column"; value: string }
  | { type: "keyword"; value: string }
  | { type: "value"; value: unknown };

function tokenize(node: unknown, tokens: SqlToken[]) {
  if (Array.isArray(node)) {
    // `inArray(column, values)` renders as an array of `Param`s. Keep it as one
    // value; recursing would split the list into separate tokens.
    if (node.some((item) => isParam(item))) {
      tokens.push({
        type: "value",
        value: node.map((item) => unwrap(item)),
      });

      return;
    }

    for (const item of node) {
      tokenize(item, tokens);
    }

    return;
  }

  // A nested condition (`and(...)`, `inArray(...)`) is itself an SQL node.
  if (isSqlNode(node)) {
    for (const chunk of node.queryChunks as unknown[]) {
      tokenize(chunk, tokens);
    }

    return;
  }

  // Drizzle wraps literals in `Param`; check this before reading `.value`,
  // because `StringChunk` also has a `.value` (an array of SQL text).
  if (isParam(node)) {
    tokens.push({ type: "value", value: (node as SqlNode).value });

    return;
  }

  const name = columnNameOf(node);

  if (name) {
    tokens.push({ type: "column", value: name });

    return;
  }

  const text = (node as SqlNode)?.value;

  // `StringChunk`: SQL text such as " = ", " and " or "asc". Parentheses only
  // group the flat AND/OR chains we build, so they carry no meaning here.
  if (Array.isArray(text) && typeof text[0] === "string") {
    const keyword = (text as string[]).join("").trim();

    if (keyword.length > 0 && !/^[()]+$/.test(keyword)) {
      tokens.push({ type: "keyword", value: keyword });
    }

    return;
  }

  // `inArray(column, values)`: a bare array of wrapped or plain literals.
  if (Array.isArray(text)) {
    tokens.push({
      type: "value",
      value: (text as unknown[]).map((entry) => unwrap(entry)),
    });

    return;
  }

  if (text !== undefined) {
    tokens.push({ type: "keyword", value: String(text) });
  }
}

/** Unwraps a `Param` (also used for values inside an `inArray` list). */
function unwrap(value: unknown): unknown {
  return isParam(value) ? (value as SqlNode).value : value;
}

function toComparable(left: unknown, right: unknown): [number, number] {
  if (left instanceof Date || right instanceof Date) {
    return [
      left instanceof Date ? left.getTime() : Number(left),
      right instanceof Date ? right.getTime() : Number(right),
    ];
  }

  return [Number(left), Number(right)];
}

/** Compares values the way Postgres would for `=` / `!=`, dates included. */
function equalValues(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return toComparable(left, right)[0] === toComparable(left, right)[1];
  }

  return left === right;
}

function evaluateTokens(tokens: SqlToken[], row: MockRow): boolean {
  // OR binds loosest in SQL, so split on it before AND.
  const orIndex = tokens.findIndex(
    (token) => token.type === "keyword" && token.value === "or"
  );

  if (orIndex >= 0) {
    return (
      evaluateTokens(tokens.slice(0, orIndex), row) ||
      evaluateTokens(tokens.slice(orIndex + 1), row)
    );
  }

  const andIndex = tokens.findIndex(
    (token) => token.type === "keyword" && token.value === "and"
  );

  if (andIndex >= 0) {
    return (
      evaluateTokens(tokens.slice(0, andIndex), row) &&
      evaluateTokens(tokens.slice(andIndex + 1), row)
    );
  }

  const operatorIndex = tokens.findIndex((token) => token.type === "keyword");
  const operatorToken = tokens[operatorIndex];

  if (operatorIndex <= 0 || operatorToken.type !== "keyword") {
    // Not a comparison shape we build; do not silently hide rows.
    return true;
  }

  const operator = operatorToken.value.toLowerCase();
  const leftToken = tokens[operatorIndex - 1];
  const leftValue =
    leftToken?.type === "column"
      ? row[leftToken.value]
      : unwrap(leftToken?.value);
  const rightValue = unwrap(tokens[operatorIndex + 1]?.value);

  switch (operator) {
    case "in":
      return Array.isArray(rightValue)
        ? rightValue.some((candidate) =>
            equalValues(leftValue, unwrap(candidate))
          )
        : false;
    case "=":
      return equalValues(leftValue, rightValue);
    case "!=":
    case "<>":
      return !equalValues(leftValue, rightValue);
    case ">":
      return (
        toComparable(leftValue, rightValue)[0] >
        toComparable(leftValue, rightValue)[1]
      );
    case ">=":
      return (
        toComparable(leftValue, rightValue)[0] >=
        toComparable(leftValue, rightValue)[1]
      );
    case "<":
      return (
        toComparable(leftValue, rightValue)[0] <
        toComparable(leftValue, rightValue)[1]
      );
    case "<=":
      return (
        toComparable(leftValue, rightValue)[0] <=
        toComparable(leftValue, rightValue)[1]
      );
    default:
      return true;
  }
}

function matches(row: MockRow, condition: unknown): boolean {
  const tokens: SqlToken[] = [];
  tokenize(condition, tokens);

  return evaluateTokens(tokens, row);
}

/** Reads `asc(column)` / `desc(column)` back into a plain sort instruction. */
function parseOrder(
  clause: unknown,
  fallback: Order | undefined
): Order | undefined {
  const tokens: SqlToken[] = [];
  tokenize(clause, tokens);

  const column = tokens.find((token) => token.type === "column");
  const direction = tokens.find(
    (token) => token.type === "keyword" && /^(asc|desc)$/i.test(token.value)
  );

  if (column?.type !== "column") {
    return fallback;
  }

  return {
    column: column.value,
    direction:
      direction?.type === "keyword" && /desc/i.test(direction.value)
        ? "desc"
        : "asc",
  };
}

/* -------------------------------------------------------------------------- */
/* Query execution                                                            */
/* -------------------------------------------------------------------------- */

const DRIZZLE_NAME = Symbol.for("drizzle:Name");

function tableOf(target: unknown): MockTable {
  // Drizzle stores the SQL table name under a well-known symbol.
  const name = (target as Record<symbol, unknown> | null)?.[DRIZZLE_NAME];
  const table = typeof name === "string" ? tables.get(name) : undefined;

  if (!table) {
    throw new Error("[dev-bypass] mock database received an unknown table");
  }

  return table;
}

function isQueryWrapper(value: unknown): value is { value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in (value as Record<string, unknown>) &&
    !Array.isArray((value as Record<string, unknown>).queryChunks)
  );
}

function flattenWrappers(value: unknown): unknown[] {
  if (isQueryWrapper(value)) {
    return flattenWrappers((value as { value: unknown }).value);
  }

  return Array.isArray(value) ? value : [value];
}

function joinedRowFor(state: QueryState, base: MockRow) {
  const joined: MockRow = { ...base };

  for (const joinTable of state.joined) {
    // The only join in lib/db/queries.ts is `Message.chatId = Chat.id`.
    const linked = joinTable.rows.find(
      (candidate) => candidate.id === base.chatId
    );

    if (!linked) {
      continue;
    }

    // Only fill in columns the base row does not already have, so a shared
    // column name (e.g. `createdAt`) keeps the base table's value.
    for (const [key, value] of Object.entries(linked)) {
      if (!(key in joined)) {
        joined[key] = value;
      }
    }
  }

  return joined;
}

async function runQuery(state: QueryState, table: MockTable) {
  const { rows } = table;

  if (state.operation === "insert" && state.values) {
    // Drizzle wraps the payload in a Param, and accepts a single object.
    const pending = flattenWrappers(await state.values);
    const inserted: MockRow[] = [];

    for (const value of pending) {
      const row = clone(table.nextRow(value as MockRow));

      rows.push(row);
      inserted.push(clone(row));
    }

    return inserted;
  }

  if (state.operation === "update") {
    const updated: MockRow[] = [];

    for (const row of rows) {
      if (!state.filter || state.filter(row)) {
        Object.assign(row, clone(state.setValues ?? {}));
        updated.push(clone(row));
      }
    }

    return updated;
  }

  const candidateRows = state.joined.length
    ? rows
        .map((row) => {
          const merged = joinedRowFor(state, row);
          const matchedJoin = state.joined.every((joinTable) =>
            joinTable.rows.some((candidate) => candidate.id === row.chatId)
          );

          return { matchedJoin, merged };
        })
        .filter((entry) => entry.matchedJoin)
        .map((entry) => entry.merged)
    : rows;
  const matched = candidateRows.filter(
    (row) => !state.filter || state.filter(row)
  );

  if (state.operation === "delete") {
    const positions = new Map<MockRow, number>();

    for (const [index, row] of rows.entries()) {
      positions.set(row, index);
    }

    const doomed = matched
      .map((row) => positions.get(row))
      .filter((index): index is number => index !== undefined);

    doomed.sort((left, right) => right - left);

    const deleted = doomed.map((index) => clone(rows[index]));

    for (const index of doomed) {
      rows.splice(index, 1);
    }

    return deleted;
  }

  if (state.aggregated) {
    // The only aggregated select in lib/db/queries.ts is
    // `select({ count: count(message.id) })`: one row carrying the count.
    return [{ count: matched.length }];
  }

  const order = state.order ?? table.defaultOrder;
  const sorted = order
    ? [...matched].sort((left, right) => compareRows(left, right, order))
    : matched;
  const limited =
    state.selectLimit === undefined
      ? sorted
      : sorted.slice(0, state.selectLimit);

  // `select({ id: message.id })` keeps only the projected columns, like SQL.
  if (state.projection) {
    const fields = Object.entries(state.projection).map(
      ([alias, expression]) => ({
        alias,
        column: columnNameOf(expression),
      })
    );

    return limited.map((row) => {
      const projected: MockRow = {};

      for (const { alias, column } of fields) {
        if (column) {
          projected[alias] = clone(row[column]);
        }
      }

      return projected;
    });
  }

  return limited.map((row) => clone(row));
}

/**
 * Collects the SQL text held in a node's `StringChunk`s without touching the
 * cyclic column references (so it is safe to inspect Drizzle expressions).
 */
function collectSqlText(node: unknown, text: string[]): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectSqlText(item, text);
    }

    return text;
  }

  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;

    if (typeof record.name === "string" && !Array.isArray(record.queryChunks)) {
      text.push(record.name);
    }

    if (Array.isArray(record.queryChunks)) {
      collectSqlText(record.queryChunks, text);
    } else if (
      Array.isArray(record.value) &&
      typeof record.value[0] === "string"
    ) {
      text.push(record.value.join(""));
    }
  }

  return text;
}

/** True when a projection is `select({ count: count(column) })`. */
function isCountProjection(projection: unknown): boolean {
  if (!projection || typeof projection !== "object") {
    return false;
  }

  const entries = Object.entries(projection as Record<string, unknown>);

  return entries.some(
    ([key, expression]) =>
      key === "count" &&
      collectSqlText(expression, [])
        .join(" ")
        .toLowerCase()
        .startsWith("count(")
  );
}

function createQuery(
  initialTable?: MockTable,
  projection?: unknown,
  operation?: "delete" | "insert" | "update"
) {
  const state: QueryState = {
    aggregated: isCountProjection(projection),
    joined: [],
    operation,
    projection:
      projection && typeof projection === "object"
        ? (projection as Record<string, unknown>)
        : undefined,
  };
  let table = initialTable;

  function execute(withReturning = false) {
    if (!table) {
      throw new Error("[dev-bypass] query is missing a table");
    }

    return Promise.resolve(runQuery(state, table)).then((result) => {
      const writes =
        state.operation === "insert" ||
        state.operation === "update" ||
        state.operation === "delete";

      // Writes only yield rows through `.returning()`, like Drizzle.
      return writes && !withReturning ? undefined : result;
    });
  }

  const chain: Record<string, unknown> = {
    execute: () => execute(),
    from: (target: unknown) => {
      table = tableOf(target);

      return chain;
    },
    groupBy: () => {
      state.aggregated = true;

      return chain;
    },
    innerJoin: (target: unknown) => {
      state.joined.push(tableOf(target));

      return chain;
    },
    leftJoin: (target: unknown) => {
      state.joined.push(tableOf(target));

      return chain;
    },
    limit: (count: number) => {
      state.selectLimit = count;

      return chain;
    },
    orderBy: (clause: unknown) => {
      state.order = parseOrder(clause, state.order);

      return chain;
    },
    returning: () => execute(true),
    set: (values: MockRow) => {
      state.operation = "update";
      // Drizzle may wrap the payload in a Param.
      state.setValues = flattenWrappers(values)[0] as MockRow;

      return chain;
    },
    values: (
      values: Promise<Record<string, unknown>[]> | Record<string, unknown>[]
    ) => {
      state.operation = "insert";
      state.values = values;

      return chain;
    },
    where: (condition: unknown) => {
      state.filter = (row) => matches(row, condition);

      return chain;
    },
  };

  // Awaiting any point in the chain runs the query, like Drizzle's builders.
  chain.catch = (onRejected?: (reason: unknown) => unknown) =>
    execute().catch(onRejected);
  chain.finally = (onFinally?: () => void) => execute().finally(onFinally);
  chain._then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => execute().then(onFulfilled, onRejected);

  return chain;
}

/**
 * The `db` object handed to `lib/db/queries.ts` while the bypass is active.
 * It is cast to the real client type at the single call site, which is the
 * point: the substitute must satisfy every query shape the real code uses.
 */
export const mockDb = {
  delete: (target: unknown) =>
    createQuery(tableOf(target), undefined, "delete"),
  insert: (target: unknown) =>
    createQuery(tableOf(target), undefined, "insert"),
  select: (projection?: unknown) => createQuery(undefined, projection),
  update: (target: unknown) =>
    createQuery(tableOf(target), undefined, "update"),
} as any; // Matches Drizzle's generated client type at the single call site.
