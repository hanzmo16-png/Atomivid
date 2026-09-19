"use client";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";
export function AuthSubmit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <Button type="submit" loading={pending} className="w-full">{pending ? "Procesando…" : children}</Button>;
}
