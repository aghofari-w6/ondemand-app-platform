import { API_SCOPES, type FieldDef } from '@aod/shared';
import { z } from 'zod';
import type { Tx } from '../db/database.ts';
import type { Platform } from './context.ts';
import { publishedDefinition } from './datastudio.ts';

/**
 * Per-tenant OpenAPI 3.1 document for the public `/v1` API: it lists only the apps this
 * tenant has active and includes the tenant's own custom fields and custom entities.
 */

const jsonSchema = (s: z.ZodType) => {
  try {
    const { $schema: _s, ...rest } = z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
    return rest;
  } catch {
    return { type: 'object' };
  }
};

const fieldSchema = (f: { type: string; options?: string[] }): Record<string, unknown> => {
  switch (f.type) {
    case 'number':
    case 'money':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
    case 'uuid':
    case 'link':
      return { type: 'string', format: 'uuid' };
    case 'select':
      return { type: 'string', enum: f.options ?? [] };
    default:
      return { type: 'string' };
  }
};

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const idemParam = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: 'Replays return the stored response for 24 hours.' };
const listParams = [
  { name: 'q', in: 'query', schema: { type: 'string' } },
  { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Field name, prefixed with - for descending.' },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
];

export async function buildOpenApi(p: Platform, tx: Tx, tenant: { slug: string; name: string }) {
  const active = (await tx.selectFrom('installed_app').select('app').where('status', '=', 'active').execute()).map((r) => r.app as string);
  const { definition, number } = await publishedDefinition(tx);
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    Error: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} } },
  };

  for (const app of active) {
    const m = p.catalog.get(app)?.manifest;
    if (!m) continue;
    for (const e of m.entities.filter((x) => x.workspace)) {
      const name = `${m.name}${e.label.replace(/\s/g, '')}`;
      const custom = definition.app_fields.find((s) => s.app === app && s.entity === e.name)?.fields ?? [];
      schemas[name] = {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          version: { type: 'integer' },
          ...Object.fromEntries(e.fields.map((f) => [f.key, { ...fieldSchema(f), description: f.label }])),
          ...(e.custom_fields ? { custom: { type: 'object', properties: Object.fromEntries(custom.map((f: FieldDef) => [f.key, { ...fieldSchema(f), description: f.label }])) } } : {}),
        },
      };
      const tag = m.name;
      paths[`/v1/apps/${app}/${e.name}`] = {
        get: { tags: [tag], summary: `List ${e.label.toLowerCase()}s`, security: [{ bearer: ['apps:read'] }, { oauth2: ['apps:read'] }], parameters: listParams, responses: { 200: { description: 'A page', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: `#/components/schemas/${name}` } }, nextCursor: { type: ['string', 'null'] } } } } } }, 401: err, 403: err } },
      };
      paths[`/v1/apps/${app}/${e.name}/{id}`] = {
        get: { tags: [tag], summary: `Get a ${e.label.toLowerCase()}`, security: [{ bearer: ['apps:read'] }, { oauth2: ['apps:read'] }], parameters: [idParam], responses: { 200: { description: 'The record', content: { 'application/json': { schema: { type: 'object', properties: { item: { $ref: `#/components/schemas/${name}` } } } } } }, 404: err } },
      };
    }
    const tpl = p.catalog.get(app)!.template;
    for (const c of m.commands) {
      paths[`/v1/apps/${app}/commands/${c.name}`] = {
        post: {
          tags: [m.name],
          summary: c.description,
          description: `Permission \`${c.permission}\`. May emit: ${c.may_emit.join(', ') || 'nothing'}.`,
          security: [{ bearer: ['apps:write'] }, { oauth2: ['apps:write'] }],
          parameters: [idemParam],
          requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(tpl.commands[c.name]!.input) } } },
          responses: { 200: { description: 'Done' }, 201: { description: 'Created' }, 409: err, 422: err },
        },
      };
    }
  }

  for (const e of definition.entities) {
    const name = `Custom${e.key.replace(/(^|_)([a-z])/g, (_m, _p, c: string) => c.toUpperCase())}`;
    const writable = e.fields.filter((f) => !f.formula);
    schemas[`${name}Values`] = {
      type: 'object',
      properties: Object.fromEntries(writable.map((f) => [f.key, { ...fieldSchema(f), description: f.label + (f.pii ? ' (PII, encrypted at rest)' : '') }])),
      required: writable.filter((f) => f.required).map((f) => f.key),
      additionalProperties: false,
    };
    schemas[name] = {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        version: { type: 'integer' },
        values: { type: 'object', properties: Object.fromEntries([...e.fields.map((f) => [f.key, { ...fieldSchema(f), ...(f.formula ? { readOnly: true, description: `= ${f.formula}` } : {}) }]), ...e.rollups.map((r) => [r.key, { type: 'number', readOnly: true, description: `${r.aggregate} of ${r.from}` }])]) },
      },
    };
    const tag = `Custom: ${e.label}`;
    paths[`/v1/records/${e.key}`] = {
      get: { tags: [tag], summary: `List ${e.label} records`, security: [{ bearer: ['records:read'] }, { oauth2: ['records:read'] }], parameters: listParams, responses: { 200: { description: 'A page', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: `#/components/schemas/${name}` } } } } } } } } },
      post: { tags: [tag], summary: `Create a ${e.label} record`, security: [{ bearer: ['records:write'] }, { oauth2: ['records:write'] }], parameters: [idemParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['values'], properties: { values: { $ref: `#/components/schemas/${name}Values` } } } } } }, responses: { 201: { description: 'Created' }, 422: err } },
    };
    paths[`/v1/records/${e.key}/{id}`] = {
      get: { tags: [tag], summary: `Get a ${e.label} record`, security: [{ bearer: ['records:read'] }, { oauth2: ['records:read'] }], parameters: [idParam], responses: { 200: { description: 'The record' }, 404: err } },
      patch: { tags: [tag], summary: `Update a ${e.label} record`, security: [{ bearer: ['records:write'] }, { oauth2: ['records:write'] }], parameters: [idParam, idemParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version', 'values'], properties: { version: { type: 'integer' }, values: { $ref: `#/components/schemas/${name}Values` } } } } } }, responses: { 200: { description: 'Updated' }, 409: err, 422: err } },
      delete: { tags: [tag], summary: `Delete a ${e.label} record`, security: [{ bearer: ['records:write'] }, { oauth2: ['records:write'] }], parameters: [idParam, { name: 'version', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Deleted' }, 409: err } },
    };
  }

  paths['/v1/sync/{syncId}'] = {
    post: {
      tags: ['Integration Hub'],
      summary: 'Push a change from your system through a two-way sync',
      security: [{ bearer: ['sync:write'] }, { oauth2: ['sync:write'] }],
      parameters: [{ name: 'syncId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['external_id', 'updated_at', 'data'], properties: { external_id: { type: 'string' }, updated_at: { type: 'string', format: 'date-time' }, data: { type: 'object' }, deleted: { type: 'boolean' } } } } } },
      responses: { 200: { description: 'Applied, stale, or resolved as a conflict' }, 404: err },
    },
  };
  paths['/v1/oauth/token'] = {
    post: {
      tags: ['Auth'],
      summary: 'OAuth 2.0 client credentials grant',
      security: [],
      requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['grant_type'], properties: { grant_type: { const: 'client_credentials' }, client_id: { type: 'string' }, client_secret: { type: 'string' }, scope: { type: 'string' } } } } } },
      responses: { 200: { description: 'Access token' }, 400: err, 401: err },
    },
  };

  return {
    openapi: '3.1.0',
    info: { title: `${tenant.name} — Apps-on-Demand API`, version: `metadata-${number}`, description: `Public API for workspace \`${tenant.slug}\`. Generated from the active apps and the published data model (version ${number}).` },
    servers: [{ url: p.env.PUBLIC_URL }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'API key (aod_key.…), OAuth access token (aod_at.…) or delegated token (aod_dt.…).' },
        oauth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: `${p.env.PUBLIC_URL}/v1/oauth/token`, scopes: API_SCOPES } } },
      },
    },
  };
}
