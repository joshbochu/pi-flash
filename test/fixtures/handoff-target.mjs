import { appendFile } from "node:fs/promises";

const [output] = process.argv.slice(2);
if (process.env.PI_FLASH_TEST_RAW_MODE === "1") {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("terminal smoke target did not inherit a TTY");
  }
  process.stdin.setRawMode(true);
  process.stdin.setRawMode(false);
}
await appendFile(
  output,
  JSON.stringify({ cwd: process.cwd(), at: Date.now(), pid: process.pid, argv: process.argv.slice(2) }) + "\n",
);
