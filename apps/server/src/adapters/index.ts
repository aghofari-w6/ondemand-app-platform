import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { SAML } from '@node-saml/node-saml';
import { context, metrics as otelMetrics, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { sql } from 'kysely';
import * as oidc from 'openid-client';
import type { PlatformConfig } from '../config.ts';
import { BoundedCache } from './bounded-cache.ts';
import type { Auth, Billing, Channel, Files, Llm, Metrics, OidcSettings, Retriever, SamlSettings, Search, Telemetry, Vault } from '../ports/index.ts';

// ------------------------------------------------------------------ Search

/** PostgreSQL full-text search over a generated `tsvector` column (GIN index). */
export const pgSearch: Search = {
  match(column, query) {
    // websearch_to_tsquery never throws on user input; add prefix matching per word.
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 8);
    if (!words.length) return sql<boolean>`true`;
    const prefix = words.map((w) => `${w}:*`).join(' & ');
    return sql<boolean>`${sql.ref(column)} @@ to_tsquery('simple', ${prefix})`;
  },
};

// ------------------------------------------------------------------ Metrics

export function createMetrics(): Metrics {
  const meter = otelMetrics.getMeter('aod');
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  const histos = new Map<string, ReturnType<typeof meter.createHistogram>>();
  const snap: Record<string, number> = {};
  const key = (n: string, a?: Record<string, string>) => (a && Object.keys(a).length ? `${n}{${Object.entries(a).map(([k, v]) => `${k}=${v}`).join(',')}}` : n);
  return {
    increment(name, attrs, by = 1) {
      if (!counters.has(name)) counters.set(name, meter.createCounter(name));
      counters.get(name)!.add(by, attrs);
      snap[key(name, attrs)] = (snap[key(name, attrs)] ?? 0) + by;
    },
    observe(name, value, attrs) {
      if (!histos.has(name)) histos.set(name, meter.createHistogram(name));
      histos.get(name)!.record(value, attrs);
      snap[`${key(name, attrs)}:last`] = value;
    },
    snapshot: () => ({ ...snap }),
  };
}

// ------------------------------------------------------------------ Telemetry

export function createTelemetry(): Telemetry {
  const tracer = trace.getTracer('aod');
  return {
    async span(name, attrs, fn) {
      return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
        try {
          return await fn();
        } catch (e) {
          span.recordException(e as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw e;
        } finally {
          span.end();
        }
      });
    },
    traceparent() {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      if (carrier.traceparent) return carrier.traceparent;
      const sc = trace.getActiveSpan()?.spanContext();
      if (!sc || !trace.isSpanContextValid(sc)) return null;
      return `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags.toString(16)}`;
    },
  };
}

// ------------------------------------------------------------------ Vault

