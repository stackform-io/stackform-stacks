/**
 * Container image checks for scripts/check-images.ts: find the images in synthesised
 * templates, and check each is pinned, still published, and how far behind upstream.
 * See that script for what each check means and why.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ImageRef {
  registry: string;
  repository: string;
  tag?: string;
  digest?: string;
}

export interface Finding {
  image: string;
  blocking: string[];
  advisory: string[];
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export class SetupError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `name[:tag][@digest]`, with Docker Hub's defaults for the registry and `library/`. */
export function parseImage(image: string): ImageRef {
  const [name = "", digest] = image.split("@");
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const tag = colon > slash ? name.slice(colon + 1) : undefined;
  const fullName = colon > slash ? name.slice(0, colon) : name;

  const [first = "", ...rest] = fullName.split("/");
  const hasRegistry = rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : "registry-1.docker.io";
  let repository = hasRegistry ? rest.join("/") : fullName;
  if (registry === "registry-1.docker.io" && !repository.includes("/")) repository = `library/${repository}`;

  return { registry, repository, ...(tag !== undefined && { tag }), ...(digest !== undefined && { digest }) };
}

/** Every plain-string container image in the templates under `dir`, recursively. */
export function imagesIn(dir: string): Set<string> {
  const images = new Set<string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".template.json")) continue;
    const template: unknown = JSON.parse(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf-8"));
    const resources = isObject(template) && isObject(template.Resources) ? template.Resources : {};

    for (const resource of Object.values(resources)) {
      if (!isObject(resource) || resource.Type !== "AWS::ECS::TaskDefinition") continue;
      const containers = isObject(resource.Properties) ? resource.Properties.ContainerDefinitions : undefined;
      for (const container of Array.isArray(containers) ? containers : []) {
        if (isObject(container) && typeof container.Image === "string") images.add(container.Image);
      }
    }
  }
  return images;
}

const tokens = new Map<string, string>();

