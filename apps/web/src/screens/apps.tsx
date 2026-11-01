import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { allowed, AppGate, Detail, runCommand, Workspace, type AppMeta } from '../components/workspace';
import { Alert, Button, Card, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, money } from '../lib/api';

function useCommand(app: string, onDone: () => void) {
  const [error, setError] = useState<string | null>(null);
  const exec = async (command: string, input: unknown) => {
    setError(null);
    try {
      const r = await runCommand(app, command, input);
      onDone();
      return r;
    } catch (e) {
      setError((e as ApiError).message);
      return null;
    }
  };
  return { exec, error };
}

// ---------------------------------------------------------------- Ordering

const NEXT: Record<string, string> = { new: 'Confirm', confirmed: 'Start preparing', preparing: 'Mark ready', ready: 'Complete' };

export function OrderingScreen() {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  return (
    <AppGate app="ordering">
      {(meta) => (
        <>
          <PageHeader title="Ordering" description="Orders from every channel, including POS sales." actions={allowed(meta, 'order.create') && <Button onPress={() => setOpen(true)}>New order</Button>} />
          <Workspace meta={meta} entity="order" columns={['number', 'status', 'channel', 'store', 'customer_name', 'total', 'placed_at']} detailPath={(id) => `/apps/ordering/${id}`} initialView="all" refreshKey={refresh} />
          <NewOrderDialog meta={meta} isOpen={open} onClose={() => setOpen(false)} onCreated={() => setRefresh((n) => n + 1)} />
        </>
      )}
    </AppGate>
  );
}

