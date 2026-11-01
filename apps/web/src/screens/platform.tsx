import { PROVISION_STEPS, DEPROVISION_STEPS } from '@aod/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, ModalDialog, PageHeader, Select } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

// ---------------------------------------------------------------- Home ("hello tenant")

export function HomeScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ['tenant'], queryFn: () => api('/api/tenant') });
  if (!t.data) return <p className="text-muted">Loading…</p>;
  const d = t.data;
  const doneCount = d.onboarding.steps.filter((s: any) => s.done).length;
  const dismiss = async () => {
    await api('/api/tenant/onboarding/dismiss', { body: {} });
    await qc.invalidateQueries({ queryKey: ['tenant'] });
  };
  return (
    <>
      <PageHeader title={`Hello, ${d.tenant.name}`} description={<>Signed in as {me.data?.user.name}. Workspace <code>{d.tenant.slug}</code>.</>} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Plan">
          <p className="flex items-center gap-2">
            {d.tenant.planLabel} <Badge value={d.tenant.status} />
          </p>
          {d.tenant.status === 'trial' && <p className="mt-1 text-sm text-muted">Trial ends {dateTime(d.tenant.trialEndsAt)}</p>}
        </Card>
        <Card title="App slots">
          <p className="text-2xl font-semibold">
            {d.slots.used} <span className="text-base font-normal text-muted">of {d.slots.total} used</span>
          </p>
        </Card>
        <Card title="Apps">
          {d.apps.length === 0 ? (
            <p className="text-muted">No apps yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {d.apps.map((a: any) => (
                <li key={a.app} className="flex items-center justify-between gap-2">
                  <span className="capitalize">{a.app}</span> <Badge value={a.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {!d.onboarding.dismissed && (
        <Card className="mt-4" title={`Get started (${doneCount} of ${d.onboarding.steps.length})`}>
          <ol className="flex flex-col gap-1">
            {d.onboarding.steps.map((s: any) => (
              <li key={s.key} className="flex min-h-11 items-center gap-3">
                <span aria-hidden="true" className={`grid h-6 w-6 place-items-center rounded-full text-xs ${s.done ? 'bg-ok text-white' : 'border border-line text-muted'}`}>
                  {s.done ? '✓' : ''}
                </span>
                {s.done ? (
                  <span className="text-muted line-through">{s.label}</span>
                ) : (
                  <Link to={s.to} className="font-medium text-accent underline">
                    {s.label}
                  </Link>
                )}
                <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
              </li>
            ))}
          </ol>
          {can(me.data, 'platform:settings.manage') && (
            <Button variant="ghost" className="mt-2" onPress={dismiss}>
              Hide checklist
            </Button>
          )}
        </Card>
      )}
      {d.capabilities.some((c: any) => c.active) && (
        <Card className="mt-4" title="Active capabilities">
          <ul className="list-disc pl-5 text-sm">
            {d.capabilities.filter((c: any) => c.active).map((c: any) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Catalog

export function CatalogScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cat = useQuery({ queryKey: ['catalog'], queryFn: () => api('/api/catalog') });
  const [channel, setChannel] = useState<Record<string, 'stable' | 'canary'>>({});
  const [remove, setRemove] = useState<{ app: string; name: string } | null>(null);
  const [mode, setMode] = useState<'retain' | 'purge'>('retain');
  const [error, setError] = useState<string | null>(null);
  const mayProvision = can(me.data, 'platform:apps.provision');

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api<{ runId: string }>(path, { body }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      void navigate({ to: '/provisioning/$runId', params: { runId: r.runId } });
    },
    onError: (e: ApiError) => setError(e.message),
  });
  const pin = async (app: string, version: string | null) => {
    setError(null);
    try {
      await api(`/api/apps/${app}/pin`, version ? { method: 'PUT', body: { version } } : { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['catalog'] });
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (!cat.data) return <p className="text-muted">Loading…</p>;
  const { plan, apps } = cat.data;
  return (
    <>
      <PageHeader title="Catalog" description={`${plan.label} plan · ${plan.used} of ${plan.slots} app slots used · packages: ${plan.packages.join(', ')}`} />
      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <ul className="grid gap-4 md:grid-cols-2" aria-label="Apps">
        {apps.map((a: any) => (
          <li key={a.id}>
            <Card as="div" className="flex h-full flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">{a.name}</h2>
                  <p className="text-sm text-muted">
                    {a.package} package · stable {a.channels.stable}
                    {a.channels.canary ? ` · canary ${a.channels.canary}` : ''}
                  </p>
                </div>
                {a.installed && <Badge value={a.installed.status} />}
              </div>
              <p className="text-sm">{a.description}</p>
              {a.dependencies.requires.length > 0 && <p className="text-sm text-muted">Requires: {a.dependencies.requires.join(', ')}</p>}
              {a.capabilities.length > 0 && (
                <ul className="text-sm text-muted">
                  {a.capabilities.map((c: any) => (
                    <li key={c.id}>
                      {c.active ? '● ' : '○ '}
                      {c.label}
                    </li>
                  ))}
                </ul>
              )}
              {a.installed && (
                <p className="text-sm">
                  Version {a.installed.version} ({a.installed.channel}){a.pin ? ` · pinned to ${a.pin}` : ''}
                  {a.installed.status === 'retained' && <> · data kept until {dateTime(a.installed.retainedUntil)}</>}
                </p>
              )}
              {!a.canProvision && !a.installed && a.reasons.length > 0 && (
                <ul className="text-sm text-warn">
                  {a.reasons.map((r: string) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <div className="mt-auto flex flex-wrap items-end gap-2 pt-2">
                {a.openRun && (
                  <Link to="/provisioning/$runId" params={{ runId: a.openRun.id }} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-accent underline">
                    View {a.openRun.kind} run ({a.openRun.status})
                  </Link>
                )}
                {mayProvision && !a.openRun && (!a.installed || ['retained', 'failed'].includes(a.installed.status)) && (
                  <>
                    {a.channels.canary && (
                      <Select
                        label={`Channel for ${a.name}`}
                        value={channel[a.id] ?? 'stable'}
                        onChange={(v) => setChannel({ ...channel, [a.id]: v })}
                        options={[
                          { id: 'stable', label: `Stable (${a.channels.stable})` },
                          { id: 'canary', label: `Canary (${a.channels.canary})` },
                        ]}
                      />
                    )}
                    <Button isDisabled={!a.canProvision || act.isPending} onPress={() => act.mutate({ path: `/api/apps/${a.id}/provision`, body: { channel: channel[a.id] ?? 'stable' } })} aria-label={`Provision ${a.name}`}>
                      {a.installed?.status === 'retained' ? 'Restore' : 'Provision'}
                    </Button>
                  </>
                )}
                {mayProvision && a.installed?.status === 'active' && !a.openRun && (
                  <>
                    <Link to={appHome(a.id)} className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium">
                      Open {a.name}
                    </Link>
                    {a.upgradeAvailable && (
                      <Button variant="secondary" isDisabled={Boolean(a.pin)} onPress={() => act.mutate({ path: `/api/apps/${a.id}/upgrade`, body: { channel: a.installed.channel } })}>
                        Upgrade to {a.upgradeAvailable}
                      </Button>
                    )}
                    <Button variant="ghost" onPress={() => pin(a.id, a.pin ? null : a.installed.version)}>
                      {a.pin ? 'Unpin' : `Pin ${a.installed.version}`}
                    </Button>
                    <Button variant="danger" onPress={() => setRemove({ app: a.id, name: a.name })}>
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <ModalDialog title={`Remove ${remove?.name ?? ''}`} isOpen={remove !== null} onOpenChange={(o) => !o && setRemove(null)}>
        <Select
          label="What happens to the data?"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'retain', label: 'Keep it for 30 days (restore by provisioning again)' },
            { id: 'purge', label: 'Delete it now' },
          ]}
        />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onPress={() => setRemove(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onPress={() => {
              act.mutate({ path: `/api/apps/${remove!.app}/deprovision`, body: { mode } });
              setRemove(null);
            }}
          >
            Remove app
          </Button>
        </div>
      </ModalDialog>
    </>
  );
}

export const appHome = (id: string) => (id === 'payments' ? '/apps/payments' : `/apps/${id}`);

// ---------------------------------------------------------------- Provisioning run (live checklist over SSE)

export function ProvisioningScreen() {
  const { runId } = useParams({ strict: false }) as { runId: string };
  const qc = useQueryClient();
  const [run, setRun] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const es = new EventSource(`/api/provisioning/runs/${runId}/stream`);
    es.addEventListener('run', (e) => setRun(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('error', () => es.close());
    return () => es.close();
  }, [runId, tick]);

  useEffect(() => {
    if (run && ['succeeded', 'compensated'].includes(run.status)) {
      void qc.invalidateQueries({ queryKey: ['catalog'] });
      void qc.invalidateQueries({ queryKey: ['tenant'] });
    }
  }, [run, qc]);

  const action = async (what: 'retry' | 'rollback') => {
    setError(null);
    try {
      await api(`/api/provisioning/runs/${runId}/${what}`, { body: {} });
      setTick((t) => t + 1);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (!run) return <p className="text-muted">Connecting…</p>;
  const labels = new Map([...PROVISION_STEPS, ...DEPROVISION_STEPS].map((s) => [s.name, s.label]));
  const verb = { provision: 'Provisioning', deprovision: 'Removing', upgrade: 'Upgrading' }[run.kind as string] ?? run.kind;
  return (
    <>
      <PageHeader title={`${verb} ${run.app}`} description={<>Version {run.target_version} · <Badge value={run.status} /></>} />
      <Card>
        <ol aria-label="Steps" aria-live="polite" className="flex flex-col">
          {run.steps.map((s: any, i: number) => (
            <li key={s.step} className="flex min-h-12 items-center gap-3 border-b border-line last:border-0">
              <span aria-hidden="true" className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${stepTone(s.status)}`}>
                {s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'compensated' ? '↺' : i + 1}
              </span>
              <span className="flex-1">{labels.get(s.step) ?? s.step}</span>
              <span className="text-sm text-muted">
                {s.status}
                {s.attempts > 1 ? ` · ${s.attempts} attempts` : ''}
              </span>
            </li>
          ))}
        </ol>
      </Card>
      {run.status === 'failed' && (
        <div className="mt-4 flex flex-col gap-3">
          <Alert tone="error" title="This run stopped">
            {run.error}
          </Alert>
          <div className="flex gap-2">
            <Button onPress={() => action('retry')}>Retry from the failed step</Button>
            <Button variant="danger" onPress={() => action('rollback')}>
              Roll back
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {run.status === 'succeeded' && (
        <div className="mt-4 flex flex-col gap-3">
          <Alert tone="success" title="Done">
            {run.kind === 'provision' ? `${run.app} is active.` : run.kind === 'upgrade' ? `${run.app} now runs ${run.target_version}.` : `${run.app} was removed.`}
          </Alert>
          <div className="flex gap-2">
            {run.kind !== 'deprovision' && (
              <Link to={appHome(run.app)} className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white">
                Open {run.app}
              </Link>
            )}
            <Link to="/catalog" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-medium">
              Back to catalog
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

const stepTone = (s: string) =>
  ({ done: 'bg-ok text-white', failed: 'bg-bad text-white', running: 'bg-accent text-white', compensated: 'bg-warn-soft text-warn', skipped: 'bg-ground text-muted' })[s] ?? 'border border-line text-muted';
