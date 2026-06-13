import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const targets: [string, string][] = [
  ["registry.json", "schemas/registry.schema.json"],
  ["hotwords.json", "schemas/hotwords.schema.json"],
  ["prompts.json", "schemas/prompts.schema.json"],
];

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

interface Schema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
}

function validate(
  schema: Schema | boolean | null | undefined,
  value: unknown,
  location: string,
  errors: string[],
): void {
  if (schema === true || schema == null) return;
  if (schema === false) {
    errors.push(`${location}: value is not allowed`);
    return;
  }

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((expected) => matchesType(value, expected))) {
      errors.push(`${location}: expected ${expectedTypes.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${location}: expected one of ${schema.enum.join(", ")}`);
  }

  if (schema.type === "object" || (schema.properties && typeOf(value) === "object")) {
    const required = schema.required || [];
    const obj = value as Record<string, unknown>;
    for (const key of required) {
      if (!Object.hasOwn(obj, key)) {
        errors.push(`${location}.${key}: required property is missing`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, childValue] of Object.entries(obj)) {
      const childSchema = properties[key];
      if (childSchema) {
        validate(childSchema, childValue, `${location}.${key}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${location}.${key}: unknown property`);
      } else if (typeof schema.additionalProperties === "object") {
        validate(schema.additionalProperties, childValue, `${location}.${key}`, errors);
      }
    }
  }

  if (schema.type === "array" || (schema.items && Array.isArray(value))) {
    const arr = value as unknown[];
    if (schema.minItems != null && arr.length < schema.minItems) {
      errors.push(`${location}: expected at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      arr.forEach((item, index) => {
        validate(schema.items as Schema, item, `${location}[${index}]`, errors);
      });
    }
  }
}

function readJson(relativePath: string): unknown {
  const fullPath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

let failed = false;

for (const [dataPath, schemaPath] of targets) {
  const data = readJson(dataPath);
  const schema = readJson(schemaPath) as Schema;
  const errors: string[] = [];

  if (data && typeof data === "object" && !Array.isArray(data) && "$schema" in data) {
    errors.push("$: data files must not include $schema; schemas are mapped by script");
  }

  validate(schema, data, "$", errors);

  if (errors.length > 0) {
    failed = true;
    console.error(`\n${dataPath} failed ${schemaPath}:`);
    for (const error of errors) console.error(`  - ${error}`);
  } else {
    console.log(`${dataPath} ok`);
  }
}

if (failed) process.exit(1);
