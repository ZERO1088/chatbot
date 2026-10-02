/**
 * TEMPORARY verification for the DEV_BYPASS_DB work. Safe to delete.
 *
 * - Maps the `server-only` marker to its empty build so lib/db/queries.ts can be
 *   imported under plain Node.
 * - Resolves the extensionless relative imports the app uses (`./dev-bypass`,
 *   `./mock`, `../utils`) to their `.ts` / `.tsx` sources, which Next.js does
 *   through its bundler but plain Node does not.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes("dev-bypass") || specifier === "server-only") {
    console.log(`[hook] resolve ${specifier} from ${context.parentURL ?? "?"}`);
  }

  if (specifier === "server-only") {
    return {
      format: "module",
      shortCircuit: true,
      url: new URL("node_modules/server-only/empty.js", import.meta.url).href,
    };
  }

  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    for (const extension of [".ts", ".tsx"]) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential fallback is intentional
        const result = await nextResolve(`${specifier}${extension}`, context);
        return result;
      } catch {
        // Try the next extension.
      }
    }
  }

  return nextResolve(specifier, context);
}
