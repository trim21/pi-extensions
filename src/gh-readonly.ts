/**
 * GitHub Read-Only Tools Extension — extension entry point.
 *
 * The implementation lives in `src/gh/` (shared helpers in `base.ts`, one tool
 * per file in `tools/`, registration in `index.ts`). This file only forwards
 * the registration function and the public API consumed by tests.
 */

export { default } from "./gh/index.js";
export * from "./gh/index.js";
