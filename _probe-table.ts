/** TEMPORARY probe. Safe to delete. */
import { chat, user } from "./lib/db/schema.ts";

const describe = (label: string, value: object) => {
  console.log(`\n=== ${label} ===`);
  console.log("own keys:", Reflect.ownKeys(value).map(String));
  for (const key of Reflect.ownKeys(value)) {
    const item = (value as Record<string | symbol, unknown>)[key];

    if (item === null || typeof item !== "object") {
      console.log(`  ${String(key)} =`, item);
      continue;
    }

    console.log(
      `  ${String(key)} = <${item.constructor?.name}> keys:`,
      Reflect.ownKeys(item).map(String).slice(0, 12)
    );
  }
};

describe("user table", user as object);

const symbolKeys = Reflect.ownKeys(user).filter(
  (key) => typeof key === "symbol"
);

for (const key of symbolKeys) {
  console.log(`\nsymbol ${String(key)} =>`, (user as never)[key]);
}

console.log("\n--- probing common name holders ---");
for (const candidate of [
  ["user.", user],
  ["chat.", chat],
] as const) {
  const [label, table] = candidate;
  const record = table as unknown as Record<string, unknown>;
  const nested = record[Symbol.for("drizzle:Name")];

  console.log(
    label,
    "tableName:",
    record.tableName,
    "| Symbol.for(drizzle:Name):",
    nested,
    "| _:",
    JSON.stringify((record._ as { name?: string } | undefined)?.name ?? null)
  );
}
