/**
 * Check every app against the repository conventions (README "The stack definition"
 * and CONTRIBUTING "What every stack must have").
 *
 * Usage:
 *   node scripts/check-catalogue.ts [repo-root]
 *
 * The root defaults to this script's repository. CI runs the base branch's copy of this
 * script against the PR's checkout, so a PR cannot relax the checks it is graded by.
 *
 * These are the cheap checks that need no install and no synth: the files an app must
 * ship, the shape of tool.json, and the root README table. The pre-flight gate
 * (scripts/preflight.ts) covers what the synthesised templates contain.
 */

import * as fs from "node:fs";
import * as path from "node:path";

type Json = Record<string, unknown>;

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const APPS = path.join(ROOT, "apps");

const REQUIRED_FILES = [
  "tool.json",
  "README.md",
  "preflight.json",
  "cdk.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "bin/prm-attribution.ts",
];
const REQUIRED_FIELDS = {
  slug: "string",
  name: "string",
  description: "string",
  cdkEntryPoint: "string",
  configSchema: "object",
  visibility: "string",
  category: "string",
  tags: "object",
  estimatedCost: "object",
  estimatedDuration: "string",
  logoUrl: "string",
} as const;
const VISIBILITIES = ["PUBLIC", "ORGANIZATION", "PRIVATE"];
const PROPERTY_TYPES = ["string", "number", "boolean"];

const errors: string[] = [];
const report = (app: string, message: string): void => {
  errors.push(`${app}: ${message}`);
};

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(app: string, file: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (isObject(parsed)) return parsed;
    report(app, `${path.relative(ROOT, file)} must be a JSON object`);
  } catch (error) {
    report(app, `${path.relative(ROOT, file)} is not valid JSON (${(error as Error).message})`);
  }
  return undefined;
}

function checkProperty(app: string, name: string, property: Json, properties: Json): void {
  const where = `configSchema.properties.${name}`;
  const { type, enum: choices, minimum, maximum } = property;

  if (typeof type !== "string" || !PROPERTY_TYPES.includes(type)) {
    report(app, `${where}.type must be one of ${PROPERTY_TYPES.join(", ")}`);
  }
  if (!property.title) report(app, `${where} has no title`);
  if (!property.description) report(app, `${where} has no description`);

  if ("default" in property) {
    const value = property.default;
    if (typeof value !== type) report(app, `${where}.default is not a ${String(type)}`);
    if (Array.isArray(choices) && !choices.includes(value)) report(app, `${where}.default is not in its enum`);
    if (typeof value === "number") {
      if (typeof minimum === "number" && value < minimum) report(app, `${where}.default is below minimum`);
      if (typeof maximum === "number" && value > maximum) report(app, `${where}.default is above maximum`);
    }
  } else if (type !== "string") {
    report(app, `${where} has no default (only optional strings may omit one)`);
  }

  if (type === "number" && !choices && (minimum === undefined || maximum === undefined)) {
    report(app, `${where} must be bounded by enum or minimum/maximum`);
  }

  const showWhen = property["x-showWhen"];
  for (const key of Object.keys(isObject(showWhen) ? showWhen : {})) {
    if (!(key in properties)) report(app, `${where}.x-showWhen refers to unknown property "${key}"`);
  }
}

function checkConfigSchema(app: string, schema: Json): Json {
  if (schema.type !== "object") report(app, `configSchema.type must be "object"`);
  const properties = isObject(schema.properties) ? schema.properties : {};

  for (const [name, property] of Object.entries(properties)) {
    if (isObject(property)) checkProperty(app, name, property, properties);
    else report(app, `configSchema.properties.${name} must be an object`);
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (!(String(name) in properties)) report(app, `configSchema.required lists unknown property "${String(name)}"`);
  }
  return properties;
}

