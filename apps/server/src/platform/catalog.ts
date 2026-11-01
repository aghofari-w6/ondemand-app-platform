import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareVersions,
  parseManifestYaml,
  PLATFORM_PERMISSIONS,
  type Command,
  type CommandSpec,
  type Entity,
  type Manifest,
  type PermissionDef,
  type TemplateModule,
} from '@aod/shared';
import type { PlatformConfig } from '../config.ts';

export interface CatalogApp {
  manifest: Manifest;
  template: TemplateModule;
}

/** Loads and validates every template manifest; the source of truth for contracts. */
export class Catalog {
  readonly apps = new Map<string, CatalogApp>();
  readonly permissions: PermissionDef[];
  readonly config: PlatformConfig;

  constructor(templates: TemplateModule[], config: PlatformConfig) {
    this.config = config;
    for (const t of templates) {
      const dir = join(t.dir, 'migrations');
      const sources = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
      const manifest = parseManifestYaml(readFileSync(join(t.dir, 'manifest.yaml'), 'utf8'), sources);
      if (manifest.id !== t.id) throw new Error(`template ${t.id} ships manifest ${manifest.id}`);
      for (const c of manifest.commands) {
        if (!t.commands[c.name]) throw new Error(`${t.id}: manifest command ${c.name} has no handler`);
      }
      for (const name of Object.keys(t.commands)) {
        if (!manifest.commands.some((c) => c.name === name)) throw new Error(`${t.id}: handler ${name} is not declared in the manifest`);
      }
      for (const c of manifest.events.consumes) {
        if (!t.consumers?.[c.consumer]) throw new Error(`${t.id}: consumer ${c.consumer} has no handler`);
        if (c.capability && !config.capabilities.some((k) => k.id === c.capability)) throw new Error(`${t.id}: unknown capability ${c.capability}`);
      }
      const ch = config.channels[t.id];
      if (!ch) throw new Error(`config/platform.yaml has no channels for ${t.id}`);
      for (const v of [ch.stable, ch.canary].filter(Boolean) as string[]) {
        if (!manifest.releases.some((r) => r.version === v)) throw new Error(`${t.id}: channel version ${v} is not a release`);
      }
      this.apps.set(t.id, { manifest, template: t });
    }
    for (const m of this.manifests()) {
      for (const dep of [...m.dependencies.requires, ...m.dependencies.optional]) {
        if (!this.apps.has(dep)) throw new Error(`${m.id}: unknown dependency ${dep}`);
      }
    }
    this.permissions = [...PLATFORM_PERMISSIONS, ...this.manifests().flatMap((m) => m.permissions)];
  }

  manifests(): Manifest[] {
    return [...this.apps.values()].map((a) => a.manifest);
  }

  get(app: string): CatalogApp | undefined {
    return this.apps.get(app);
  }

  command(app: string, name: string): { def: Command; spec: CommandSpec; entity: Entity } | undefined {
    const a = this.apps.get(app);
    const def = a?.manifest.commands.find((c) => c.name === name);
    const spec = a?.template.commands[name];
    const entity = a?.manifest.entities.find((e) => e.name === def?.entity);
    return a && def && spec && entity ? { def, spec, entity } : undefined;
  }

  entity(app: string, name: string): Entity | undefined {
    return this.apps.get(app)?.manifest.entities.find((e) => e.name === name);
  }

  release(app: string, version: string) {
    return this.apps.get(app)?.manifest.releases.find((r) => r.version === version);
  }

  channelVersion(app: string, channel: 'stable' | 'canary'): string {
    const ch = this.config.channels[app]!;
    return (channel === 'canary' ? ch.canary : undefined) ?? ch.stable;
  }

  /** Capability rules satisfied by a set of active apps. */
  activeCapabilities(activeApps: string[]): string[] {
    return this.config.capabilities.filter((c) => c.when_installed.every((a) => activeApps.includes(a))).map((c) => c.id);
  }

  isUpgrade(from: string, to: string) {
    return compareVersions(to, from) > 0;
  }
}
