import { request as httpsRequest } from "node:https";

/**
 * The OTHER shape — E05a task 008.
 *
 * `./session-request.ts` exists so a spec can be honestly browser-shaped. This
 * module exists for the opposite reason: to put on the wire EXACTLY the headers
 * a `curl` or an agent sends, and nothing else, so that "the keyless path works
 * with no `Origin` at all" is a measurement rather than a hope.
 *
 * Playwright's `APIRequestContext` is a fine HTTP client, but it is a black box
 * about what it adds — and the property under test here is the ABSENCE of two
 * headers. An assertion that rests on "Playwright probably does not send
 * `Origin`" is worth nothing the day it starts to. Node's own client writes the
 * header set it is given plus `Host` and `Content-Length`, and `getHeaders()`
 * after the flush reports precisely what went out, which is why `sent` is part
 * of the result: a spec can assert on the request as well as the response.
 *
 * Not a `*.spec.ts`, so Playwright never collects it as a test file.
 */

export interface RawResponse {
  status: number;
  /** Response headers, lowercased by Node; `set-cookie` arrives as a list. */
  headers: NodeJS.Dict<string | string[]>;
  /** Every `Set-Cookie` line, in order. Empty when the response set none. */
  setCookies: string[];
  body: string;
  /** The header names this request actually wrote, lowercased. */
  sent: string[];
}

/**
 * One request, over https, with no cookie jar, no redirect following and no
 * headers beyond the ones passed in.
 *
 * `rejectUnauthorized: false` for the same reason `playwright.config.ts` sets
 * `ignoreHTTPSErrors`: the harness runs on `next dev --experimental-https`
 * (E05a D5) behind a locally-minted certificate.
 */
export function rawRequest(
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw new Error(`rawRequest speaks https only; got ${target.protocol}`);
  }

  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        method,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        headers: options.headers ?? {},
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const setCookie = res.headers["set-cookie"];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            setCookies: setCookie ?? [],
            body: Buffer.concat(chunks).toString("utf8"),
            // Read here, not before `end()`: Node adds `Content-Length` when it
            // flushes the head, so anything earlier would under-report.
            sent: Object.keys(req.getHeaders()).map((name) => name.toLowerCase()),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
