import { CommandError } from '@aod/shared';
import type { Tx } from '../db/database.ts';
import type { PlanLimits } from '../ports/index.ts';
import type { Platform } from './context.ts';

/** Packages a plan must include for the Conversations screens (config/platform.yaml). */
export const BOT_PACKAGE = 'Bot';
export const OMNICHANNEL_PACKAGE = 'Omnichannel';

/** False for a deleted tenant or a plan without the package. Never throws (consumers call it for every event). */
export async function packageEnabled(p: Platform, tx: Tx, pkg: string): Promise<boolean> {
  const t = await tx.selectFrom('tenant').select(['plan', 'status']).executeTakeFirst();
  if (!t || t.status === 'deleted') return false;
  return p.ports.billing.plan(t.plan)?.packages.includes(pkg) ?? false;
}

export async function requirePackage(p: Platform, tx: Tx, pkg: string) {
  if (!(await packageEnabled(p, tx, pkg))) throw new CommandError(403, 'not_in_plan', `your plan does not include the ${pkg} package`);
}

export async function planLimit(p: Platform, tx: Tx, key: keyof PlanLimits): Promise<number> {
  const t = await tx.selectFrom('tenant').select('plan').executeTakeFirst();
  return (t && p.ports.billing.plan(t.plan)?.limits[key]) || 0;
}
