import type { ReactNode } from "react";

export type AlertTone = "success" | "warning" | "danger" | "info";

const TONE_CLASS: Record<AlertTone, string> = {
  success: "bg-success-soft text-success border-success/25",
  warning: "bg-warning-soft text-warning border-warning/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  info: "bg-info-soft text-info border-info/25",
};

/** Mensaje de estado inline (éxito/error/aviso) — nunca un modal para esto. */
export function Alert({
  tone,
  children,
  role,
}: {
  tone: AlertTone;
  children: ReactNode;
  /** "alert" para errores que deben anunciarse de inmediato a lectores de pantalla. */
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={`rounded-md border px-3.5 py-2.5 text-sm ${TONE_CLASS[tone]}`}
    >
      {children}
    </div>
  );
}
