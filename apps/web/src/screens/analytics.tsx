import {
  RELATIVE_RANGES,
  resolveRange,
  type RelativeRange,
  type Widget,
} from "@aod/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BarChart,
  KpiTile,
  LineChart,
  TopTable,
  type Unit,
} from "../components/charts";
import { can, useMe } from "../components/shell";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ModalDialog,
  PageHeader,
  Select,
  TextField,
} from "../components/ui";
import { api, ApiError, dateTime, label } from "../lib/api";

interface MetricInfo {
  id: string;
  label: string;
  app: string;
  unit: Unit;
  aggregate: string;
  dims: string[];
  status: string;
}
interface Dashboard {
  id: string;
  name: string;
  widgets: Widget[];
  shared_roles: string[];
  builtin: boolean;
  version: number;
  owner_id?: string;
}

const RANGE_LABEL: Record<RelativeRange, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
};
const errorText = (e: unknown) =>
  e instanceof ApiError ? e.message : String(e);
const useMetrics = () =>
  useQuery<{ enabled: boolean; metrics: MetricInfo[] }>({
    queryKey: ["analytics-metrics"],
    queryFn: () => api("/api/analytics/metrics"),
    refetchInterval: (q) =>
      q.state.data?.metrics.some((m) => m.status !== "ready") ? 3000 : false,
  });

function NotInPlan() {
  return (
    <EmptyState title="Analytics is not in your plan">
      Dashboards and reports are part of the Analytics package. An Owner can
      change the plan under Settings.
    </EmptyState>
  );
}

// ------------------------------------------------------------------ dashboards

export function DashboardsScreen() {
  const me = useMe();
  const metrics = useMetrics();
  const list = useQuery<{ dashboards: Dashboard[] }>({
    queryKey: ["dashboards"],
    queryFn: () => api("/api/dashboards"),
    enabled: can(me.data, "platform:analytics.read"),
  });
  const [selected, setSelected] = useState<string>("default:overview");
  const [range, setRange] = useState<RelativeRange>("last_30_days");
  const [store, setStore] = useState<string>("");
  const [channel, setChannel] = useState<string>("");
  const [editing, setEditing] = useState<Dashboard | "new" | null>(null);
  const dims = useQuery<{ store: string[]; channel: string[] }>({
    queryKey: ["analytics-dims"],
    queryFn: () => api("/api/analytics/dimensions"),
    enabled: Boolean(metrics.data?.enabled),
  });

  // When a backfill finishes, refresh the widgets at once (not at their next poll).
  const pendingCount =
    metrics.data?.metrics.filter((m) => m.status !== "ready").length ?? 0;
  const qc = useQueryClient();
  useEffect(() => {
    if (pendingCount > 0) return;
    void qc.invalidateQueries({ queryKey: ["analytics-query"] });
    void qc.invalidateQueries({ queryKey: ["analytics-dims"] });
  }, [pendingCount, qc]);

  if (!can(me.data, "platform:analytics.read"))
    return (
      <EmptyState title="Dashboards">
        Ask a Manager or Admin for access to dashboards.
      </EmptyState>
    );
  if (metrics.data && !metrics.data.enabled) return <NotInPlan />;
  const boards = list.data?.dashboards ?? [];
  const board = boards.find((b) => b.id === selected) ?? boards[0];
  const pending =
    metrics.data?.metrics.filter((m) => m.status !== "ready") ?? [];
  const byId = new Map((metrics.data?.metrics ?? []).map((m) => [m.id, m]));

  return (
    <>
      <PageHeader
        title="Dashboards"
        description="Live numbers from your apps. Filters apply to every widget."
        actions={
          can(me.data, "platform:analytics.manage") && (
            <>
              <Button variant="secondary" onPress={() => setEditing("new")}>
                New dashboard
              </Button>
              {board && !board.builtin && (
                <Button variant="secondary" onPress={() => setEditing(board)}>
                  Edit dashboard
                </Button>
              )}
            </>
          )
        }
      />
      <div
        role="group"
        aria-label="Filters"
        className="mb-4 grid gap-3 rounded-xl border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Select
          label="Dashboard"
          value={board?.id ?? null}
          onChange={setSelected}
          options={boards.map((b) => ({
            id: b.id,
            label: b.builtin ? `${b.name} (built-in)` : b.name,
          }))}
        />
        <Select
          label="Date range"
          value={range}
          onChange={(v) => setRange(v as RelativeRange)}
          options={RELATIVE_RANGES.map((r) => ({
            id: r,
            label: RANGE_LABEL[r],
          }))}
        />
        <Select
          label="Store"
          value={store}
          onChange={setStore}
          options={[
            { id: "", label: "All stores" },
            ...(dims.data?.store ?? []).map((s) => ({ id: s, label: s })),
          ]}
        />
        <Select
          label="Channel"
          value={channel}
          onChange={setChannel}
          options={[
            { id: "", label: "All channels" },
            ...(dims.data?.channel ?? []).map((s) => ({
              id: s,
              label: label(s),
            })),
          ]}
        />
      </div>
      {pending.length > 0 && (
        <div className="mb-4">
          <Alert tone="info">
            Backfilling history for {pending.map((m) => m.label).join(", ")};
            numbers will fill in shortly.
          </Alert>
        </div>
      )}
      {!board ? (
        <EmptyState title="No metrics yet">
          Provision an app (Ordering, POS, Payments, Logistics) or define a
          metric in Data studio.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {board.widgets.map((w) => (
            <WidgetCard
              key={`${board.id}-${w.id}`}
              widget={w}
              metric={byId.get(w.metric)}
              range={range}
              store={store}
              channel={channel}
            />
          ))}
        </div>
      )}
      {editing && (
        <DashboardEditor
          board={editing === "new" ? null : editing}
          metrics={metrics.data?.metrics ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id) => setSelected(id)}
        />
      )}
    </>
  );
}