function NewOrderDialog({ meta, isOpen, onClose, onCreated }: { meta: AppMeta; isOpen: boolean; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ customer_name: '', channel: 'web', item: 'Caffè latte', qty: '1', price: '38000' });
  const [custom, setCustom] = useState<Record<string, string>>({});
  const { exec, error } = useCommand('ordering', () => {
    onCreated();
    onClose();
  });
  const defs = meta.customFields.order ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c: Record<string, unknown> = {};
    for (const d of defs) if (custom[d.key]) c[d.key] = d.type === 'number' ? Number(custom[d.key]) : d.type === 'boolean' ? custom[d.key] === 'true' : custom[d.key];
    void exec('order.create', { channel: f.channel, customer_name: f.customer_name || undefined, lines: [{ sku: f.item.slice(0, 3).toUpperCase(), name: f.item, qty: Number(f.qty), unit_price: Number(f.price) }], custom: c });
  };
  return (
    <ModalDialog title="New order" isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Customer" value={f.customer_name} onChange={(v) => setF({ ...f, customer_name: v })} />
        <Select label="Channel" value={f.channel} onChange={(v) => setF({ ...f, channel: v })} options={['web', 'phone', 'marketplace'].map((c) => ({ id: c, label: c }))} />
        <TextField label="Item" value={f.item} onChange={(v) => setF({ ...f, item: v })} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Quantity" inputMode="numeric" value={f.qty} onChange={(v) => setF({ ...f, qty: v })} />
          <TextField label="Unit price" inputMode="numeric" value={f.price} onChange={(v) => setF({ ...f, price: v })} />
        </div>
        {defs.map((d) =>
          d.type === 'select' ? (
            <Select key={d.key} label={d.label} value={custom[d.key] ?? null} onChange={(v) => setCustom({ ...custom, [d.key]: v })} options={d.options.map((o) => ({ id: o, label: o }))} />
          ) : (
            <TextField key={d.key} label={d.label} value={custom[d.key] ?? ''} onChange={(v) => setCustom({ ...custom, [d.key]: v })} />
          ),
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit">Place order</Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function Lines({ app, query, id, currency }: { app: string; query: string; id: string; currency: string }) {
  const q = useQuery({ queryKey: ['lines', app, id], queryFn: () => api(`/api/apps/${app}/queries/${query}?id=${id}`) });
  return (
    <Card title="Items">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th scope="col" className="py-1 font-medium">Item</th>
            <th scope="col" className="py-1 font-medium">Qty</th>
            <th scope="col" className="py-1 font-medium">Price</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.lines ?? []).map((l: any, i: number) => (
            <tr key={i} className="border-t border-line">
              <td className="py-1">{l.name}</td>
              <td className="py-1">{l.qty}</td>
              <td className="py-1">{money(l.unit_price, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function OrderDetailScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <AppGate app="ordering">
      {(meta) => (
        <Detail
          meta={meta}
          entity="order"
          id={id}
          title={(o) => `Order ${o.number}`}
          extra={() => <Lines app="ordering" query="lines" id={id} currency={meta.config.currency} />}
          actions={(o, refresh) => <OrderActions meta={meta} order={o} refresh={refresh} />}
        />
      )}
    </AppGate>
  );
}

function OrderActions({ meta, order, refresh }: { meta: AppMeta; order: any; refresh: () => void }) {
  const { exec, error } = useCommand('ordering', refresh);
  return (
    <>
      {NEXT[order.status] && allowed(meta, 'order.advance') && <Button onPress={() => exec('order.advance', { id: order.id, version: order.version })}>{NEXT[order.status]}</Button>}
      {!['cancelled', 'completed'].includes(order.status) && allowed(meta, 'order.cancel') && (
        <Button variant="danger" onPress={() => exec('order.cancel', { id: order.id, version: order.version, reason: 'Cancelled by staff' })}>
          Cancel order
        </Button>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </>
  );
}

// ---------------------------------------------------------------- Logistics

const SHIP_NEXT: Record<string, string[]> = {
  pending: ['picked_up', 'exception'],
  picked_up: ['in_transit', 'exception'],
  in_transit: ['out_for_delivery', 'delivered', 'exception'],
  out_for_delivery: ['delivered', 'exception'],
  exception: ['in_transit', 'out_for_delivery', 'delivered'],
  delivered: [],
};

export function LogisticsScreen() {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  return (
    <AppGate app="logistics">
      {(meta) => (
        <>
          <PageHeader title="Logistics" description="Shipments for Ordering orders. Carriers post status updates to the inbound endpoint." actions={allowed(meta, 'shipment.create') && <Button onPress={() => setOpen(true)}>New shipment</Button>} />
          <Workspace meta={meta} entity="shipment" columns={['tracking_no', 'order_number', 'carrier', 'status', 'destination', 'created_at']} detailPath={(id) => `/apps/logistics/${id}`} initialView="all" refreshKey={refresh} />
          <NewShipmentDialog isOpen={open} onClose={() => setOpen(false)} onCreated={() => setRefresh((n) => n + 1)} />
          {allowed(meta, 'carrier.connect') && <CarrierCard />}
        </>
      )}
    </AppGate>
  );
}

function CarrierCard() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/api/auth/me') });
  const [carrier, setCarrier] = useState('jne');
  const [token, setToken] = useState<string | null>(null);
  const { exec, error } = useCommand('logistics', () => {});
  return (
    <Card className="mt-4" title="Carrier callbacks">
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Carrier" value={carrier} onChange={setCarrier} options={['jne', 'sicepat', 'gosend', 'internal'].map((c) => ({ id: c, label: c.toUpperCase() }))} />
        <Button variant="secondary" onPress={async () => setToken(((await exec('carrier.connect', { carrier })) as any)?.token ?? null)}>
          Issue callback token
        </Button>
      </div>
      {token && (
        <Alert tone="info" title="Copy this token now; it is shown once">
          <p className="break-all">
            POST {window.location.origin}/v1/inbound/{me.data?.tenant.id}/logistics/carrier/{carrier}
          </p>
          <p className="break-all">X-Carrier-Token: {token}</p>
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Card>
  );
}

function NewShipmentDialog({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: () => void }) {
  const orders = useQuery({ queryKey: ['shippable'], queryFn: () => api('/api/apps/logistics/queries/shippable_orders'), enabled: isOpen });
  const [order, setOrder] = useState<string | null>(null);
  const [carrier, setCarrier] = useState('jne');
  const [destination, setDestination] = useState('');
  const { exec, error } = useCommand('logistics', () => {
    onCreated();
    onClose();
  });
  return (
    <ModalDialog title="New shipment" isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (order) void exec('shipment.create', { order_id: order, carrier, destination: destination || undefined });
        }}
      >
        <Select label="Order" value={order} onChange={setOrder} options={(orders.data?.orders ?? []).map((o: any) => ({ id: o.order_id, label: `#${o.number} · ${o.store ?? 'no store'} · ${o.status}` }))} />
        <Select label="Carrier" value={carrier} onChange={setCarrier} options={['jne', 'sicepat', 'gosend', 'internal'].map((c) => ({ id: c, label: c.toUpperCase() }))} />
        <TextField label="Destination" value={destination} onChange={setDestination} />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!order}>
            Create shipment
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function ShipmentDetailScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <AppGate app="logistics">
      {(meta) => (
        <Detail
          meta={meta}
          entity="shipment"
          id={id}
          title={(s) => `Shipment ${s.tracking_no}`}
          actions={(s, refresh) => <ShipmentActions meta={meta} s={s} refresh={refresh} />}
        />
      )}
    </AppGate>
  );
}

function ShipmentActions({ meta, s, refresh }: { meta: AppMeta; s: any; refresh: () => void }) {
  const { exec, error } = useCommand('logistics', refresh);
  if (!allowed(meta, 'shipment.update_status')) return null;
  return (
    <>
      {(SHIP_NEXT[s.status] ?? []).map((to) => (
        <Button key={to} variant={to === 'exception' ? 'danger' : 'secondary'} onPress={() => exec('shipment.update_status', { id: s.id, version: s.version, status: to, ...(to === 'exception' ? { note: 'Reported by staff' } : {}) })}>
          {to.replace(/_/g, ' ')}
        </Button>
      ))}
      {error && <Alert tone="error">{error}</Alert>}
    </>
  );
}

// ---------------------------------------------------------------- Payments

export function PaymentsScreen() {
  const [refresh, setRefresh] = useState(0);
  const [amount, setAmount] = useState('50000');
  const [reference, setReference] = useState('');
  const { exec, error } = useCommand('payments', () => setRefresh((n) => n + 1));
  return (
    <AppGate app="payments">
      {(meta) => (
        <>
          <PageHeader title="Payments" description="Test-mode provider: captures succeed unless you make the next one fail." />
          <Card className="mb-4" title="Capture a test payment">
            <div className="flex flex-wrap items-end gap-3">
              <TextField label="Reference" value={reference} onChange={setReference} />
              <TextField label="Amount" inputMode="numeric" value={amount} onChange={setAmount} />
              <Button isDisabled={!allowed(meta, 'payment.capture') || !reference} onPress={() => exec('payment.capture', { reference, amount: Number(amount), method: 'card' })}>
                Capture
              </Button>
              {allowed(meta, 'settings.update') && (
                <Button variant="secondary" onPress={() => exec('settings.update', { fail_next_capture: true })}>
                  Make the next capture fail
                </Button>
              )}
            </div>
            {error && <Alert tone="error">{error}</Alert>}
          </Card>
          <Workspace meta={meta} entity="payment" columns={['reference', 'status', 'method', 'amount', 'provider_ref', 'created_at']} detailPath={(id) => `/apps/payments/${id}`} initialView="all" refreshKey={refresh} />
        </>
      )}
    </AppGate>
  );
}

export function PaymentDetailScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <AppGate app="payments">
      {(meta) => (
        <Detail
          meta={meta}
          entity="payment"
          id={id}
          title={(p) => `Payment ${p.reference}`}
          actions={(p, refresh) => <RefundButton meta={meta} p={p} refresh={refresh} />}
        />
      )}
    </AppGate>
  );
}

function RefundButton({ meta, p, refresh }: { meta: AppMeta; p: any; refresh: () => void }) {
  const { exec, error } = useCommand('payments', refresh);
  if (p.status !== 'captured' || !allowed(meta, 'payment.refund')) return null;
  return (
    <>
      <Button variant="danger" onPress={() => exec('payment.refund', { id: p.id, version: p.version })}>
        Refund
      </Button>
      {error && <Alert tone="error">{error}</Alert>}
    </>
  );
}
