"use client";
import { useFormStatus } from "react-dom";
import { Button } from "./Button";
export function FormSubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return <Button type="submit" loading={pending} className="w-full">{pending ? pendingLabel : label}</Button>;
}
