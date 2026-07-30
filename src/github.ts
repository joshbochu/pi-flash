import { CommandError, runCommand } from "./process.js";

export interface GitHubIdentity {
  login: string;
  organizations: string[];
}

const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})?$/;

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function assertLogin(login: string): string {
  if (!loginPattern.test(login)) throw new Error("GitHub returned an invalid login");
  return login;
}

export async function discoverGitHubIdentity(): Promise<GitHubIdentity> {
  const login = await getGitHubLogin();

  const organizations = await runCommand(
    "gh",
    ["api", "--hostname", "github.com", "user/orgs", "--paginate", "--jq", ".[].login"],
    { timeoutMs: 20_000 },
  );
  if (organizations.code !== 0) {
    throw new CommandError("Could not discover GitHub organizations", organizations);
  }
  return { login, organizations: [...new Set(lines(organizations.stdout).map(assertLogin))].sort() };
}

/** Returns the active github.com identity used for default branch namespaces. */
export async function getGitHubLogin(): Promise<string> {
  const user = await runCommand("gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"], {
    timeoutMs: 15_000,
  });
  if (user.code !== 0) {
    throw new CommandError("GitHub authentication for github.com is required", user);
  }
  return assertLogin(lines(user.stdout)[0] ?? "");
}
