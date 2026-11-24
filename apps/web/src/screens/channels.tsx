import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, EmptyState, ModalDialog, PageHeader, TextArea, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

/**
 * Channels: connect a Telegram bot, a Gmail mailbox and web chat widgets. Secrets are
 * write-only: a widget's identity secret is shown once, when it is created or rotated.
 */

interface Channel {
  id: string;
  kind: 'telegram' | 'gmail' | 'widget';
  name: string;
  status: 'pending' | 'active' | 'disabled' | 'needs_reconnect';
  config: { bot_username?: string; email?: string; allowed_origins?: string[]; accent?: string; greeting?: string; sla_minutes?: number };
  last_error: string | null;
  last_inbound_at: string | null;
  secret_unreadable: boolean;
  widget_key?: string;
  embed_code?: string;
  demo_url?: string;
}

const KIND_TEXT: Record<Channel['kind'], string> = { telegram: 'Telegram', gmail: 'Gmail', widget: 'Web chat widget' };
type Notice = { tone: 'success' | 'error' | 'info'; text: string };

export function ChannelsScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const readable = can(me.data, 'platform:channels.read');
  const manage = can(me.data, 'platform:channels.manage');
  const q = useQuery({ queryKey: ['channels'], queryFn: () => api('/api/channels'), enabled: readable, refetchInterval: 5000 });
  const [dialog, setDialog] = useState<'telegram' | 'widget' | 'gmail' | null>(null);
  const [removing, setRemoving] = useState<Channel | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Result of the Gmail OAuth round trip, shown once and then removed from the URL.
  const [arrival] = useState(() => {
    const p = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
    return { connected: p.get('connected'), gmailError: p.get('gmail_error') };
  });
  useEffect(() => {
    if (arrival.connected || arrival.gmailError) void navigate({ to: '/channels', replace: true });
  }, [arrival, navigate]);

  if (!readable) return <EmptyState title="Channels">Ask an Admin for access to channels.</EmptyState>;
  if (q.error) return <Alert tone="error">{(q.error as ApiError).message}</Alert>;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  if (!q.data.enabled) {
    return (
      <>
        <PageHeader title="Channels" />
        <EmptyState title="Channels need the Omnichannel package">
          <p>Your plan does not include the Omnichannel package. An Owner can change the plan under Settings.</p>
          <Link to="/settings" className="mt-2 inline-flex min-h-11 items-center font-medium text-accent underline">
            Open Settings
          </Link>
        </EmptyState>
      </>
    );
  }

  const channels = q.data.channels as Channel[];
  const gmailConfigured = Boolean(q.data.gmail_configured);
  const refresh = () => qc.invalidateQueries({ queryKey: ['channels'] });
  const run = async (fn: () => Promise<Notice | string>) => {
    setNotice(null);
    try {
      const r = await fn();
      setNotice(typeof r === 'string' ? { tone: 'success', text: r } : r);
      await refresh();
    } catch (e) {
      setNotice({ tone: 'error', text: (e as ApiError).message });
    }
  };
  const reconnect = async (c: Channel) => {
    setNotice(null);
    try {
      const r = await api<{ url: string }>('/api/channels/gmail/start', { body: { account_id: c.id } });
      window.location.assign(r.url);
    } catch (e) {
      setNotice({ tone: 'error', text: (e as ApiError).message });
    }
  };
  const connectedName = arrival.connected ? channels.find((c) => c.id === arrival.connected)?.name : null;

  return (
    <>
      <PageHeader title="Channels" description="Where customers reach you: a Telegram bot, a Gmail mailbox and a chat widget for your website. Conversations from all of them arrive in the Inbox." />
      <div className="mb-4 flex flex-col gap-3">
        {arrival.connected && <Alert tone="success">{connectedName ? `${connectedName} is connected.` : 'The Gmail mailbox is connected.'}</Alert>}
        {arrival.gmailError && (
          <Alert tone="error" title="Gmail was not connected">
            {arrival.gmailError}
          </Alert>
        )}
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {secret && (
          <Alert tone="info" title={`Identity secret for ${secret.name}: copy it now, it is shown once`}>
            <code className="break-all" data-testid="identity-secret">
              {secret.value}
            </code>
            <p className="mt-1">
              For identity verification: your website&apos;s server signs each signed-in user&apos;s id with it (HMAC-SHA256, hex) and passes the id and the hash to the widget (<code>data-user-id</code>, <code>data-user-hash</code>). It will not be
              shown again; rotate it if it is lost.
            </p>
          </Alert>
        )}
      </div>

      {manage && (
        <Card title="Add a channel" className="mb-4">
          <div className="flex flex-wrap gap-2">
            <Button onPress={() => setDialog('telegram')}>Connect Telegram</Button>
            <Button variant="secondary" onPress={() => setDialog('widget')}>
              Add web chat widget
            </Button>
            <Button variant="secondary" onPress={() => setDialog('gmail')} isDisabled={!gmailConfigured}>
              Connect Gmail
            </Button>
          </div>
          {!gmailConfigured && <p className="mt-2 text-sm text-muted">Gmail cannot be connected yet: this deployment has no Google OAuth client configured (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET).</p>}
        </Card>
      )}

      {channels.length === 0 ? (
        <EmptyState title="No channels yet">Connect Telegram, a Gmail mailbox or a web chat widget to start receiving customer conversations.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Connected channels">
          {channels.map((c) => (
            <li key={c.id}>
              <ChannelCard channel={c} manage={manage} run={run} onReconnect={() => void reconnect(c)} onDelete={() => setRemoving(c)} onSecret={(value) => setSecret({ name: c.name, value })} />
            </li>
          ))}
        </ul>
      )}

      {dialog === 'telegram' && (
        <TelegramDialog
          onClose={() => setDialog(null)}
          onDone={async (name) => {
            setNotice({ tone: 'success', text: `${name} is connected to Telegram.` });
            await refresh();
          }}
        />
      )}
      {dialog === 'widget' && (
        <WidgetDialog
          onClose={() => setDialog(null)}
          onDone={async (name, value) => {
            setSecret({ name, value });
            setNotice({ tone: 'success', text: `${name} was created. Add its embed code to your website.` });
            await refresh();
          }}
        />
      )}
      {dialog === 'gmail' && <GmailDialog onClose={() => setDialog(null)} />}
      {removing && (
        <ModalDialog title="Delete this channel?" isOpen onOpenChange={(o) => !o && setRemoving(null)}>
          <p className="mb-4 text-sm">
            <strong>{removing.name}</strong> will stop receiving messages, and its conversations are deleted too. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              onPress={async () => {
                const c = removing;
                setRemoving(null);
                await run(async () => {
                  await api(`/api/channels/${c.id}`, { method: 'DELETE' });
                  return `${c.name} was deleted.`;
                });
              }}
            >
              Delete channel
            </Button>
            <Button variant="secondary" onPress={() => setRemoving(null)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      )}
    </>
  );
}

