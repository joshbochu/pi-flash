import { appendFile, writeFile } from "node:fs/promises";
import { startReplacement } from "../../prototypes/handoff.mjs";

const [targetCwd, launcher, output, ...launcherArgs] = process.argv.slice(2);
const eventLog = process.env.PI_FLASH_TEST_EVENT_LOG;

startReplacement({
  targetCwd,
  launcher,
  launcherArgs: [...launcherArgs, output],
  env: process.env,
});

await writeFile(eventLog, `parent-exiting ${Date.now()}\n`, { flag: "a" });
process.exit(0);
