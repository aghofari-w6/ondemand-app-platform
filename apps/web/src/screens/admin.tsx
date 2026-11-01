import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, Checkbox, DemoLink, EmptyState, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

const PRESETS = ['Owner', 'Admin', 'Manager', 'Staff', 'Viewer'];

// ---------------------------------------------------------------- Users and roles

export function UsersScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api('/api/roles') });
  const [invite, setInvite] = useState(false);
  const [inv, setInv] = useState({ name: '', email: '', role: 'Staff' });
  const [link, setLink] = useState<{ subject: string; link: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>('Staff');
  const [newRole, setNewRole] = useState(false);
  const manage = can(me.data, 'platform:users.manage');

  const roleOptions = [...PRESETS.map((r) => ({ id: r, label: r })), ...((roles.data?.custom ?? []) as any[]).map((r) => ({ id: r.id, label: r.name }))];
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['users'] }), qc.invalidateQueries({ queryKey: ['roles'] }), qc.invalidateQueries({ queryKey: ['tenant'] })]);

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api('/api/users/invite', { body: inv });
      setLink(r.delivery?.preview ?? null);
      setInvite(false);
      setInv({ name: '', email: '', role: 'Staff' });
      await refresh();
    } catch (err) {
      setError((err as ApiError).message);
    }
  };
  const changeRole = async (u: any, role: string) => {
    setError(null);
    try {
      await api(`/api/users/${u.id}/role`, { method: 'PATCH', body: { role, version: u.version } });
    } catch (err) {
      setError((err as ApiError).message);
    }
    await refresh();
  };

  return (
    <>
      <PageHeader title="Users and roles" actions={manage && <Button onPress={() => setInvite(true)}>Invite people</Button>} />
      {link && (
        <div className="mb-4">
          <DemoLink subject={link.subject} link={link.link} label="Invitation link" />
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <Card title="People">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-2 font-medium">Name</th>
                <th scope="col" className="py-2 font-medium">Email</th>
                <th scope="col" className="py-2 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {(users.data?.users ?? []).map((u: any) => (
                <tr key={u.id} className="border-t border-line">
                  <td className="py-2">{u.name}</td>
                  <td className="py-2">{u.email}</td>
                  <td className="py-2">
                    <Badge value={u.status} />
                  </td>
                  <td className="py-2">
                    {manage ? <Select label={`Role for ${u.name}`} value={u.role} onChange={(r) => changeRole(u, r)} options={roleOptions} /> : u.role_name}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Role preview">
          <Select label="Role" value={preview} onChange={setPreview} options={roleOptions} />
          <RolePreview role={preview} />
        </Card>
        <Card title="Custom roles">
          {(roles.data?.custom ?? []).length === 0 ? (
            <p className="text-muted">No custom roles yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {roles.data.custom.map((r: any) => (
                <li key={r.id} className="flex min-h-11 items-center justify-between">
                  <span>
                    {r.name} <span className="text-sm text-muted">· {r.permissions.length} permissions · {r.members} members</span>
                  </span>
                  <Button variant="ghost" onPress={() => setPreview(r.id)}>
                    Preview
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {can(me.data, 'platform:roles.manage') && (
            <Button variant="secondary" className="mt-3" onPress={() => setNewRole(true)}>
              New custom role
            </Button>
          )}
        </Card>
      </div>

      <ModalDialog title="Invite people" isOpen={invite} onOpenChange={setInvite}>
        <form onSubmit={sendInvite} className="flex flex-col gap-4">
          <TextField label="Name" value={inv.name} onChange={(v) => setInv({ ...inv, name: v })} isRequired />
          <TextField label="Email" type="email" value={inv.email} onChange={(v) => setInv({ ...inv, email: v })} isRequired />
          <Select label="Role" value={inv.role} onChange={(v) => setInv({ ...inv, role: v })} options={roleOptions} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onPress={() => setInvite(false)}>
              Cancel
            </Button>
            <Button type="submit">Send invitation</Button>
          </div>
        </form>
      </ModalDialog>
      <CustomRoleDialog isOpen={newRole} onClose={() => setNewRole(false)} onSaved={refresh} />
    </>
  );
}

function RolePreview({ role }: { role: string }) {
  const q = useQuery({ queryKey: ['role-preview', role], queryFn: () => api(`/api/roles/preview?role=${encodeURIComponent(role)}`) });
  if (!q.data) return null;
  return (
    <div className="mt-3 flex flex-col gap-3">
      {q.data.groups.map((g: any) => (
        <div key={g.app}>
          <h3 className="text-sm font-semibold">{g.label}</h3>
          <ul className="text-sm">
            {g.permissions.map((p: any) => (
              <li key={p.id} className={p.granted ? '' : 'text-muted'}>
                <span aria-hidden="true">{p.granted ? '✓ ' : '– '}</span>
                <span className="sr-only">{p.granted ? 'Allowed: ' : 'Not allowed: '}</span>
                {p.label}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CustomRoleDialog(props: { isOpen: boolean; onClose: () => void; onSaved: () => void }) {
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api('/api/permissions'), enabled: props.isOpen });
  const [name, setName] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/roles', { body: { name, permissions: [...sel] } });
      props.onSaved();
      props.onClose();
      setName('');
      setSel(new Set());
    } catch (err) {
      setError((err as ApiError).message);
    }
  };
  return (
    <ModalDialog title="New custom role" isOpen={props.isOpen} onOpenChange={(o) => !o && props.onClose()}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <TextField label="Role name" value={name} onChange={setName} isRequired />
        <div className="max-h-80 overflow-y-auto rounded-lg border border-line p-3">
          {(perms.data?.groups ?? []).map((g: any) => (
            <fieldset key={g.app} className="mb-2">
              <legend className="text-sm font-semibold">{g.label}</legend>
              {g.permissions
                .filter((p: any) => !p.ownerOnly)
                .map((p: any) => (
                  <Checkbox key={p.id} isSelected={sel.has(p.id)} onChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(p.id); else n.delete(p.id); return n; })}>
                    {p.label}
                  </Checkbox>
                ))}
            </fieldset>
          ))}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={props.onClose}>
            Cancel
          </Button>
          <Button type="submit">Create role</Button>
        </div>
      </form>
    </ModalDialog>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsScreen() {
  const me = useMe();
  const search = useSearch({ strict: false }) as { sso_test?: string };
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api('/api/tenant') });
  const sso = useQuery({ queryKey: ['sso'], queryFn: () => api('/api/sso'), enabled: can(me.data, 'platform:settings.manage') });
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      await Promise.all([qc.invalidateQueries({ queryKey: ['tenant'] }), qc.invalidateQueries({ queryKey: ['sso'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
    } catch (e) {
      setMsg({ tone: 'error', text: (e as ApiError).message });
    }
  };
  if (!can(me.data, 'platform:settings.manage')) return <EmptyState title="Settings">Only Owners and Admins can change workspace settings.</EmptyState>;
  return (
    <>
      <PageHeader title="Settings" />
      {search.sso_test && (
        <div className="mb-4">
          <Alert tone={search.sso_test === 'failed' ? 'error' : 'info'}>Test sign-in finished: {sso.data?.config?.lastTestResult ?? search.sso_test}</Alert>
        </div>
      )}
      {msg && (
        <div className="mb-4">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <SignInCard sso={sso.data} isOwner={me.data?.role?.preset === 'Owner'} run={run} />
        <CustomFieldsCard run={run} />
        <LifecycleCard tenant={tenant.data?.tenant} isOwner={me.data?.role?.preset === 'Owner'} run={run} />
      </div>
    </>
  );
}

function SignInCard({ sso, isOwner, run }: { sso: any; isOwner: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const cfg = sso?.config;
  const [kind, setKind] = useState<'oidc' | 'saml'>(cfg?.kind ?? 'oidc');
  const [f, setF] = useState({ issuer: cfg?.issuer ?? '', clientId: cfg?.clientId ?? '', clientSecret: '', entryPoint: cfg?.entryPoint ?? '', idpIssuer: cfg?.idpIssuer ?? '', idpCert: cfg?.idpCert ?? '' });
  const [enforce, setEnforce] = useState<boolean>(cfg?.enforce ?? false);
  const [password, setPassword] = useState('');
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body =
      kind === 'oidc'
        ? { kind, issuer: f.issuer, clientId: f.clientId, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}), enforce }
        : { kind, entryPoint: f.entryPoint, idpIssuer: f.idpIssuer, idpCert: f.idpCert, enforce };
    void run(() => api('/api/sso', { method: 'PUT', body }), 'Single sign-on saved.');
  };
  const test = () =>
    run(async () => {
      const r = await api<{ url: string }>('/api/sso/test', { body: {} });
      window.location.assign(r.url);
    }, 'Redirecting to your identity provider…');
  return (
    <Card title="Sign-in">
      <form onSubmit={save} className="flex flex-col gap-3">
        <Select label="Protocol" value={kind} onChange={setKind} options={[{ id: 'oidc', label: 'OpenID Connect' }, { id: 'saml', label: 'SAML 2.0' }]} />
        {kind === 'oidc' ? (
          <>
            <TextField label="Issuer URL" value={f.issuer} onChange={(v) => setF({ ...f, issuer: v })} />
            <TextField label="Client ID" value={f.clientId} onChange={(v) => setF({ ...f, clientId: v })} />
            <TextField label="Client secret" type="password" value={f.clientSecret} onChange={(v) => setF({ ...f, clientSecret: v })} description={cfg?.hasSecret ? 'A secret is stored (write-only). Leave empty to keep it.' : 'Stored encrypted; never shown again.'} />
            <p className="text-sm text-muted">Redirect URI: <code className="break-all">{sso?.callbackUrls.oidc}</code></p>
          </>
        ) : (
          <>
            <TextField label="IdP sign-in URL" value={f.entryPoint} onChange={(v) => setF({ ...f, entryPoint: v })} />
            <TextField label="IdP entity ID" value={f.idpIssuer} onChange={(v) => setF({ ...f, idpIssuer: v })} />
            <TextField label="IdP signing certificate (PEM body)" value={f.idpCert} onChange={(v) => setF({ ...f, idpCert: v })} />
            <p className="text-sm text-muted">ACS URL: <code className="break-all">{sso?.callbackUrls.saml}</code> · Entity ID: <code className="break-all">{sso?.callbackUrls.samlEntityId}</code></p>
          </>
        )}
        <Checkbox isSelected={enforce} onChange={setEnforce}>
          Require single sign-on (Owners can still use their password)
        </Checkbox>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Save</Button>
          {cfg && (
            <Button variant="secondary" onPress={test}>
              Test sign-in
            </Button>
          )}
        </div>
        {cfg?.lastTestAt && <p className="text-sm text-muted">Last test {dateTime(cfg.lastTestAt)}: {cfg.lastTestResult}</p>}
      </form>
      {isOwner && (
        <form
          className="mt-6 flex flex-col gap-3 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api('/api/me/password', { body: { password } }), 'Owner password set.').then(() => setPassword(''));
          }}
        >
          <h3 className="font-semibold">Owner password (fallback)</h3>
          <p className="text-sm text-muted">{sso?.ownerPasswordSet ? 'A password is set.' : 'Set one so a broken SSO setup cannot lock you out.'}</p>
          <TextField label="New password" type="password" value={password} onChange={setPassword} description="At least 12 characters." autoComplete="new-password" />
          <Button type="submit" variant="secondary">
            Set password
          </Button>
        </form>
      )}
    </Card>
  );
}

function CustomFieldsCard({ run }: { run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const targets = [
    { id: 'ordering/order', label: 'Ordering · Order' },
    { id: 'pos/sale', label: 'POS · Sale' },
    { id: 'logistics/shipment', label: 'Logistics · Shipment' },
    { id: 'payments/payment', label: 'Payments · Payment' },
  ];
  const [target, setTarget] = useState('ordering/order');
  const [app, entity] = target.split('/') as [string, string];
  const fields = useQuery({ queryKey: ['fields', target], queryFn: () => api(`/api/fields?app=${app}&entity=${entity}`) });
  const [f, setF] = useState({ key: '', label: '', type: 'text', options: '' });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/api/fields', { body: { app, entity, key: f.key, label: f.label, type: f.type, options: f.options ? f.options.split(',').map((s) => s.trim()).filter(Boolean) : [] } });
      setF({ key: '', label: '', type: 'text', options: '' });
      await fields.refetch();
    }, 'Field added.');
  };
  return (
    <Card title="Custom fields">
      <Select label="Record type" value={target} onChange={setTarget} options={targets} />
      <ul className="my-3 text-sm">
        {(fields.data?.fields ?? []).map((x: any) => (
          <li key={x.key}>
            {x.label} <span className="text-muted">({x.key}, {x.type}{x.options?.length ? `: ${x.options.join(', ')}` : ''})</span>
          </li>
        ))}
        {fields.data?.fields?.length === 0 && <li className="text-muted">No custom fields.</li>}
      </ul>
      <form onSubmit={save} className="flex flex-col gap-3">
        <TextField label="Label" value={f.label} onChange={(v) => setF({ ...f, label: v, key: f.key || '' })} />
        <TextField label="Key" description="lower_snake_case" value={f.key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')} onChange={(v) => setF({ ...f, key: v })} />
        <Select label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={['text', 'number', 'boolean', 'date', 'select'].map((t) => ({ id: t, label: t }))} />
        {f.type === 'select' && <TextField label="Options (comma separated)" value={f.options} onChange={(v) => setF({ ...f, options: v })} />}
        <Button type="submit" variant="secondary" onPress={() => !f.key && setF((o) => ({ ...o, key: o.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }))}>
          Add field
        </Button>
      </form>
    </Card>
  );
}

function LifecycleCard({ tenant, isOwner, run }: { tenant: any; isOwner: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [plan, setPlan] = useState('starter');
  const [confirm, setConfirm] = useState('');
  if (!tenant) return null;
  return (
    <Card title="Plan and workspace lifecycle">
      <p className="mb-3 flex items-center gap-2">
        Status <Badge value={tenant.status} /> · plan {tenant.planLabel}
      </p>
      {isOwner ? (
        <div className="flex flex-col gap-3">
          <Select label="Plan" value={plan} onChange={setPlan} options={[{ id: 'starter', label: 'Starter (4 app slots)' }, { id: 'growth', label: 'Growth (12 slots, all packages)' }]} />
          <Button variant="secondary" onPress={() => run(() => api('/api/tenant/lifecycle', { body: { to: 'active', plan } }), 'Plan updated; the workspace is active.')}>
            {tenant.status === 'active' ? 'Change plan' : 'Activate with this plan'}
          </Button>
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="font-semibold text-bad">Delete workspace</h3>
            <p className="text-sm text-muted">Everyone is signed out. Data is purged after 30 days; the audit log is kept.</p>
            <TextField label={`Type "${tenant.slug}" to confirm`} value={confirm} onChange={setConfirm} />
            <Button variant="danger" className="mt-2" isDisabled={confirm !== tenant.slug} onPress={() => run(() => api('/api/tenant/lifecycle', { body: { to: 'deleted', confirm } }), 'Workspace deleted.')}>
              Delete workspace
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted">Only an Owner can change the plan or delete the workspace.</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Audit log

export function AuditScreen() {
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['audit', action], queryFn: () => api(`/api/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`) });
  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of every change in this workspace." />
      <div className="mb-4 max-w-sm">
        <TextField label="Filter by action" value={action} onChange={setAction} placeholder="e.g. order.create" />
      </div>
      {q.error && <Alert tone="error">{(q.error as ApiError).message}</Alert>}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-2 font-medium">When</th>
                <th scope="col" className="py-2 font-medium">Who</th>
                <th scope="col" className="py-2 font-medium">Action</th>
                <th scope="col" className="py-2 font-medium">Resource</th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map((r: any) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-2 whitespace-nowrap">{dateTime(r.at)}</td>
                  <td className="py-2">{r.actor_type === 'System' ? `system (${r.actor_id})` : r.actor_name}</td>
                  <td className="py-2">
                    <code>{r.action}</code>
                  </td>
                  <td className="py-2 text-muted">
                    {r.resource_type} <span className="break-all">{r.resource_id.slice(0, 8)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Not-yet-built screens

export const PLANNED: Record<string, { title: string; pkg: string; milestone: string; what: string }> = {
  '/billing': { title: 'Billing and usage', pkg: 'Platform', milestone: 'Milestone F', what: 'Invoices, usage meters and payment methods. Plan changes are under Settings for now.' },
  '/data-studio': { title: 'Data studio', pkg: 'Apps', milestone: 'Milestone B (phase 2)', what: 'Draft and publish data models, custom entities, formulas, layouts and field access.' },
  '/workflows': { title: 'Workflows', pkg: 'Apps', milestone: 'Milestone C (phase 3)', what: 'Event-triggered automations built from app workflow templates.' },
  '/integration-hub': { title: 'Integration Hub', pkg: 'Apps', milestone: 'Milestone B (phase 2)', what: 'Webhooks, REST push, queues and two-way sync with your systems.' },
  '/dashboards': { title: 'Dashboards', pkg: 'Analytics', milestone: 'Milestone D (phase 4)', what: 'Live dashboards over app metrics.' },
  '/reports': { title: 'Reports', pkg: 'Analytics', milestone: 'Milestone D (phase 4)', what: 'Scheduled and ad-hoc reports.' },
  '/data-governance': { title: 'Data governance', pkg: 'Analytics', milestone: 'Milestone D (phase 4)', what: 'PII inventory, retention and access reviews.' },
  '/assistant': { title: 'Assistant', pkg: 'Bot', milestone: 'Milestone E (phase 5)', what: 'A Claude-based assistant that uses app tools within their risk tiers.' },
  '/inbox': { title: 'Inbox', pkg: 'Omnichannel', milestone: 'Milestone E (phase 5)', what: 'Customer conversations from every channel.' },
  '/channels': { title: 'Channels', pkg: 'Omnichannel', milestone: 'Milestone E (phase 5)', what: 'Connect Telegram, email and SMS.' },
  '/bot-studio': { title: 'Bot Studio', pkg: 'Bot', milestone: 'Milestone E (phase 5)', what: 'Design and test conversational bots.' },
  '/approvals': { title: 'Approvals', pkg: 'Apps', milestone: 'Milestone C (phase 3)', what: 'Approve high-risk actions from workflows and the assistant.' },
  '/trace-viewer': { title: 'Trace viewer', pkg: 'Platform', milestone: 'Milestone F (phase 6)', what: 'Follow an event from command to every consumer by correlation id.' },
};

export function PlannedScreen({ path }: { path: string }) {
  const p = PLANNED[path]!;
  return (
    <>
      <PageHeader title={p.title} />
      <EmptyState title={`${p.title} is not built yet`}>
        <p>{p.what}</p>
        <p className="mt-2">
          Part of the <strong className="text-ink">{p.pkg}</strong> package, arriving in <strong className="text-ink">{p.milestone}</strong>.
        </p>
      </EmptyState>
    </>
  );
}
