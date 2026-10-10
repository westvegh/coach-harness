// A small JSON Schema validator: the subset the signal schemas use, so the schema file
// stays the single source of truth without a new dependency.
// Supported: $ref (#/$defs/…), type, const, enum, pattern, minimum, maximum, required,
// properties, additionalProperties: false, items.

export type Schema = {
  $ref?: string;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  $defs?: Record<string, Schema>;
  [k: string]: unknown;
};

function typeOk(v: unknown, t: NonNullable<Schema["type"]>): boolean {
  switch (t) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
  }
}

/** Returns a list of errors, each `<path>: <problem>`. Empty means valid. */
export function validateSchema(value: unknown, schema: Schema, root: Schema = schema, path = "$"): string[] {
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m ? root.$defs?.[m[1]] : undefined;
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validateSchema(value, target, root, path);
  }
  const errors: string[] = [];
  if ("const" in schema && value !== schema.const) return [`${path}: must be ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`];
  if (schema.type && !typeOk(value, schema.type)) return [`${path}: must be ${schema.type === "integer" ? "an integer" : `a${schema.type === "object" || schema.type === "array" ? "n" : ""} ${schema.type}`}`];
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be ${schema.minimum} or more`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be ${schema.maximum} or less`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateSchema(item, schema.items!, root, `${path}[${i}]`)));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${path}.${k}: is required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validateSchema(v, sub, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: is not allowed`);
    }
  }
  return errors;
}
