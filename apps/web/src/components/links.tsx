import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Card } from './ui';
import { api, label } from '../lib/api';

/** Records linked to this one across apps (link index). */
export function LinkedRecords({ type, id }: { type: string; id: string }) {
  const q = useQuery({ queryKey: ['links', type, id], queryFn: () => api(`/api/links?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`), refetchInterval: 5000 });
  const links = (q.data?.links ?? []) as any[];
  return (
    <Card title="Linked records">
      {links.length === 0 ? (
        <p className="text-sm text-muted">No linked records.</p>
      ) : (
        <ul className="flex flex-col text-sm">
          {links.map((l) => (
            <li key={`${l.direction}${l.rel}${l.type}${l.id}`} className="flex min-h-11 items-center justify-between gap-2 border-b border-line last:border-0">
              <span className="text-muted">{label(l.rel)}</span>
              {l.path ? (
                <Link to={l.path} className="font-medium text-accent underline">
                  {l.label} {l.title ?? l.id.slice(0, 8)}
                </Link>
              ) : (
                <span>
                  {l.label} {l.title ?? l.id.slice(0, 8)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {q.data?.hidden > 0 && <p className="mt-2 text-sm text-muted">{q.data.hidden} linked record(s) you cannot see.</p>}
    </Card>
  );
}
