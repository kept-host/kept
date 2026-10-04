/**
 * Cloudflare GraphQL Analytics client for the visits sync — E06 task 009 (D8).
 *
 * Visits are read IN BULK from Cloudflare's own aggregates, once a day, and
 * never counted per view: the serve path (`apps/edge`) writes nothing and knows
 * nothing about this module. One request reads one window's request counts per
 * hostname from `httpRequestsAdaptiveGroups`; `map.ts` turns hostnames into
 * sites and `sync.ts` writes the rows.
 *
 *   POST https://api.cloudflare.com/client/v4/graphql   { query, variables }
 *
 * THE FILTERS ARE THE PRD'S (§5.6): status 200, HTML responses, real clients
 * (`requestSource: "eyeball"`). Each was checked against the live schema on
 * 2026-10-04: Cloudflare validates field and argument names before it checks
 * the token's permissions, and the query below parsed and failed only on
 * `authz`. What that cannot prove is that this zone's PLAN exposes all three —
 * the `settings` probe (`probeVisitsSettings`, `availableFields`) is the check
 * for that, and a field it reports missing is dropped from `VISITS_QUERY` and
 * named in the PR. The numbers are sampled and approximate by design.
 *
 * CREDENTIAL: the existing `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` through
 * `purgeConfig()` — no second accessor for the same two variables and no new
 * secret. The token needs `Zone → Analytics → Read` on top of its purge scope.
 *
 * FAILURE IS A THROW HERE, the opposite of `purge.ts`. A purge runs after the
 * page is already correct, so its failure must not fail a publish. A sync that
 * silently wrote nothing would show creators a stale "as of" forever; the route
 * turns this throw into a non-2xx so the scheduled run goes red. Cloudflare
 * answers HTTP 200 with an `errors` array for most refusals — including a token
 * without the analytics scope — so the body is checked, not just the status.
 */
import { z } from "zod";

import { CF_API, purgeConfig } from "../storage/env";

const GRAPHQL_ENDPOINT = `${CF_API}/graphql`;

/**
 * `limit` on every visits query. A window that returns exactly this many
 * groups may have been truncated, so `fetchVisitGroups` re-reads it by hour.
 */
const VISITS_GROUP_LIMIT = 10_000;

const VISITS_QUERY = `query Visits($zone: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(
        limit: ${VISITS_GROUP_LIMIT}
        filter: {
          datetime_geq: $start
          datetime_lt: $end
          edgeResponseStatus: 200
          edgeResponseContentTypeName: "html"
          requestSource: "eyeball"
        }
      ) {
        count
        dimensions { clientRequestHTTPHost }
      }
    }
  }
}`;

const SETTINGS_QUERY = `query VisitsSettings($zone: string!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      settings {
        httpRequestsAdaptiveGroups {
          enabled
          availableFields
          maxDuration
          maxPageSize
          notOlderThan
        }
      }
    }
  }
}`;

const visitGroupSchema = z.object({
  count: z.number().int().nonnegative(),
  dimensions: z.object({ clientRequestHTTPHost: z.string() }),
});

/** One hostname's request count for the queried window. */
export type VisitGroup = z.infer<typeof visitGroupSchema>;

const visitsResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      zones: z
        .array(z.object({ httpRequestsAdaptiveGroups: z.array(visitGroupSchema) }))
        .length(1, "expected exactly one zone — check CLOUDFLARE_ZONE_ID"),
    }),
  }),
});

const visitsSettingsSchema = z.object({
  enabled: z.boolean(),
  availableFields: z.array(z.string()),
  /** Widest window one query may span, in seconds. */
  maxDuration: z.number(),
  maxPageSize: z.number(),
  /** How far back a query may read, in seconds. */
  notOlderThan: z.number(),
});

/** The zone's limits for `httpRequestsAdaptiveGroups`, from its `settings` node. */
export type VisitsSettings = z.infer<typeof visitsSettingsSchema>;

const settingsResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      zones: z
        .array(
          z.object({
            settings: z.object({ httpRequestsAdaptiveGroups: visitsSettingsSchema }),
          }),
        )
        .length(1, "expected exactly one zone — check CLOUDFLARE_ZONE_ID"),
    }),
  }),
});

const errorsSchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .nullish(),
});

/**
 * POST one query and return the parsed body, or throw with Cloudflare's own
 * error text. A non-2xx and a 200 carrying `errors` are both failures.
 */
async function postQuery(query: string, variables: Record<string, string>): Promise<unknown> {
  const { zoneId, apiToken } = purgeConfig();
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { zone: zoneId, ...variables } }),
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const errors = errorsSchema.safeParse(body).data?.errors ?? [];
  const detail = errors
    .map((e) => (e.extensions?.code ? `${e.extensions.code}: ` : "") + (e.message ?? "unknown"))
    .join("; ");

  if (!res.ok) {
    throw new Error(`Cloudflare GraphQL HTTP ${res.status}: ${detail || text.slice(0, 500)}`);
  }
  if (errors.length > 0) throw new Error(`Cloudflare GraphQL: ${detail}`);
  return body;
}

/**
 * The groups inside one visits response. Exported so a captured response can
 * be read by exactly the parser the live path uses.
 */
export function visitGroupsOf(body: unknown): VisitGroup[] {
  return visitsResponseSchema.parse(body).data.viewer.zones[0]!.httpRequestsAdaptiveGroups;
}

/** The raw response body for one `[start, end)` window — what a capture records. */
export function fetchVisitsResponse(start: Date, end: Date): Promise<unknown> {
  return postQuery(VISITS_QUERY, { start: start.toISOString(), end: end.toISOString() });
}

/**
 * Per-hostname request counts for `[start, end)`.
 *
 * A window that comes back holding exactly `VISITS_GROUP_LIMIT` groups may be
 * truncated, so it is re-read as one-hour windows and the groups concatenated;
 * the mapper sums repeated hosts, so the hours add up without a merge step.
 */
export async function fetchVisitGroups(start: Date, end: Date): Promise<VisitGroup[]> {
  const groups = visitGroupsOf(await fetchVisitsResponse(start, end));
  if (groups.length < VISITS_GROUP_LIMIT) return groups;

  const hourly: VisitGroup[] = [];
  for (let from = start; from < end; ) {
    const nextHour = new Date(from);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    const to = nextHour < end ? nextHour : end;
    hourly.push(...visitGroupsOf(await fetchVisitsResponse(from, to)));
    from = to;
  }
  return hourly;
}

/**
 * The zone's `settings` node for the dataset (PRD §5.6): whether it is
 * enabled, which fields the plan exposes, and `maxDuration` / `notOlderThan`.
 * Read before trusting the filters above, and by the live drills to tell an
 * analytics-scoped token from one that only purges.
 */
export async function probeVisitsSettings(): Promise<VisitsSettings> {
  const body = await postQuery(SETTINGS_QUERY, {});
  return settingsResponseSchema.parse(body).data.viewer.zones[0]!.settings
    .httpRequestsAdaptiveGroups;
}
