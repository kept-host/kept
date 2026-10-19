/**
 * Which kept slug a reported link names (E07 §6.8). Pure.
 *
 * Only `{slug}.{servingBaseDomain()}` is a kept page: the apex, `app.`, a
 * deeper subdomain or any other host is not. The path, query and fragment are
 * ignored (a page is one file in v1). A link pasted without a scheme is read as
 * https; any scheme but http(s) is refused.
 */
import { slugSchema } from "@kept/shared";

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function reportedSlug(link: string, baseDomain: string): string | null {
  const trimmed = link.trim();
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  return slugSchema.safeParse(slug).success ? slug : null;
}