function ChannelCard(props: { channel: Channel; manage: boolean; run: (fn: () => Promise<Notice | string>) => Promise<void>; onReconnect: () => void; onDelete: () => void; onSecret: (value: string) => void }) {
  const { channel: c, manage, run } = props;
  const [copied, setCopied] = useState(false);
  const [newToken, setNewToken] = useState('');
  const address = c.kind === 'telegram' ? (c.config.bot_username ? `@${c.config.bot_username}` : null) : c.kind === 'gmail' ? (c.config.email ?? null) : (c.config.allowed_origins ?? []).join(', ');
  const name = <span className="sr-only">: {c.name}</span>;
  return (
    <Card as="div">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{c.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{KIND_TEXT[c.kind]}</span>
            <Badge value={c.status} />
            {address && <span className="break-all">{address}</span>}
          </p>
          <p className="mt-1 text-sm text-muted">
            Last customer message: {dateTime(c.last_inbound_at)}
            {c.config.sla_minutes ? ` · First response target: ${c.config.sla_minutes} min` : ''}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {c.kind === 'gmail' && c.status === 'active' && (
              <Button
                variant="secondary"
                onPress={() =>
                  run(async () => {
                    const r = await api<{ ingested: number; status: string }>(`/api/channels/${c.id}/poll`, { body: {} });
                    const failed: Notice = { tone: 'error', text: `${c.name} must be reconnected.` };
                    return r.status === 'needs_reconnect' ? failed : `${r.ingested} new message(s) in ${c.name}.`;
                  })
                }
              >
                Check mail now{name}
              </Button>
            )}
            {(c.status === 'active' || c.status === 'disabled') && (
              <Button
                variant="secondary"
                onPress={() =>
                  run(async () => {
                    await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { status: c.status === 'active' ? 'disabled' : 'active' } });
                    return c.status === 'active' ? `${c.name} is disabled.` : `${c.name} is enabled.`;
                  })
                }
              >
                {c.status === 'active' ? 'Disable' : 'Enable'}
                {name}
              </Button>
            )}
            <Button variant="danger" onPress={props.onDelete}>
              Delete{name}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {c.kind === 'gmail' && (c.status === 'needs_reconnect' || c.status === 'pending') && (
          <Alert tone="warn" title={c.status === 'pending' ? 'Finish connecting Gmail' : 'Reconnect Gmail'}>
            <p>{c.status === 'pending' ? 'Google access was not granted yet, so no mail is read or sent.' : (c.last_error ?? 'Gmail access expired or was revoked. No mail is read or sent until the mailbox is connected again.')}</p>
            {manage && (
              <Button className="mt-2" variant="secondary" onPress={props.onReconnect}>
                Reconnect Gmail{name}
              </Button>
            )}
          </Alert>
        )}
        {c.secret_unreadable && (
          <Alert tone="warn" title="Stored credentials cannot be read">
            The stored credentials of this channel can no longer be decrypted (was the vault key changed?). {c.kind === 'gmail' ? 'Reconnect the mailbox.' : c.kind === 'widget' ? 'Rotate the identity secret.' : 'Enter the bot token again below.'}
          </Alert>
        )}
        {c.kind === 'telegram' && (c.status === 'needs_reconnect' || c.secret_unreadable) && manage && (
          <Alert tone="warn" title="Reconnect Telegram">
            <p>{c.status === 'needs_reconnect' ? (c.last_error ?? 'Telegram no longer accepts the stored bot token.') : 'No messages can be sent until the bot token is entered again.'} Conversations stay as they are.</p>
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(`/api/channels/${c.id}/telegram-token`, { body: { token: newToken.trim() } });
                  setNewToken('');
                  return `${c.name} is connected to Telegram again.`;
                });
              }}
            >
              <TextField className="min-w-64 flex-1" label={`New bot token for ${c.name}`} type="password" value={newToken} onChange={setNewToken} autoComplete="off" description="The token of the same bot, from @BotFather." />
              <Button type="submit" variant="secondary" isDisabled={!newToken.trim()}>
                Save bot token
              </Button>
            </form>
          </Alert>
        )}
        {c.last_error && c.status !== 'needs_reconnect' && <Alert tone="error">{c.last_error}</Alert>}
        {c.kind === 'gmail' && <p className="text-sm text-muted">While the Google Cloud project behind this deployment is in Testing mode, Google ends the access after 7 days: reconnect the mailbox when asked.</p>}
        {c.kind === 'telegram' && <p className="text-sm text-muted">Customers write to the bot in Telegram; replies from the Inbox and from bots are sent as the bot.</p>}
        {c.kind === 'widget' && c.embed_code && (
          <>
            <TextArea label={`Embed code for ${c.name}`} value={c.embed_code} onChange={() => undefined} rows={2} mono isReadOnly description="Paste it before the closing body tag of every page that should show the chat. Only the allowed origins may load it." />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onPress={async () => {
                  try {
                    await navigator.clipboard.writeText(c.embed_code!);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                Copy embed code{name}
              </Button>
              {c.demo_url && (
                <a href={c.demo_url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-medium text-accent underline">
                  Open demo page{name}
                </a>
              )}
              {manage && (
                <Button
                  variant="secondary"
                  onPress={() =>
                    run(async () => {
                      const r = await api<{ identity_secret: string }>(`/api/channels/${c.id}/rotate-secret`, { body: {} });
                      props.onSecret(r.identity_secret);
                      return `The identity secret of ${c.name} was rotated. Hashes made with the old secret no longer verify.`;
                    })
                  }
                >
                  Rotate identity secret{name}
                </Button>
              )}
              <span role="status" className="text-sm text-ok">
                {copied ? 'Copied' : ''}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

const minutes = (v: string): number | undefined | null => {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10080 ? n : null;
};

function TelegramDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [sla, setSla] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const m = minutes(sla);
    if (m === null) return setError('The first response target is a whole number of minutes.');
    setError(null);
    setSaving(true);
    try {
      await api('/api/channels/telegram', { body: { name: name.trim(), token: token.trim(), ...(m ? { sla_minutes: m } : {}) } });
      await onDone(name.trim());
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
      setSaving(false);
    }
  };
  return (
    <ModalDialog title="Connect Telegram" isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <TextField label="Name" value={name} onChange={setName} isRequired description="How this channel is called in the Inbox." />
        <TextField label="Bot token" type="password" value={token} onChange={setToken} isRequired autoComplete="off" description="From @BotFather. It is stored encrypted and never shown again." />
        <TextField label="First response target (minutes)" value={sla} onChange={setSla} inputMode="numeric" description="Optional. Default 15." />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isDisabled={saving || !name.trim() || !token.trim()}>
            Connect bot
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function WidgetDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string, identitySecret: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState(typeof window !== 'undefined' ? window.location.origin : '');
  const [accent, setAccent] = useState('#2856D9');
  const [greeting, setGreeting] = useState('Hi! How can we help?');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = origins.split(/\s+/).map((o) => o.trim()).filter(Boolean);
    if (!list.length) return setError('Add at least one website origin, e.g. https://www.example.com.');
    if (!/^#[0-9a-fA-F]{6}$/.test(accent.trim())) return setError('The accent colour is a hex colour such as #2856D9.');
    setError(null);
    setSaving(true);
    try {
      const r = await api<{ id: string; identity_secret: string }>('/api/channels/widget', { body: { name: name.trim(), allowed_origins: list, accent: accent.trim(), ...(greeting.trim() ? { greeting: greeting.trim() } : {}) } });
      await onDone(name.trim(), r.identity_secret);
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
      setSaving(false);
    }
  };
  return (
    <ModalDialog title="Add web chat widget" isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <TextField label="Name" value={name} onChange={setName} isRequired />
        <TextArea label="Allowed website origins" value={origins} onChange={setOrigins} rows={3} description="One per line, e.g. https://www.example.com. Only these sites may show the chat." />
        <TextField label="Accent colour" value={accent} onChange={setAccent} description="Hex, e.g. #2856D9. Text on it stays readable automatically." />
        <TextField label="Greeting" value={greeting} onChange={setGreeting} />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isDisabled={saving || !name.trim()}>
            Create widget
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function GmailDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const r = await api<{ id: string; url: string }>('/api/channels/gmail/start', { body: { name: name.trim() } });
      // Google's consent screen; it returns to this page.
      window.location.assign(r.url);
    } catch (err) {
      setError((err as ApiError).message);
      setSaving(false);
    }
  };
  return (
    <ModalDialog title="Connect Gmail" isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Name" value={name} onChange={setName} isRequired description="How this mailbox is called in the Inbox, e.g. Support mailbox." />
        <p className="text-sm text-muted">You continue at Google to choose the mailbox and allow reading and sending mail. While the Google Cloud project is in Testing mode, only its test users can connect and access must be renewed every 7 days.</p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isDisabled={saving || !name.trim()}>
            Continue with Google
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
