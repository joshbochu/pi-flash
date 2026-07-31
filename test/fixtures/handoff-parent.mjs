import { HandoffController } from "../../src/handoff.ts";

const [targetCwd, launcher, output, targetFixture] = process.argv.slice(2);
const controller = new HandoffController();
controller.schedule({
  targetCwd,
  invocation: { command: launcher, args: [targetFixture, output] },
  env: process.env,
});
await controller.completePendingReplacement();
process.exit(0);
