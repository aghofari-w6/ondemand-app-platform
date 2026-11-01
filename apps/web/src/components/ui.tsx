import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Checkbox as AriaCheckbox,
  Dialog,
  FieldError,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  TextField as AriaTextField,
  type ButtonProps,
} from 'react-aria-components';

/** Design-system primitives on React Aria Components. Every control is ≥44px tall. */

const variants = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:bg-line disabled:text-muted',
  secondary: 'bg-white text-ink border border-line hover:bg-ground disabled:text-muted',
  danger: 'bg-white text-bad border border-bad/40 hover:bg-bad-soft',
  ghost: 'bg-transparent text-accent hover:bg-accent-soft',
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps & { variant?: keyof typeof variants; className?: string }) {
  return (
    <AriaButton
      {...props}
      className={`inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function TextField(props: {
  label: string;
  name?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  description?: string;
  error?: string | undefined;
  isRequired?: boolean;
  autoComplete?: string;
  placeholder?: string;
  className?: string;
  inputMode?: 'numeric' | 'decimal' | 'text' | 'email';
}) {
  return (
    <AriaTextField
      className={`flex flex-col gap-1 ${props.className ?? ''}`}
      value={props.value}
      onChange={props.onChange}
      type={props.type ?? 'text'}
      name={props.name}
      isRequired={props.isRequired}
      isInvalid={Boolean(props.error)}
      autoComplete={props.autoComplete}
    >
      <Label className="text-sm font-medium text-ink">{props.label}</Label>
      <Input
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        className="min-h-11 rounded-lg border border-line bg-white px-3 text-base text-ink placeholder:text-muted invalid:border-bad"
      />
      {props.description && (
        <Text slot="description" className="text-sm text-muted">
          {props.description}
        </Text>
      )}
      <FieldError className="text-sm text-bad">{props.error}</FieldError>
    </AriaTextField>
  );
}

export function Select<T extends string>(props: { label: string; value: T | null; onChange: (v: T) => void; options: { id: T; label: string }[]; className?: string; isDisabled?: boolean }) {
  return (
    <AriaSelect
      className={`flex flex-col gap-1 ${props.className ?? ''}`}
      selectedKey={props.value}
      onSelectionChange={(k) => props.onChange(k as T)}
      isDisabled={props.isDisabled}
    >
      <Label className="text-sm font-medium text-ink">{props.label}</Label>
      <AriaButton className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 text-left text-base">
        <SelectValue />
        <span aria-hidden="true" className="text-muted">
          ▾
        </span>
      </AriaButton>
      <Popover className="min-w-(--trigger-width) rounded-lg border border-line bg-white shadow-lg">
        <ListBox className="max-h-72 overflow-auto p-1 outline-none">
          {props.options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={o.label} className="flex min-h-11 cursor-pointer items-center rounded-md px-3 text-base outline-none data-[focused]:bg-accent-soft data-[selected]:font-semibold">
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export function Checkbox(props: { children: ReactNode; isSelected: boolean; onChange: (v: boolean) => void }) {
  return (
    <AriaCheckbox isSelected={props.isSelected} onChange={props.onChange} className="group flex min-h-11 cursor-pointer items-center gap-3 text-sm">
      <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded border border-muted bg-white group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-accent">
        <svg viewBox="0 0 12 10" className="hidden h-3 w-3 fill-none stroke-white stroke-2 group-data-[selected]:block">
          <polyline points="1 5 4.5 8.5 11 1" />
        </svg>
      </span>
      {props.children}
    </AriaCheckbox>
  );
}

export function ModalDialog(props: { title: string; isOpen: boolean; onOpenChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <ModalOverlay isOpen={props.isOpen} onOpenChange={props.onOpenChange} isDismissable className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4">
      <Modal className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <Dialog className="outline-none">
          <Heading slot="title" className="mb-4 text-lg font-semibold">
            {props.title}
          </Heading>
          {props.children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function PageHeader(props: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && <p className="mt-1 text-muted">{props.description}</p>}
      </div>
      {props.actions && <div className="flex flex-wrap gap-2">{props.actions}</div>}
    </div>
  );
}

export function Card(props: { children: ReactNode; className?: string; title?: string; as?: 'section' | 'div' }) {
  const Tag = props.as ?? 'section';
  return (
    <Tag className={`rounded-xl border border-line bg-white p-5 ${props.className ?? ''}`}>
      {props.title && <h2 className="mb-3 text-base font-semibold">{props.title}</h2>}
      {props.children}
    </Tag>
  );
}

const tones: Record<string, string> = {
  active: 'bg-ok-soft text-ok',
  succeeded: 'bg-ok-soft text-ok',
  done: 'bg-ok-soft text-ok',
  completed: 'bg-ok-soft text-ok',
  delivered: 'bg-ok-soft text-ok',
  captured: 'bg-ok-soft text-ok',
  open: 'bg-ok-soft text-ok',
  trial: 'bg-accent-soft text-accent',
  running: 'bg-accent-soft text-accent',
  provisioning: 'bg-accent-soft text-accent',
  failed: 'bg-bad-soft text-bad',
  exception: 'bg-bad-soft text-bad',
  cancelled: 'bg-bad-soft text-bad',
  voided: 'bg-bad-soft text-bad',
  suspended: 'bg-warn-soft text-warn',
  retained: 'bg-warn-soft text-warn',
  compensating: 'bg-warn-soft text-warn',
  compensated: 'bg-warn-soft text-warn',
};

export function Badge({ value }: { value: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[value] ?? 'bg-ground text-muted'}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Alert(props: { tone?: 'info' | 'error' | 'success' | 'warn'; children: ReactNode; title?: string }) {
  const t = { info: 'bg-accent-soft text-ink border-accent/30', error: 'bg-bad-soft text-bad border-bad/30', success: 'bg-ok-soft text-ok border-ok/30', warn: 'bg-warn-soft text-warn border-warn/30' }[props.tone ?? 'info'];
  return (
    <div role={props.tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-4 text-sm ${t}`}>
      {props.title && <p className="mb-1 font-semibold">{props.title}</p>}
      {props.children}
    </div>
  );
}

export function EmptyState(props: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-white p-10 text-center">
      <h2 className="text-lg font-semibold">{props.title}</h2>
      <div className="mx-auto mt-2 max-w-md text-muted">{props.children}</div>
    </div>
  );
}

/** Shows a link that would normally be emailed (demo mode). */
export function DemoLink(props: { subject: string; link: string; label?: string }) {
  return (
    <Alert tone="info" title="Demo mode: this link would be sent by email">
      <p className="mb-2">{props.subject}</p>
      <a href={props.link} className="inline-flex min-h-11 items-center break-all font-medium text-accent underline">
        {props.label ?? props.link}
      </a>
    </Alert>
  );
}