function WidgetCard(props: {
  widget: Widget;
  metric: MetricInfo | undefined;
  range: RelativeRange;
  store: string;
  channel: string;
}) {
  const { widget: w, metric } = props;
  const { from, to } = useMemo(() => resolveRange(props.range), [props.range]);
  // A filter on a dimension the metric does not have would hide everything: skip it and say so.
  const filters: Record<string, string[]> = {};
  const skipped: string[] = [];
  for (const [dim, value] of [
    ["store", props.store],
    ["channel", props.channel],
  ] as const) {
    if (!value) continue;
    if (metric?.dims.includes(dim)) filters[dim] = [value];
    else skipped.push(dim);
  }
  const body = {
    metric: w.metric,
    from: from.toISOString(),
    to: to.toISOString(),
    filters,
    compare: w.kind === "kpi",
    ...(w.group_by ? { group_by: w.group_by } : {}),
    ...(w.limit ? { limit: w.limit } : {}),
  };
  const data = useQuery({
    queryKey: ["analytics-query", body],
    queryFn: () => api("/api/analytics/query", { body }),
    retry: false,
    refetchInterval: 15_000,
  });
  const span =
    w.kind === "kpi"
      ? ""
      : w.kind === "timeseries"
        ? "md:col-span-2"
        : "md:col-span-2";
  const unit = (metric?.unit ?? "number") as Unit;
  return (
    <Card as="div" className={span}>
      <section aria-labelledby={`w-${w.id}`} data-testid={`widget-${w.id}`}>
        <h2 id={`w-${w.id}`} className="mb-2 text-sm font-medium text-muted">
          {w.title}
        </h2>
        {data.error ? (
          <p className="text-sm text-bad">{errorText(data.error)}</p>
        ) : !data.data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : w.kind === "kpi" ? (
          <KpiTile
            label={w.title}
            value={data.data.total}
            previous={data.data.previous}
            unit={unit}
          />
        ) : w.kind === "timeseries" ? (
          <LineChart
            title={w.title}
            points={data.data.series}
            unit={unit}
            granularity={data.data.granularity}
          />
        ) : w.kind === "bar" ? (
          <BarChart
            title={w.title}
            bars={data.data.series.map((r: any) => ({
              key: r.key,
              value: r.value,
            }))}
            unit={unit}
            dimension={w.group_by ?? "store"}
          />
        ) : (
          <TopTable
            title={w.title}
            rows={data.data.series.map((r: any) => ({
              key: r.key,
              value: r.value,
            }))}
            unit={unit}
            dimension={w.group_by ?? "store"}
          />
        )}
        {skipped.length > 0 && (
          <p className="mt-2 text-xs text-muted">
            Not split by {skipped.join(" or ")}; showing all.
          </p>
        )}
      </section>
    </Card>
  );
}