/** GET or HEAD against a registry, answering its Bearer challenge once, with retries. */
async function registryFetch(ref: ImageRef, pathname: string, method: "GET" | "HEAD"): Promise<Response> {
  const url = new URL(`https://${ref.registry}/v2/${ref.repository}/${pathname}`);
  const key = `${ref.registry}/${ref.repository}`;

  for (let attempt = 1; ; attempt++) {
    try {
      const token = tokens.get(key);
      const headers: Record<string, string> = { Accept: MANIFEST_TYPES };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, { method, headers });

      const challenge = response.headers.get("www-authenticate");
      if (response.status === 401 && !token && challenge?.startsWith("Bearer ")) {
        tokens.set(key, await fetchToken(challenge));
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (attempt >= 3) throw new SetupError(`${ref.registry}: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function fetchToken(challenge: string): Promise<string> {
  const params = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, key = "", value = ""]) => [key, value]),
  );
  if (!params.realm) throw new Error(`unsupported auth challenge: ${challenge}`);

  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  if (params.scope) url.searchParams.set("scope", params.scope);
  const body: unknown = await (await fetch(url)).json();
  const token = isObject(body) ? (body.token ?? body.access_token) : undefined;
  if (typeof token !== "string") throw new Error(`no token from ${url.origin}`);
  return token;
}

/**
 * Some repositories publish a tag per nightly build (getsentry/sentry has over 100,000),
 * so the newest-release check never lists a whole repository. It is only advisory, so it
 * stops after this many pages or this long, and says so when it could not tell.
 */
const TAG_PAGES = 10;
const TAG_BUDGET_MS = 20_000;

interface TagList {
  tags: string[];
  complete: boolean;
}

/**
 * Docker Hub: its own API, filtered to tags of the current shape and newest first, so
 * the latest releases arrive in the first page. Release tags carry a dot (`25.7.0`) and
 * nightly ones do not (`c24d832…`), and a suffix (`-python3.12`) narrows it further.
 */
async function hubTags(ref: ImageRef, nameFilter: string): Promise<TagList> {
  const tags: string[] = [];
  const url = new URL(`https://hub.docker.com/v2/repositories/${ref.repository}/tags`);
  url.searchParams.set("page_size", "100");
  url.searchParams.set("ordering", "last_updated");
  url.searchParams.set("name", nameFilter);

  let next: string | undefined = url.toString();
  for (let page = 0; next && page < 3; page++) {
    const response = await fetch(next);
    if (!response.ok) return { tags, complete: false };
    const body: unknown = await response.json();
    if (!isObject(body)) return { tags, complete: false };
    for (const result of Array.isArray(body.results) ? body.results : []) {
      if (isObject(result) && typeof result.name === "string") tags.push(result.name);
    }
    next = typeof body.next === "string" ? body.next : undefined;
  }
  // Newest first: three pages of the current shape reach past any release still ahead.
  return { tags, complete: true };
}

/** Any other registry: the Registry v2 tag list, following its pagination, bounded. */
async function registryTags(ref: ImageRef): Promise<TagList> {
  const tags: string[] = [];
  const deadline = Date.now() + TAG_BUDGET_MS;
  let pathname: string | undefined = "tags/list?n=1000";
  for (let page = 0; pathname; page++) {
    if (page >= TAG_PAGES || Date.now() > deadline) return { tags, complete: false };
    const response = await registryFetch(ref, pathname, "GET");
    if (!response.ok) return { tags, complete: false };
    const body: unknown = await response.json();
    if (isObject(body) && Array.isArray(body.tags)) tags.push(...body.tags.filter((t) => typeof t === "string"));

    // Link: </v2/<repo>/tags/list?last=...&n=1000>; rel="next"
    const link = /<[^>]*\/tags\/list\?([^>]*)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    pathname = link ? `tags/list?${link}` : undefined;
  }
  return { tags, complete: true };
}

export interface Version {
  /** Compared only with tags of the same shape: `v` prefix, number of parts, suffix. */
  shape: string;
  numbers: number[];
  suffix: string;
}

/** `v1.102.1`, `2.5.5-slim`, `3.8.6-python3.12` → its numbers, and a shape to compare within. */
export function versionOf(tag: string): Version | undefined {
  const match = /^(v?)(\d+(?:\.\d+)*)(-[A-Za-z][\w.-]*)?$/.exec(tag);
  if (!match) return undefined;
  const [, prefix = "", version = "", suffix = ""] = match;
  if (/^-(rc|alpha|beta|dev|pre|nightly|snapshot)/i.test(suffix)) return undefined;
  const numbers = version.split(".").map(Number);
  return { shape: `${prefix}${numbers.length}${suffix}`, numbers, suffix };
}

export function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkImage(image: string): Promise<Finding> {
  const finding: Finding = { image, blocking: [], advisory: [] };
  const ref = parseImage(image);

  if (!ref.tag && !ref.digest) finding.blocking.push("no tag: pin an exact version");
  if (ref.tag === "latest") finding.blocking.push("`latest` is not pinned: pin an exact version");
  if (finding.blocking.length > 0) return finding;

  const reference = ref.digest ?? ref.tag ?? "";
  const manifest = await registryFetch(ref, `manifests/${reference}`, "HEAD");
  if (manifest.status === 404) {
    finding.blocking.push(`${ref.registry} has no ${reference}: removed upstream, or mistyped`);
    return finding;
  }
  if (!manifest.ok) throw new SetupError(`${image}: registry answered HTTP ${manifest.status}`);

  const current = ref.tag ? versionOf(ref.tag) : undefined;
  if (current) {
    const { tags, complete } =
      ref.registry === "registry-1.docker.io" ? await hubTags(ref, current.suffix || ".") : await registryTags(ref);
    const newer = tags
      .map((tag) => ({ tag, version: versionOf(tag) }))
      .filter(({ version }) => version?.shape === current.shape && compare(version.numbers, current.numbers) > 0)
      .sort((a, b) => compare(b.version?.numbers ?? [], a.version?.numbers ?? []));
    const latest = newer[0];
    if (latest) finding.advisory.push(`${latest.tag} is available (${newer.length} newer release(s))`);
    else if (!complete) finding.advisory.push(`too many tags to check for a newer release (checked ${tags.length})`);
  }
  return finding;
}
