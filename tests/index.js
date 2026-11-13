// Entry point for `node --test tests/`. Node 22 resolves a directory argument as a module
// (tests/index.js) instead of scanning it, so this file imports every *.test.js beside it.
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(here).filter((n) => n.endsWith(".test.js")).sort()) {
  await import(pathToFileURL(`${here}/${name}`).href);
}