function DashboardEditor(props: {
  board: Dashboard | null;
  metrics: MetricInfo[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const qc = useQueryClient();
  const roles = useQuery<{ roles: { id: string; name: string }[] }>({
    queryKey: ["roles-for-sharing"],
    queryFn: async () => {
      const r = await api<{
        presets: { id: string; name: string }[];
        custom: { id: string; name: string }[];
      }>("/api/roles");
      return { roles: [...r.presets, ...r.custom] };
    },
  });
  const [name, setName] = useState(props.board?.name ?? "");
  const [widgets, setWidgets] = useState<Widget[]>(props.board?.widgets ?? []);
  const [shared, setShared] = useState<string[]>(
    props.board?.shared_roles ?? [],
  );
  const [kind, setKind] = useState<Widget["kind"]>("kpi");
  const [metric, setMetric] = useState<string>(props.metrics[0]?.id ?? "");
  const [groupBy, setGroupBy] = useState<string>("store");
  const [error, setError] = useState<string | null>(null);
  const m = props.metrics.find((x) => x.id === metric);
  const add = () => {
    if (!m) return;
    const needsDim = kind === "bar" || kind === "table";
    const w: Widget = {
      id: `w${Date.now().toString(36)}`,
      kind,
      title: `${m.label}${needsDim ? ` per ${groupBy}` : ""}`,
      metric,
      ...(needsDim ? { group_by: groupBy as "store" | "channel" } : {}),
      ...(kind === "table" ? { limit: 10 } : {}),
    };
    setWidgets([...widgets, w]);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body = { name, widgets, shared_roles: shared };
      const r = props.board
        ? await api<{ id: string }>(`/api/dashboards/${props.board.id}`, {
            method: "PUT",
            body: { ...body, version: props.board.version },
          })
        : await api<{ id: string }>("/api/dashboards", { body });
      await qc.invalidateQueries({ queryKey: ["dashboards"] });
      props.onSaved(r.id);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <ModalDialog
      title={props.board ? "Edit dashboard" : "New dashboard"}
      isOpen
      onOpenChange={(o) => !o && props.onClose()}
    >
      <form
        onSubmit={submit}
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
      >
        <TextField label="Name" value={name} onChange={setName} isRequired />
        <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium">Add a widget</legend>
          <Select
            label="Widget type"
            value={kind}
            onChange={(v) => setKind(v as Widget["kind"])}
            options={[
              { id: "kpi", label: "Number with comparison" },
              { id: "timeseries", label: "Over time" },
              { id: "bar", label: "Bars by dimension" },
              { id: "table", label: "Top list" },
            ]}
          />
          <Select
            label="Metric"
            value={metric}
            onChange={setMetric}
            options={props.metrics.map((x) => ({
              id: x.id,
              label: `${x.label} (${x.app})`,
            }))}
          />
          {(kind === "bar" || kind === "table") && (
            <Select
              label="Split by"
              value={groupBy}
              onChange={setGroupBy}
              options={(m?.dims ?? []).map((d) => ({ id: d, label: label(d) }))}
            />
          )}
          <Button
            variant="secondary"
            onPress={add}
            isDisabled={
              !m ||
              ((kind === "bar" || kind === "table") &&
                !m.dims.includes(groupBy))
            }
          >
            Add widget
          </Button>
        </fieldset>
        <ul className="flex flex-col gap-1 text-sm" aria-label="Widgets">
          {widgets.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-2 border-b border-line py-1"
            >
              <span>{w.title}</span>
              <Button
                variant="ghost"
                aria-label={`Remove ${w.title}`}
                onPress={() => setWidgets(widgets.filter((x) => x.id !== w.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <fieldset>
          <legend className="text-sm font-medium">Share with roles</legend>
          <div className="flex flex-wrap gap-x-4">
            {(roles.data?.roles ?? []).map((r) => (
              <Checkbox
                key={r.id}
                isSelected={shared.includes(r.id)}
                onChange={(on) =>
                  setShared(
                    on ? [...shared, r.id] : shared.filter((x) => x !== r.id),
                  )
                }
              >
                {r.name}
              </Checkbox>
            ))}
          </div>
        </fieldset>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!name.trim() || !widgets.length}>
            Save dashboard
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

// ------------------------------------------------------------------ reports

interface ReportRow {
  id: string;
  name: string;
  query: {
    metrics: string[];
    range: RelativeRange;
    granularity: string;
    group_by?: string;
  };
  schedule: { every: string; hour: number; format: string } | null;
  next_run_at: string | null;
  /** false: the report uses metrics or fields hidden for you (no exports or downloads) */
  can_run: boolean;
  version: number;
  runs: {
    id: string;
    trigger: string;
    format: string;
    status: string;
    rows: number | null;
    error: string | null;
    started_at: string;
    download_url: string | null;
  }[];
}

export function ReportsScreen() {
  const me = useMe();
  const metrics = useMetrics();
  const reports = useQuery<{ reports: ReportRow[] }>({
    queryKey: ["reports"],
    queryFn: () => api("/api/reports"),
    enabled: can(me.data, "platform:analytics.read"),
    refetchInterval: 10_000,
  });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{
    tone: "success" | "error";
    text: string;
    link?: string | null;
  } | null>(null);
  if (!can(me.data, "platform:analytics.read"))
    return (
      <EmptyState title="Reports">
        Ask a Manager or Admin for access to reports.
      </EmptyState>
    );
  if (metrics.data && !metrics.data.enabled) return <NotInPlan />;
  const names = new Map(
    (metrics.data?.metrics ?? []).map((m) => [m.id, m.label]),
  );
  const run = async (r: ReportRow, format: "csv" | "pdf") => {
    setMsg(null);
    try {
      const res = await api<{ rows: number; download_url: string }>(
        `/api/reports/${r.id}/run`,
        { body: { format } },
      );
      setMsg({
        tone: "success",
        text: `${r.name}: ${format.toUpperCase()} ready (${res.rows} rows).`,
        link: res.download_url,
      });
      await qc.invalidateQueries({ queryKey: ["reports"] });
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  };
  return (
    <>
      <PageHeader
        title="Reports"
        description="Saved queries you can export as CSV or PDF, now or on a schedule. Files are kept for 30 days."
        actions={
          can(me.data, "platform:analytics.manage") && (
            <Button onPress={() => setOpen(true)}>New report</Button>
          )
        }
      />
      <div aria-live="polite" className="mb-4 empty:hidden">
        {msg && (
          <Alert tone={msg.tone}>
            {msg.text}{" "}
            {msg.link && (
              <a
                href={msg.link}
                className="inline-flex min-h-11 items-center font-medium underline"
              >
                Download
              </a>
            )}
          </Alert>
        )}
      </div>
      {reports.data?.reports.length === 0 && (
        <EmptyState title="No reports yet">
          Create one from your metrics; schedule it to get a file every day,
          week or month.
        </EmptyState>
      )}
      <ul className="flex flex-col gap-4">
        {(reports.data?.reports ?? []).map((r) => (
          <li key={r.id}>
            <Card as="div">
              <article aria-labelledby={`r-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 id={`r-${r.id}`} className="text-base font-semibold">
                      {r.name}
                    </h2>
                    <p className="text-sm text-muted">
                      {r.query.metrics.map((m) => names.get(m) ?? m).join(", ")}{" "}
                      · {RANGE_LABEL[r.query.range]}
                      {r.query.group_by ? ` · by ${r.query.group_by}` : ""}
                      {r.schedule
                        ? ` · every ${r.schedule.every} at ${String(r.schedule.hour).padStart(2, "0")}:00 UTC as ${r.schedule.format.toUpperCase()} (next ${dateTime(r.next_run_at)})`
                        : ""}
                    </p>
                  </div>
                  {!r.can_run ? (
                    <p className="text-sm text-muted">
                      Uses data your role cannot see: no exports.
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <Button variant="secondary" onPress={() => run(r, "csv")}>
                        Export CSV<span className="sr-only">: {r.name}</span>
                      </Button>
                      <Button variant="secondary" onPress={() => run(r, "pdf")}>
                        Export PDF<span className="sr-only">: {r.name}</span>
                      </Button>
                    </div>
                  )}
                </div>
                {r.runs.length > 0 && (
                  <table className="mt-3 w-full text-left text-sm">
                    <caption className="sr-only">
                      Recent runs of {r.name}
                    </caption>
                    <thead className="text-muted">
                      <tr>
                        <th scope="col" className="py-1 font-medium">
                          When
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          How
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          Status
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          File
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.runs.map((x) => (
                        <tr key={x.id} className="border-t border-line">
                          <td className="py-1">{dateTime(x.started_at)}</td>
                          <td className="py-1">
                            {x.trigger} · {x.format.toUpperCase()}
                          </td>
                          <td className="py-1">
                            <Badge value={x.status} />{" "}
                            {x.error && (
                              <span className="text-bad">{x.error}</span>
                            )}
                          </td>
                          <td className="py-1">
                            {x.download_url ? (
                              <a
                                href={x.download_url}
                                className="inline-flex min-h-11 items-center text-accent underline"
                              >
                                Download {x.format.toUpperCase()}
                                <span className="sr-only">
                                  {" "}
                                  of {r.name} from {dateTime(x.started_at)}
                                </span>
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </article>
            </Card>
          </li>
        ))}
      </ul>
      {open && (
        <ReportDialog
          metrics={metrics.data?.metrics ?? []}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ReportDialog(props: { metrics: MetricInfo[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [range, setRange] = useState<RelativeRange>("last_7_days");
  const [granularity, setGranularity] = useState("day");
  const [groupBy, setGroupBy] = useState("");
  const [every, setEvery] = useState("none");
  const [hour, setHour] = useState("6");
  const [weekday, setWeekday] = useState("1");
  const [day, setDay] = useState("1");
  const [format, setFormat] = useState("csv");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!chosen.length && props.metrics[0]) setChosen([props.metrics[0].id]);
  }, [props.metrics, chosen.length]);
  const canGroup = (d: string) =>
    chosen.every((id) =>
      props.metrics.find((m) => m.id === id)?.dims.includes(d),
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const schedule =
        every === "none"
          ? null
          : {
              every,
              hour: Number(hour),
              format,
              ...(every === "week" ? { weekday: Number(weekday) } : {}),
              ...(every === "month" ? { day: Number(day) } : {}),
            };
      await api("/api/reports", {
        body: {
          name,
          query: {
            metrics: chosen,
            range,
            granularity: groupBy ? "none" : granularity,
            ...(groupBy ? { group_by: groupBy } : {}),
          },
          schedule,
        },
      });
      await qc.invalidateQueries({ queryKey: ["reports"] });
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <ModalDialog
      title="New report"
      isOpen
      onOpenChange={(o) => !o && props.onClose()}
    >
      <form
        onSubmit={submit}
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
      >
        <TextField
          label="Report name"
          value={name}
          onChange={setName}
          isRequired
        />
        <fieldset>
          <legend className="text-sm font-medium">Metrics (up to 6)</legend>
          <div className="flex flex-wrap gap-x-4">
            {props.metrics.map((m) => (
              <Checkbox
                key={m.id}
                isSelected={chosen.includes(m.id)}
                onChange={(on) =>
                  setChosen(
                    on
                      ? [...chosen, m.id].slice(0, 6)
                      : chosen.filter((x) => x !== m.id),
                  )
                }
              >
                {m.label}
              </Checkbox>
            ))}
          </div>
        </fieldset>
        <Select
          label="Period"
          value={range}
          onChange={(v) => setRange(v as RelativeRange)}
          options={RELATIVE_RANGES.map((r) => ({
            id: r,
            label: RANGE_LABEL[r],
          }))}
        />
        <Select
          label="Rows"
          value={groupBy || granularity}
          onChange={(v) =>
            v === "store" || v === "channel"
              ? (setGroupBy(v), setGranularity("none"))
              : (setGroupBy(""), setGranularity(v))
          }
          options={[
            { id: "day", label: "One row per day" },
            { id: "week", label: "One row per week" },
            { id: "month", label: "One row per month" },
            { id: "none", label: "Totals only" },
            ...(canGroup("store")
              ? [{ id: "store", label: "One row per store" }]
              : []),
            ...(canGroup("channel")
              ? [{ id: "channel", label: "One row per channel" }]
              : []),
          ]}
        />
        <Select
          label="Schedule"
          value={every}
          onChange={setEvery}
          options={[
            { id: "none", label: "No schedule (export on demand)" },
            { id: "day", label: "Every day" },
            { id: "week", label: "Every week" },
            { id: "month", label: "Every month" },
          ]}
        />
        {every !== "none" && (
          <>
            <Select
              label="At (UTC)"
              value={hour}
              onChange={setHour}
              options={Array.from({ length: 24 }, (_, h) => ({
                id: String(h),
                label: `${String(h).padStart(2, "0")}:00`,
              }))}
            />
            {every === "week" && (
              <Select
                label="On"
                value={weekday}
                onChange={setWeekday}
                options={[
                  "Sunday",
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                ].map((d, i) => ({ id: String(i), label: d }))}
              />
            )}
            {every === "month" && (
              <Select
                label="Day of the month"
                value={day}
                onChange={setDay}
                options={Array.from({ length: 28 }, (_, i) => ({
                  id: String(i + 1),
                  label: String(i + 1),
                }))}
              />
            )}
            <Select
              label="Format"
              value={format}
              onChange={setFormat}
              options={[
                { id: "csv", label: "CSV" },
                { id: "pdf", label: "PDF" },
              ]}
            />
            <p className="text-sm text-muted">
              Scheduled files appear under the report for download. Email
              delivery arrives with the Gmail channel.
            </p>
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!name.trim() || !chosen.length}>
            Save report
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
