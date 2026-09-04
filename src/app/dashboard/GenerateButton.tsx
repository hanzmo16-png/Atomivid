"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function GenerateButton({
  endpoint,
  label,
  redirectTo,
}: {
  endpoint: string;
  label: string;
  /** Si se da, navega ahí al terminar en vez de solo refrescar la página. */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);

  async function handleClick() {
    setLoading(true);
    setError(null);
    setNeedsSubscription(false);

    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 402) {
          setNeedsSubscription(true);
        }
        throw new Error(data?.error ?? "No se pudo completar la acción");
      }

      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Generando…" : label}
      </button>
      {error && <p className="max-w-[220px] text-right text-xs text-red-600">{error}</p>}
      {needsSubscription && (
        <Link
          href="/dashboard/billing"
          className="text-right text-xs font-medium text-gray-900 underline"
        >
          Ver planes
        </Link>
      )}
    </div>
  );
}