/** AES-256-GCM. Ciphertext format: v1.<iv>.<tag>.<data> (base64url). AAD binds it to its owner. */
export function createVault(keyB64: string | undefined, log: (m: string) => void): Vault {
  let key: Buffer;
  if (keyB64) {
    key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new Error('VAULT_KEY must be 32 bytes, base64-encoded');
  } else {
    key = randomBytes(32);
    log('VAULT_KEY is not set: using an ephemeral key; stored secrets will not survive a restart');
  }
  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad));
      const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },
    decrypt(ciphertext, aad) {
      const [v, iv, tag, data] = ciphertext.split('.');
      if (v !== 'v1' || !iv || !tag || !data) throw new Error('unsupported ciphertext');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

// ------------------------------------------------------------------ Channel

/** Demo mode: nothing is sent; the API returns the message so the UI can show it. */
export function createChannel(demoMode: boolean, log: (m: string) => void): Channel {
  return {
    async send(msg) {
      if (!demoMode) {
        // An email/SMS provider client plugs in here. Without one we log and still show nothing sensitive.
        log(`channel: no provider configured; message to ${msg.to} not sent`);
        return { via: 'none' };
      }
      return { via: 'screen', preview: { subject: msg.subject, ...(msg.link ? { link: msg.link } : {}) } };
    },
  };
}

// ------------------------------------------------------------------ Auth (OIDC + SAML)

export function createAuth(opts: { allowInsecureIssuers?: boolean } = {}): Auth {
  // Keyed by tenant-supplied issuers: bounded in size and age.
  const cache = new BoundedCache<oidc.Configuration>({ max: 500, ttlMs: 10 * 60_000 });
  async function config(s: OidcSettings) {
    const k = `${s.issuer}|${s.clientId}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const cfg = await oidc.discovery(
      new URL(s.issuer),
      s.clientId,
      undefined,
      s.clientSecret ? oidc.ClientSecretPost(s.clientSecret) : oidc.None(),
      opts.allowInsecureIssuers ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
    cache.set(k, cfg);
    return cfg;
  }
  const saml = (s: SamlSettings, callbackUrl: string) =>
    new SAML({
      entryPoint: s.entryPoint,
      issuer: s.spIssuer,
      idpIssuer: s.idpIssuer,
      idpCert: s.idpCert,
      callbackUrl,
      audience: s.spIssuer,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
    });
  return {
    async oidcAuthorizationUrl(s, p) {
      const cfg = await config(s);
      return oidc
        .buildAuthorizationUrl(cfg, {
          redirect_uri: p.redirectUri,
          scope: 'openid email profile',
          state: p.state,
          nonce: p.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(p.codeVerifier),
          code_challenge_method: 'S256',
        })
        .toString();
    },
    async oidcCallback(s, p) {
      const cfg = await config(s);
      const tokens = await oidc.authorizationCodeGrant(cfg, new URL(p.currentUrl), {
        expectedState: p.state,
        expectedNonce: p.nonce,
        pkceCodeVerifier: p.codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims?.email || claims.email_verified === false) throw new Error('identity provider did not return a verified email');
      return { email: String(claims.email).toLowerCase(), subject: claims.sub };
    },
    async samlAuthorizationUrl(s, p) {
      return saml(s, p.callbackUrl).getAuthorizeUrlAsync(p.relayState, undefined, {});
    },
    async samlCallback(s, p) {
      const { profile } = await saml(s, p.callbackUrl).validatePostResponseAsync(p.body);
      const email = (profile?.email ?? profile?.mail ?? profile?.nameID) as string | undefined;
      if (!profile || !email || !email.includes('@')) throw new Error('SAML assertion has no email');
      return { email: email.toLowerCase(), subject: profile.nameID, ...(p.body.RelayState ? { relayState: p.body.RelayState } : {}) };
    },
  };
}

// ------------------------------------------------------------------ Llm (Claude)

export function createLlm(apiKey: string | undefined, model: string, make: (apiKey: string) => Anthropic = (k) => new Anthropic({ apiKey: k })): Llm {
  // One client (and connection pool) per process, created on first use.
  let client: Anthropic | null = null;
  return {
    async complete(p) {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
      client ??= make(apiKey);
      const res = await client.messages.create({
        model,
        max_tokens: p.maxTokens ?? 1024,
        ...(p.system ? { system: p.system } : {}),
        messages: p.messages,
      });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return { text, model: res.model };
    },
  };
}

// ------------------------------------------------------------------ Billing

export function createBilling(cfg: PlatformConfig): Billing {
  return {
    plan(id) {
      const p = cfg.plans[id];
      return p ? { label: p.label, packages: p.packages, appSlots: p.app_slots, limits: p.limits } : null;
    },
    trialDays: () => cfg.trial.days,
  };
}

// ------------------------------------------------------------------ Stubs (ports not used in Milestone A)

const notYet = (port: string, milestone: string) => () => {
  throw new Error(`${port} port has no adapter before ${milestone}`);
};

export const stubFiles: Files = { put: notYet('Files', 'a later milestone'), get: notYet('Files', 'a later milestone') };
export const stubRetriever: Retriever = { retrieve: notYet('Retriever', 'the assistant milestone') };
