#!/usr/bin/env node
/**
 * Check every app against the repository conventions (README "The stack definition"
 * and CONTRIBUTING "What every stack must have").
 *
 * Usage:
 *   node scripts/check-catalogue.mjs
 *
 * These are the cheap checks that need no install and no synth: the files an app must
 * ship, the shape of tool.json, and the root README table. The pre-flight gate
 * (scripts/preflight.mjs) covers what the synthesised templates contain.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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
};
const VISIBILITIES = ["PUBLIC", "ORGANIZATION", "PRIVATE"];
const PROPERTY_TYPES = ["string", "number", "boolean"];

const errors = [];
const report = (app, message) => errors.push(`${app}: ${message}`);

function readJson(app, file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    report(app, `${path.relative(ROOT, file)} is not valid JSON (${error.message})`);
    return undefined;
  }
}

function checkConfigSchema(app, schema) {
  if (schema.type !== "object") report(app, `configSchema.type must be "object"`);
  const properties = schema.properties ?? {};

  for (const [name, property] of Object.entries(properties)) {
    const where = `configSchema.properties.${name}`;
    if (!PROPERTY_TYPES.includes(property.type)) report(app, `${where}.type must be one of ${PROPERTY_TYPES.join(", ")}`);
    if (!property.title) report(app, `${where} has no title`);
    if (!property.description) report(app, `${where} has no description`);

    if ("default" in property) {
      if (typeof property.default !== property.type) report(app, `${where}.default is not a ${property.type}`);
      if (property.enum && !property.enum.includes(property.default)) report(app, `${where}.default is not in its enum`);
      if (property.minimum !== undefined && property.default < property.minimum) report(app, `${where}.default is below minimum`);
      if (property.maximum !== undefined && property.default > property.maximum) report(app, `${where}.default is above maximum`);
    } else if (property.type !== "string") {
      report(app, `${where} has no default (only optional strings may omit one)`);
    }

    if (property.type === "number" && !property.enum && (property.minimum === undefined || property.maximum === undefined)) {
      report(app, `${where} must be bounded by enum or minimum/maximum`);
    }

    for (const key of Object.keys(property["x-showWhen"] ?? {})) {
      if (!(key in properties)) report(app, `${where}.x-showWhen refers to unknown property "${key}"`);
    }
  }

  for (const name of schema.required ?? []) {
    if (!(name in properties)) report(app, `configSchema.required lists unknown property "${name}"`);
  }
  return properties;
}

function checkApp(slug, readme, seenSlugs) {
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

  if (tool.slug !== slug) report(slug, `tool.json: slug "${tool.slug}" must match the directory name`);
  if (seenSlugs.has(tool.slug)) report(slug, `tool.json: slug "${tool.slug}" is already used by ${seenSlugs.get(tool.slug)}`);
  seenSlugs.set(tool.slug, slug);

  if (!VISIBILITIES.includes(tool.visibility)) report(slug, `tool.json: visibility must be one of ${VISIBILITIES.join(", ")}`);
  if (tool.cdkEntryPoint && !fs.existsSync(path.join(dir, tool.cdkEntryPoint))) {
    report(slug, `tool.json: cdkEntryPoint ${tool.cdkEntryPoint} does not exist`);
  }
  if (tool.logoUrl && !new RegExp(`^/images/apps/${slug}\\.(svg|png)$`).test(tool.logoUrl)) {
    report(slug, `tool.json: logoUrl must be /images/apps/${slug}.svg (or .png)`);
  }
  if (Array.isArray(tool.tags)) {
    if (!tool.tags.includes(slug)) report(slug, `tool.json: tags must include the slug`);
    const bad = tool.tags.filter((tag) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag));
    if (bad.length > 0) report(slug, `tool.json: tags must be lowercase kebab-case (${bad.join(", ")})`);
  }
  if (tool.estimatedCost && (typeof tool.estimatedCost.monthly !== "number" || !tool.estimatedCost.description)) {
    report(slug, `tool.json: estimatedCost needs a numeric "monthly" and a "description"`);
  }

  const properties = tool.configSchema ? checkConfigSchema(slug, tool.configSchema) : {};
  for (const key of Object.keys(tool.defaultParams ?? {})) {
    if (!(key in properties)) report(slug, `tool.json: defaultParams.${key} is not a configSchema property`);
  }

  const preflight = fs.existsSync(path.join(dir, "preflight.json")) && readJson(slug, path.join(dir, "preflight.json"));
  if (preflight && (typeof preflight.variants !== "object" || Array.isArray(preflight.variants))) {
    report(slug, `preflight.json: "variants" must be an object of name -> toolConfig`);
  }

  const pkg = fs.existsSync(path.join(dir, "package.json")) && readJson(slug, path.join(dir, "package.json"));
  if (pkg && !/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) report(slug, `package.json: version must be x.y.z`);

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

const seenSlugs = new Map();
apps.forEach((slug) => checkApp(slug, readme, seenSlugs));

// A row whose app was removed or renamed is a published button that now 404s.
for (const [, slug] of readme.matchAll(/start\/deploy\?template=([a-z0-9-]+)/g)) {
  if (!apps.includes(slug)) errors.push(`README.md: deploy button for "${slug}", which has no directory under apps/`);
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(`::error::${error}`));
  console.error(`\n${errors.length} problem(s) in ${apps.length} app(s).`);
  process.exit(1);
}
console.log(`${apps.length} app(s) follow the catalogue conventions.`);
