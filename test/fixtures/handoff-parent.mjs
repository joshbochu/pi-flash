import { appendFile } from "node:fs/promises";
import { startReplacement } from "../../prototypes/handoff.mjs";

const [targetCwd, launcher, output, ...launcherArgs] = process.argv.slice(2);
const eventLog = process.env.PI_FLASH_TEST_EVENT_LOG;

const child = startReplacement({
  targetCwd,
  launcher,
  launcherArgs: [...launcherArgs, output],
  env: process.env,
});

await appendFile(eventLog, `replacement-started ${Date.now()}\n`);
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`replacement exited ${code ?? signal}`));
  });
});
await appendFile(eventLog, `parent-exiting ${Date.now()}\n`);
