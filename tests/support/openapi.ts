/**
 * Loads pdlc/jeu-des-pronos/contracts/openapi.yaml and turns its component
 * schemas into runtime validators, so consumer-side tests assert against the
 * contract document itself rather than a hand-copied expectation of it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

export const OPENAPI_PATH = path.join(
  REPO_ROOT,
  'pdlc',
  'jeu-des-pronos',
  'contracts',
  'openapi.yaml',
);

export type OpenApiDoc = {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, unknown> };
};

let cached: OpenApiDoc | null = null;

export function openapi(): OpenApiDoc {
  if (!cached) cached = parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDoc;
  return cached;
}

/** Every (method, path, operationId) declared in the contract. */
export function contractOperations(): Array<{ operationId: string; method: string; path: string }> {
  const ops: Array<{ operationId: string; method: string; path: string }> = [];
  for (const [p, methods] of Object.entries(openapi().paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op && typeof op === 'object' && op.operationId) {
        ops.push({ operationId: op.operationId, method: method.toUpperCase(), path: p });
      }
    }
  }
  return ops;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi', components: { schemas: openapi().components.schemas } });

export function validateAgainstSchema(schemaName: string, value: unknown): string[] {
  const validate = ajv.compile({ $ref: `openapi#/components/schemas/${schemaName}` });
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}