function checkApp(slug: string, readme: string, seenSlugs: Map<string, string>): void {
  const dir = path.join(APPS, slug);

  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, file))) report(slug, `missing ${file}`);
  }
  if (!fs.existsSync(path.join(dir, "tool.json"))) return;

  const tool = readJson(slug, path.join(dir, "tool.json"));
  if (!tool) return;

  for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
    if (typeof tool[field] !== type || tool[field] === null) report(slug, `tool.json: "${field}" must be a ${type}`);
  }

  const toolSlug = String(tool.slug);
  if (toolSlug !== slug) report(slug, `tool.json: slug "${toolSlug}" must match the directory name`);
  const owner = seenSlugs.get(toolSlug);
  if (owner !== undefined) report(slug, `tool.json: slug "${toolSlug}" is already used by ${owner}`);
  seenSlugs.set(toolSlug, slug);

  if (typeof tool.visibility !== "string" || !VISIBILITIES.includes(tool.visibility)) {
    report(slug, `tool.json: visibility must be one of ${VISIBILITIES.join(", ")}`);
  }
  if (typeof tool.cdkEntryPoint === "string" && !fs.existsSync(path.join(dir, tool.cdkEntryPoint))) {
    report(slug, `tool.json: cdkEntryPoint ${tool.cdkEntryPoint} does not exist`);
  }
  if (typeof tool.logoUrl === "string" && !new RegExp(`^/images/apps/${slug}\\.(svg|png)$`).test(tool.logoUrl)) {
    report(slug, `tool.json: logoUrl must be /images/apps/${slug}.svg (or .png)`);
  }
  if (Array.isArray(tool.tags)) {
    if (!tool.tags.includes(slug)) report(slug, `tool.json: tags must include the slug`);
    const bad = tool.tags.filter((tag) => typeof tag !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag));
    if (bad.length > 0) report(slug, `tool.json: tags must be lowercase kebab-case (${bad.join(", ")})`);
  }
  const cost = tool.estimatedCost;
  if (isObject(cost) && (typeof cost.monthly !== "number" || !cost.description)) {
    report(slug, `tool.json: estimatedCost needs a numeric "monthly" and a "description"`);
  }

  const properties = isObject(tool.configSchema) ? checkConfigSchema(slug, tool.configSchema) : {};
  for (const key of Object.keys(isObject(tool.defaultParams) ? tool.defaultParams : {})) {
    if (!(key in properties)) report(slug, `tool.json: defaultParams.${key} is not a configSchema property`);
  }

  if (fs.existsSync(path.join(dir, "preflight.json"))) {
    const preflight = readJson(slug, path.join(dir, "preflight.json"));
    if (preflight && !isObject(preflight.variants)) {
      report(slug, `preflight.json: "variants" must be an object of name -> toolConfig`);
    }
  }

  if (fs.existsSync(path.join(dir, "package.json"))) {
    const pkg = readJson(slug, path.join(dir, "package.json"));
    if (pkg && !/^\d+\.\d+\.\d+$/.test(String(pkg.version ?? ""))) {
      report(slug, `package.json: version must be x.y.z`);
    }
  }

  if (!readme.includes(`https://dev.stackform.io/start/deploy?template=${slug})`)) {
    report(slug, `README.md: the stacks table has no deploy button for ?template=${slug}`);
  }
}

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
const apps = fs
  .readdirSync(APPS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const seenSlugs = new Map<string, string>();
for (const slug of apps) checkApp(slug, readme, seenSlugs);

// A row whose app was removed or renamed is a published button that now 404s.
for (const [, slug] of readme.matchAll(/start\/deploy\?template=([a-z0-9-]+)/g)) {
  if (slug !== undefined && !apps.includes(slug)) {
    errors.push(`README.md: deploy button for "${slug}", which has no directory under apps/`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  console.error(`\n${errors.length} problem(s) in ${apps.length} app(s).`);
  process.exit(1);
}
console.log(`${apps.length} app(s) follow the catalogue conventions.`);
