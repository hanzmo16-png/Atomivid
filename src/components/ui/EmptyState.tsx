import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface/60 p-10 text-center">
      {icon && (
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          {icon}
        </div>
      )}
      <p className="text-base font-medium text-ink">{title}</p>
      {description && <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
