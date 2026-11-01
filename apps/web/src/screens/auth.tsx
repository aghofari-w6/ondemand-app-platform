import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, DemoLink, TextField } from '../components/ui';
import { api, ApiError } from '../lib/api';

function AuthFrame({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main id="main" className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-accent uppercase">Apps-on-Demand</p>
        <div className="rounded-xl border border-line bg-white p-6 shadow-sm">
          <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
          {children}
        </div>
        {footer && <p className="mt-4 text-center text-sm text-muted">{footer}</p>}
      </div>
    </main>
  );
}

type Delivery = { via: string; preview?: { subject: string; link?: string } } | null;

export function SignupScreen() {
  const [f, setF] = useState({ workspaceName: '', slug: '', ownerName: '', email: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [delivery, setDelivery] = useState<Delivery>(null);
  const set = (k: keyof typeof f) => (v: string) => {
    setF((o) => {
      const n = { ...o, [k]: v };
      if (k === 'workspaceName' && !slugTouched) n.slug = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      return n;
    });
    if (k === 'slug') setSlugTouched(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ delivery: Delivery }>('/api/auth/signup', { body: f });
      setDelivery(r.delivery);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  if (delivery) {
    return (
      <AuthFrame title="Check your email">
        <p className="mb-4 text-muted">
          Your workspace <strong className="text-ink">{f.workspaceName}</strong> is ready. Open the sign-in link we sent to {f.email}.
        </p>
        {delivery.preview?.link && <DemoLink subject={delivery.preview.subject} link={delivery.preview.link} label="Open sign-in link" />}
      </AuthFrame>
    );
  }
  const fieldErr = (k: string) => (error?.code === 'invalid_input' && error.message.includes(k) ? error.message.split('; ').find((m) => m.startsWith(k)) : undefined);
  return (
    <AuthFrame title="Create your workspace" footer={<>Already have one? <Link to="/login" className="font-medium text-accent underline">Sign in</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <TextField label="Business name" value={f.workspaceName} onChange={set('workspaceName')} isRequired autoComplete="organization" error={fieldErr('workspaceName')} />
        <TextField label="Workspace address" description="Lowercase letters, digits and dashes." value={f.slug} onChange={set('slug')} isRequired error={error?.code === 'slug_taken' ? error.message : fieldErr('slug')} />
        <TextField label="Your name" value={f.ownerName} onChange={set('ownerName')} isRequired autoComplete="name" error={fieldErr('ownerName')} />
        <TextField label="Work email" type="email" value={f.email} onChange={set('email')} isRequired autoComplete="email" error={fieldErr('email')} />
        {error && error.code !== 'invalid_input' && error.code !== 'slug_taken' && <Alert tone="error">{error.message}</Alert>}
        <Button type="submit" isDisabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
        <p className="text-sm text-muted">You start on a 14-day trial with 3 app slots. You become the workspace Owner.</p>
      </form>
    </AuthFrame>
  );
}

export function LoginScreen() {
  const [f, setF] = useState({ slug: '', email: '', password: '' });
  const [mode, setMode] = useState<'link' | 'password'>('link');
  const [error, setError] = useState<ApiError | null>(null);
  const [delivery, setDelivery] = useState<Delivery | undefined>(undefined);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (mode === 'link') {
        const r = await api<{ delivery: Delivery }>('/api/auth/login', { body: { slug: f.slug, email: f.email } });
        setDelivery(r.delivery);
      } else {
        await api('/api/auth/password', { body: f });
        await qc.invalidateQueries({ queryKey: ['me'] });
        void navigate({ to: '/' });
      }
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const ssoStart = error?.code === 'sso_required' ? (error.details as { start: string }).start : null;
  return (
    <AuthFrame title="Sign in" footer={<>New here? <Link to="/signup" className="font-medium text-accent underline">Create a workspace</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <TextField label="Workspace address" value={f.slug} onChange={(v) => setF({ ...f, slug: v })} isRequired />
        <TextField label="Email" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} isRequired autoComplete="email" />
        {mode === 'password' && <TextField label="Owner password" type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} isRequired autoComplete="current-password" />}
        {error && !ssoStart && <Alert tone="error">{error.message}</Alert>}
        {ssoStart && (
          <Alert tone="info" title="This workspace uses single sign-on">
            <a className="font-medium text-accent underline" href={ssoStart}>
              Continue with single sign-on
            </a>
          </Alert>
        )}
        {delivery !== undefined &&
          (delivery?.preview?.link ? (
            <DemoLink subject={delivery.preview.subject} link={delivery.preview.link} label="Open sign-in link" />
          ) : (
            <Alert tone="info">If that email belongs to the workspace, a sign-in link is on its way.</Alert>
          ))}
        <Button type="submit">{mode === 'link' ? 'Email me a sign-in link' : 'Sign in'}</Button>
        <Button variant="ghost" onPress={() => setMode(mode === 'link' ? 'password' : 'link')}>
          {mode === 'link' ? 'Owner? Sign in with password' : 'Use a sign-in link instead'}
        </Button>
        {f.slug && (
          <a href={`/api/auth/sso/${encodeURIComponent(f.slug)}/start`} className="inline-flex min-h-11 items-center justify-center text-sm font-medium text-accent underline">
            Sign in with single sign-on
          </a>
        )}
      </form>
    </AuthFrame>
  );
}

export function VerifyScreen() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (!token) {
      setError('This link is missing its token.');
      return;
    }
    api('/api/auth/verify', { body: { token } })
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ['me'] });
        void navigate({ to: '/', replace: true });
      })
      .catch((e: ApiError) => setError(e.message));
  }, [token, navigate, qc]);
  return (
    <AuthFrame title="Signing you in">
      {error ? (
        <Alert tone="error" title="We could not sign you in">
          {error} <Link to="/login" className="underline">Request a new link</Link>
        </Alert>
      ) : (
        <p className="text-muted">One moment…</p>
      )}
    </AuthFrame>
  );
}
