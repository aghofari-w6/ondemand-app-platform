import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { Button } from './ui';

export interface Me {
  user: { id: string; email: string; name: string; role: string; version: number };
  tenant: { id: string; slug: string; name: string; status: string };
  role: { name: string; preset: string | null } | null;
  permissions: string[];
  demoMode: boolean;
}

export const useMe = () =>
  useQuery<Me, ApiError>({
    queryKey: ['me'],
    queryFn: () => api('/api/auth/me'),
    retry: false,
    staleTime: 60_000,
  });

export const can = (me: Me | undefined, perm: string) => Boolean(me && (me.role?.preset === 'Owner' || me.permissions.includes(perm)));

interface NavItem {
  to: string;
  label: string;
}
export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Platform',
    items: [
      { to: '/catalog', label: 'Catalog' },
      { to: '/users', label: 'Users and roles' },
      { to: '/billing', label: 'Billing and usage' },
      { to: '/settings', label: 'Settings' },
      { to: '/audit', label: 'Audit log' },
    ],
  },
  {
    section: 'Apps',
    items: [
      { to: '/apps/ordering', label: 'Ordering' },
      { to: '/apps/pos', label: 'POS' },
      { to: '/apps/logistics', label: 'Logistics' },
      { to: '/data-studio', label: 'Data studio' },
      { to: '/workflows', label: 'Workflows' },
      { to: '/integration-hub', label: 'Integration Hub' },
    ],
  },
  { section: 'Analytics', items: [{ to: '/dashboards', label: 'Dashboards' }, { to: '/reports', label: 'Reports' }, { to: '/data-governance', label: 'Data governance' }] },
  {
    section: 'Conversations',
    items: [
      { to: '/assistant', label: 'Assistant' },
      { to: '/inbox', label: 'Inbox' },
      { to: '/channels', label: 'Channels' },
      { to: '/bot-studio', label: 'Bot Studio' },
    ],
  },
  { section: 'Operations', items: [{ to: '/approvals', label: 'Approvals' }, { to: '/trace-viewer', label: 'Trace viewer' }] },
];

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center rounded-lg px-3 text-sm text-muted hover:bg-ground hover:text-ink"
      activeProps={{ className: 'bg-accent-soft font-medium !text-accent', 'aria-current': 'page' }}
      activeOptions={{ exact: to === '/' }}
    >
      {children}
    </Link>
  );
}

export function Shell() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    if (me.error?.status === 401) void navigate({ to: '/login' });
  }, [me.error, navigate]);

  if (me.isPending || me.error) {
    return (
      <main id="main" className="grid min-h-screen place-items-center text-muted">
        {me.error && me.error.status !== 401 ? `Could not load your session: ${me.error.message}` : 'Loading…'}
      </main>
    );
  }
  const logout = async () => {
    await api('/api/auth/logout', { body: {} });
    qc.clear();
    void navigate({ to: '/login' });
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="border-b border-line bg-white lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-2 p-4">
          <Link to="/" className="flex min-h-11 items-center gap-2 font-semibold">
            <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm text-white">
              {me.data.tenant.name.slice(0, 1)}
            </span>
            <span>{me.data.tenant.name}</span>
          </Link>
        </div>
        <nav aria-label="Main" className="px-3 pb-4">
          <NavLink to="/">Home</NavLink>
          {NAV.map((s) => (
            <div key={s.section} className="mt-4">
              <h2 className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{s.section}</h2>
              <ul>
                {s.items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to}>{i.label}</NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="flex flex-wrap items-center justify-end gap-3 border-b border-line bg-white px-6 py-2">
          {me.data.tenant.status !== 'active' && (
            <span className="text-sm text-muted">
              Workspace status: <strong className="text-ink">{me.data.tenant.status}</strong>
            </span>
          )}
          <span className="text-sm text-muted">
            {me.data.user.name} · {me.data.role?.name}
          </span>
          <Button variant="secondary" onPress={logout}>
            Sign out
          </Button>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl p-6 outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
