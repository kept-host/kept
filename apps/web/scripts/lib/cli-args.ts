/**
 * Argument and environment reading shared by the scripts in `apps/web/scripts`.
 *
 * Extracted from `smoke-release.ts` (E02 task 008) when `seed-edge-canary.ts`
 * (E03 task 009) needed the identical `--edge-url` handling: the seeder and the
 * probe must resolve the same target from the same flag, or the smoke asserts
 * against a page the seeder never wrote.
 *
 * SCRIPT SCOPE ONLY. App code reads its configuration through
 * `lib/storage/env.ts`, which validates per concern and is the single accessor
 * a route handler may use. `requireEnv` below exists for the variables only a
 * script touches (e.g. `DATABASE_URL` for the release probe's direct query).
 */

/** Assert a variable is present and non-blank, naming it if it is not. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing ${name}. Set it in apps/web/.env.local (see .env.example).`,
    );
  }
  return v.trim();
}

/** `--flag value`, `--flag=value`, then the env fallback. */
export function readOption(flag: string, envName: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${flag}=`));
  if (inline) {
    const v = inline.slice(flag.length + 3).trim();
    if (v !== "") return v;
  }
  const i = argv.indexOf(`--${flag}`);
  if (i !== -1) {
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) return v.trim();
  }
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() !== "" ? fromEnv.trim() : undefined;
}

/** The same value, required and validated as an http(s) URL. */
export function requireUrl(flag: string, envName: string): string {
  const raw = readOption(flag, envName);
  if (!raw) {
    throw new Error(`Missing target URL. Pass --${flag} <url> or set ${envName}.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for --${flag}/${envName}: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--${flag}/${envName} must be http(s): "${raw}"`);
  }
  return url.toString();
}
