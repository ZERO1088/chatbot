/**
 * TEMPORARY verification for the DEV_BYPASS_DB work. Safe to delete.
 * Bootstrap that registers the module resolution hooks before the entry point
 * is resolved.
 */
import { register } from "node:module";

register("./_server-only-hook.mjs", import.meta.url);
