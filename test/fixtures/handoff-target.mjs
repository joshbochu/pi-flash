import { appendFile } from "node:fs/promises";

const [output] = process.argv.slice(2);
await appendFile(
  output,
  JSON.stringify({ cwd: process.cwd(), at: Date.now(), argv: process.argv.slice(2) }) + "\n",
);
