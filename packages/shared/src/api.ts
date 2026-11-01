import { z } from 'zod';
import { FieldRule, ROLE_PRESETS } from './permissions.ts';

/** Request/response schemas shared by the API and the SPA. */

export const Slug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes');

export const SignupInput = z.object({
  workspaceName: z.string().trim().min(2).max(80),
  slug: Slug,
  ownerName: z.string().trim().min(1).max(80),
  email: z.email().toLowerCase(),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  slug: Slug,
  email: z.email().toLowerCase(),
});

export const PasswordLoginInput = z.object({
  slug: Slug,
  email: z.email().toLowerCase(),
  password: z.string().min(1),
});

export const SetPasswordInput = z.object({ password: z.string().min(12).max(200) });

export const RoleRef = z.union([z.enum(ROLE_PRESETS), z.string().uuid()]);

export const InviteInput = z.object({
  email: z.email().toLowerCase(),
  name: z.string().trim().min(1).max(80),
  role: RoleRef,
});

export const ChangeRoleInput = z.object({ role: RoleRef, version: z.int().nonnegative() });

export const CustomRoleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().max(200).default(''),
  permissions: z.array(z.string()).max(500),
  fieldRules: z.array(FieldRule).max(200).default([]),
});

export const OidcConfigInput = z.object({
  kind: z.literal('oidc'),
  issuer: z.url(),
  clientId: z.string().min(1),
  /** write-only; omitted on update keeps the stored secret */
  clientSecret: z.string().min(1).optional(),
  enforce: z.boolean().default(false),
});
export const SamlConfigInput = z.object({
  kind: z.literal('saml'),
  entryPoint: z.url(),
  idpIssuer: z.string().min(1),
  idpCert: z.string().min(20),
  enforce: z.boolean().default(false),
});
export const SsoConfigInput = z.discriminatedUnion('kind', [OidcConfigInput, SamlConfigInput]);

export const ProvisionInput = z.object({
  app: z.string(),
  channel: z.enum(['stable', 'canary']).optional(),
});

export const DeprovisionInput = z.object({ mode: z.enum(['retain', 'purge']) });

export const FieldDefinitionInput = z.object({
  app: z.string(),
  entity: z.string(),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().min(1).max(60),
  type: z.enum(['text', 'number', 'boolean', 'date', 'select']),
  options: z.array(z.string().min(1)).max(50).default([]),
  required: z.boolean().default(false),
});
export type FieldDefinitionInput = z.infer<typeof FieldDefinitionInput>;

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export type ProvisioningStepName =
  | 'entitlement'
  | 'dependencies'
  | 'allocate'
  | 'migrate_seed'
  | 'config_theme'
  | 'register_contracts'
  | 'health_check'
  | 'activate';

export const PROVISION_STEPS: { name: ProvisioningStepName; label: string }[] = [
  { name: 'entitlement', label: 'Check plan entitlement' },
  { name: 'dependencies', label: 'Resolve dependencies' },
  { name: 'allocate', label: 'Allocate app slot' },
  { name: 'migrate_seed', label: 'Migrate and seed data' },
  { name: 'config_theme', label: 'Apply config and theme' },
  { name: 'register_contracts', label: 'Register contracts' },
  { name: 'health_check', label: 'Health check' },
  { name: 'activate', label: 'Activate' },
];

export const DEPROVISION_STEPS: { name: string; label: string }[] = [
  { name: 'deactivate', label: 'Deactivate app' },
  { name: 'unregister_contracts', label: 'Unregister contracts' },
  { name: 'remove_config', label: 'Remove config' },
  { name: 'data', label: 'Retain or purge data' },
  { name: 'release', label: 'Release app slot' },
];
