const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const targets = [
  ["registry.json", "schemas/registry.schema.json"],
  ["hotwords.json", "schemas/hotwords.schema.json"],
  ["prompts.json", "schemas/prompts.schema.json"],
];

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function validate(schema, value, location, errors) {
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
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${location}.${key}: required property is missing`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, childValue] of Object.entries(value)) {
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
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${location}: expected at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => validate(schema.items, item, `${location}[${index}]`, errors));
    }
  }
}

let failed = false;

for (const [dataPath, schemaPath] of targets) {
  const data = readJson(dataPath);
  const schema = readJson(schemaPath);
  const errors = [];

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
