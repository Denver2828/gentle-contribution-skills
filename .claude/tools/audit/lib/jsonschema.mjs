// A deliberately small JSON Schema validator.
//
// Why not a dependency: this tool is installed by copying a directory, has no
// package manifest and no lockfile, and adding one would put an unaudited
// transitive tree inside the very layer whose job is to reduce unverified
// claims. The supported subset is exactly what schema/result.v1.json uses.
//
// The important property is that it FAILS CLOSED on anything it does not
// understand. An unsupported keyword throws instead of being ignored, so a
// schema can never silently stop enforcing a constraint it appears to declare.

/** Keywords that carry documentation only and never constrain a value. */
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', 'examples', '$defs', 'definitions', 'deprecated']);

/** Keywords this validator implements. */
const SUPPORTED = new Set([
  '$ref', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
]);

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) {
    throw new SchemaError(`only local $ref pointers are supported, received "${ref}"`);
  }
  let node = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === undefined || node === null || !Object.hasOwn(node, segment)) {
      throw new SchemaError(`$ref "${ref}" does not resolve`);
    }
    node = node[segment];
  }
  return node;
}

function walk(schema, value, path, root, errors) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaError(`schema at ${path || '#'} must be an object`);
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new SchemaError(`unsupported schema keyword "${keyword}" at ${path || '#'}; refusing to validate a constraint this validator would silently ignore`);
    }
  }

  if (Object.hasOwn(schema, '$ref')) {
    walk(resolveRef(schema.$ref, root), value, path, root, errors);
    return errors;
  }

  const at = path || '(root)';

  if (Object.hasOwn(schema, 'type')) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((candidate) => matchesType(value, candidate))) {
      errors.push({ path: at, message: `expected type ${expected.join(' | ')}, received ${typeOf(value)}` });
      return errors;
    }
  }

  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path: at, message: `expected constant ${JSON.stringify(schema.const)}, received ${JSON.stringify(value)}` });
  }

  if (Object.hasOwn(schema, 'enum') && !schema.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value))) {
    errors.push({ path: at, message: `expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}, received ${JSON.stringify(value)}` });
  }

  if (typeof value === 'string') {
    if (Object.hasOwn(schema, 'minLength') && value.length < schema.minLength) {
      errors.push({ path: at, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (Object.hasOwn(schema, 'maxLength') && value.length > schema.maxLength) {
      errors.push({ path: at, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (Object.hasOwn(schema, 'pattern') && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push({ path: at, message: `string does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (Object.hasOwn(schema, 'minimum') && value < schema.minimum) {
      errors.push({ path: at, message: `value below minimum ${schema.minimum}` });
    }
    if (Object.hasOwn(schema, 'maximum') && value > schema.maximum) {
      errors.push({ path: at, message: `value above maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (Object.hasOwn(schema, 'minItems') && value.length < schema.minItems) {
      errors.push({ path: at, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (Object.hasOwn(schema, 'items')) {
      value.forEach((item, index) => walk(schema.items, item, `${path}[${index}]`, root, errors));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push({ path: at, message: `missing required property "${key}"` });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, nested] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        walk(properties[key], nested, `${path}/${key}`, root, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push({ path: at, message: `unexpected property "${key}"` });
      } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
        walk(schema.additionalProperties, nested, `${path}/${key}`, root, errors);
      }
    }
  }

  return errors;
}

/**
 * Validate a value against a schema.
 *
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 * @throws  {SchemaError} when the schema itself is unusable. A broken schema is
 *          never reported as a passing document.
 */
export function validate(schema, value) {
  const errors = walk(schema, value, '', schema, []);
  return { valid: errors.length === 0, errors };
}
