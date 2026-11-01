import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { allowed, AppGate, Detail, runCommand, Workspace, type AppMeta } from '../components/workspace';
import { Alert, Button, Card, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, money } from '../lib/api';
import { listQueued, NetworkError, queueSale, syncQueue, type QueuedSale } from '../lib/offline';

interface Product {
  sku: string;
  name: string;
  price: number;
}
interface Register {
  id: string;
  name: string;
  store: string;
  shift_id: string | null;
  shift_version: number | null;
}

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

async function postSale(payload: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch('/api/apps/pos/commands/sale.complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': `pos-sale-${payload.id}`, ...(payload.offline ? { 'x-aod-origin': 'pos-offline' } : {}) },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new NetworkError('offline');
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429) throw new NetworkError(`server busy (${res.status})`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? 'rejected');
  return body as { receipt_no: string; total: number };
}

const receiptNo = (register: string) => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${register.replace(/[^A-Za-z0-9]/g, '').slice(-2).toUpperCase()}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.floor(Math.random() * 900 + 100)}`;
};

export function PosScreen() {
  return <AppGate app="pos">{(meta) => <Register meta={meta} />}</AppGate>;
}

function Register({ meta }: { meta: AppMeta }) {
  const qc = useQueryClient();
  const online = useOnline();
  const registers = useQuery<{ registers: Register[] }>({ queryKey: ['pos-registers'], queryFn: () => api('/api/apps/pos/queries/registers'), staleTime: Infinity });
  const products = useQuery<{ products: Product[]; currency: string }>({ queryKey: ['pos-products'], queryFn: () => api('/api/apps/pos/queries/products'), staleTime: Infinity });
  const [regId, setRegId] = useState<string | null>(() => localStorage.getItem('aod.pos.register'));
  const [cart, setCart] = useState<{ p: Product; qty: number }[]>([]);
  const [tender, setTender] = useState<'cash' | 'card' | 'qris'>('cash');
  const [tendered, setTendered] = useState('');
  const [queued, setQueued] = useState<QueuedSale[]>([]);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info' | 'warn'; text: string } | null>(null);
  const [float, setFloat] = useState('200000');
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState('');
  const [refresh, setRefresh] = useState(0);

  const regs = registers.data?.registers ?? [];
  const reg = regs.find((r) => r.id === regId) ?? regs[0];
  const currency = products.data?.currency ?? 'IDR';
  const total = cart.reduce((s, l) => s + l.qty * l.p.price, 0);

  const refreshQueue = useCallback(async () => setQueued(await listQueued()), []);
  const sync = useCallback(async () => {
    const r = await syncQueue((s) => postSale(s.payload).then(() => undefined));
    await refreshQueue();
    if (r.synced) {
      setMsg({ tone: 'success', text: `Synced ${r.synced} offline sale${r.synced > 1 ? 's' : ''}.` });
      setRefresh((n) => n + 1);
      void qc.invalidateQueries({ queryKey: ['list'] });
    }
  }, [qc, refreshQueue]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);
  useEffect(() => {
    if (online) void sync();
    const t = setInterval(() => navigator.onLine && void sync(), 10_000);
    return () => clearInterval(t);
  }, [online, sync]);

  const add = (p: Product) => setCart((c) => (c.some((l) => l.p.sku === p.sku) ? c.map((l) => (l.p.sku === p.sku ? { ...l, qty: l.qty + 1 } : l)) : [...c, { p, qty: 1 }]));
  const dec = (sku: string) => setCart((c) => c.flatMap((l) => (l.p.sku !== sku ? [l] : l.qty > 1 ? [{ ...l, qty: l.qty - 1 }] : [])));

  const charge = async () => {
    if (!reg?.shift_id || cart.length === 0) return;
    setMsg(null);
    const payload = {
      id: crypto.randomUUID(),
      receipt_no: receiptNo(reg.name),
      register_id: reg.id,
      shift_id: reg.shift_id,
      lines: cart.map((l) => ({ sku: l.p.sku, name: l.p.name, qty: l.qty, unit_price: l.p.price })),
      tender,
      ...(tender === 'cash' && tendered ? { tendered: Number(tendered) } : {}),
      sold_at: new Date().toISOString(),
      offline: !navigator.onLine,
    };
    const enqueue = async () => {
      await queueSale({ id: payload.id, payload, queuedAt: new Date().toISOString(), attempts: 0 });
      await refreshQueue();
      setMsg({ tone: 'warn', text: `Offline: receipt ${payload.receipt_no} saved on this device and will sync when you reconnect.` });
    };
    try {
      if (!navigator.onLine) await enqueue();
      else {
        const r = await postSale(payload);
        setMsg({ tone: 'success', text: `Sale complete · receipt ${r.receipt_no} · ${money(r.total, currency)}` });
        setRefresh((n) => n + 1);
      }
      setCart([]);
      setTendered('');
    } catch (e) {
      if (e instanceof NetworkError) {
        await enqueue();
        setCart([]);
        setTendered('');
      } else setMsg({ tone: 'error', text: (e as Error).message });
    }
  };

  const openShift = async () => {
    try {
      await runCommand('pos', 'shift.open', { register_id: reg!.id, opening_float: Number(float) || 0 });
      await registers.refetch();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as ApiError).message });
    }
  };
  const closeShift = async () => {
    try {
      const r = await runCommand('pos', 'shift.close', { id: reg!.shift_id, version: reg!.shift_version, counted_cash: Number(counted) || 0 });
      setMsg({ tone: 'info', text: `Shift closed. Expected cash ${money(r.expected_cash, currency)}, variance ${money(r.variance, currency)}.` });
      setClosing(false);
      await registers.refetch();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as ApiError).message });
    }
  };

  return (
    <>
      <PageHeader
        title="POS"
        description={reg ? `${reg.store} · ${reg.name}` : 'Choose a register'}
        actions={
          <div className="flex items-center gap-3" role="status" aria-live="polite">
            <span className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ${online ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>{online ? 'Online' : 'Offline'}</span>
            <span className="text-sm text-muted" data-testid="queue-count">
              {queued.length} sale{queued.length === 1 ? '' : 's'} waiting to sync
            </span>
            {queued.length > 0 && online && (
              <Button variant="secondary" onPress={sync}>
                Sync now
              </Button>
            )}
          </div>
        }
      />
      {msg && (
        <div className="mb-4">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      {queued.some((q) => q.rejected) && (
        <div className="mb-4">
          <Alert tone="error" title="Some offline sales were rejected">
            {queued
              .filter((q) => q.rejected)
              .map((q) => `${q.payload.receipt_no}: ${q.lastError}`)
              .join(' · ')}
          </Alert>
        </div>
      )}
      <div className="mb-4 max-w-sm">
        <Select
          label="Register"
          value={reg?.id ?? null}
          onChange={(v) => {
            setRegId(v);
            localStorage.setItem('aod.pos.register', v);
          }}
          options={regs.map((r) => ({ id: r.id, label: `${r.store} · ${r.name}${r.shift_id ? ' (open)' : ''}` }))}
        />
      </div>
      {reg && !reg.shift_id ? (
        <Card title="Open a shift">
          <div className="flex flex-wrap items-end gap-3">
            <TextField label="Opening float" inputMode="numeric" value={float} onChange={setFloat} />
            <Button onPress={openShift} isDisabled={!allowed(meta, 'shift.open')}>
              Open shift
            </Button>
          </div>
        </Card>
      ) : (
        reg && (
          <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
            <Card title="Products">
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Products">
                {(products.data?.products ?? []).map((p) => (
                  <li key={p.sku}>
                    <Button variant="secondary" className="h-24 w-full flex-col" onPress={() => add(p)} aria-label={`Add ${p.name}`}>
                      <span className="font-semibold">{p.name}</span>
                      <span className="text-muted">{money(p.price, currency)}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Cart">
              {cart.length === 0 ? (
                <p className="text-muted">Tap a product to add it.</p>
              ) : (
                <ul className="flex flex-col" aria-label="Cart">
                  {cart.map((l) => (
                    <li key={l.p.sku} className="flex items-center justify-between gap-2 border-b border-line py-1">
                      <span>
                        {l.p.name} × {l.qty}
                      </span>
                      <span className="flex items-center gap-1">
                        {money(l.p.price * l.qty, currency)}
                        <Button variant="ghost" aria-label={`Remove one ${l.p.name}`} onPress={() => dec(l.p.sku)}>
                          −
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 flex justify-between text-lg font-semibold">
                <span>Total</span> <span data-testid="cart-total">{money(total, currency)}</span>
              </p>
              <div className="mt-3 flex flex-col gap-3">
                <Select label="Tender" value={tender} onChange={setTender} options={[{ id: 'cash', label: 'Cash' }, { id: 'card', label: 'Card' }, { id: 'qris', label: 'QRIS' }]} />
                {tender === 'cash' && <TextField label="Cash received" inputMode="numeric" value={tendered} onChange={setTendered} description={tendered && Number(tendered) >= total ? `Change ${money(Number(tendered) - total, currency)}` : undefined} />}
                <Button onPress={charge} isDisabled={cart.length === 0 || !allowed(meta, 'sale.complete')}>
                  Charge {money(total, currency)}
                </Button>
                <Button variant="secondary" onPress={() => setClosing(true)} isDisabled={!online}>
                  Close shift
                </Button>
              </div>
            </Card>
          </div>
        )
      )}
      <h2 className="mt-8 mb-3 text-lg font-semibold">Sales</h2>
      <Workspace meta={meta} entity="sale" columns={['receipt_no', 'status', 'store', 'tender', 'total', 'offline', 'sold_at']} detailPath={(id) => `/apps/pos/sales/${id}`} refreshKey={refresh} />
      <ModalDialog title="Close shift" isOpen={closing} onOpenChange={setClosing}>
        <TextField label="Counted cash in drawer" inputMode="numeric" value={counted} onChange={setCounted} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onPress={() => setClosing(false)}>
            Cancel
          </Button>
          <Button onPress={closeShift}>Close shift</Button>
        </div>
      </ModalDialog>
    </>
  );
}

export function SaleDetailScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <AppGate app="pos">
      {(meta) => (
        <Detail
          meta={meta}
          entity="sale"
          id={id}
          title={(s) => `Receipt ${s.receipt_no}`}
          actions={(s, refresh) =>
            s.status === 'completed' &&
            allowed(meta, 'sale.void') && (
              <VoidSaleButton sale={s} onDone={refresh} />
            )
          }
        />
      )}
    </AppGate>
  );
}

/** Voids a sale; a refused void (permission, stale version) is shown, never swallowed. */
function VoidSaleButton(props: { sale: { id: string; version: number }; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="danger"
        onPress={async () => {
          setError(null);
          try {
            await runCommand('pos', 'sale.void', { id: props.sale.id, version: props.sale.version, reason: 'Voided at register' });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
          props.onDone();
        }}
      >
        Void sale
      </Button>
      {error && <Alert tone="error">The sale was not voided: {error}</Alert>}
    </div>
  );
}
