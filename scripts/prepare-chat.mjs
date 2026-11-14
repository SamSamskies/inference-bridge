/** Bundle pinned, local ESM dependencies; no remotely hosted extension code. */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function prepareChat(root = fileURLToPath(new URL("../", import.meta.url))) {
  const target = `${root}/ui/vendor`;
  mkdirSync(target, { recursive: true });
  for (const [source, name] of [
    ["marked/lib/marked.esm.js", "marked.js"],
    ["marked/lib/marked.esm.js.map", "marked.esm.js.map"],
    ["marked/LICENSE", "marked-LICENSE"],
    ["dompurify/dist/purify.es.mjs", "purify.js"],
    ["dompurify/dist/purify.es.mjs.map", "purify.es.mjs.map"],
    ["dompurify/LICENSE", "dompurify-LICENSE"],
  ]) copyFileSync(`${root}/node_modules/${source}`, `${target}/${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) prepareChat();
