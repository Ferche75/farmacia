"use client";

import { useActionState } from "react";
import Image from "next/image";
import { login } from "@/lib/auth-actions";
import { Marca } from "@/components/marca";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <main className="flex flex-1">
      {/* La imagen ya trae su propia marca, título y tagline incrustados
          (login.png) — no se le superpone texto encima para no duplicar. */}
      <div className="relative hidden w-[38%] overflow-hidden bg-ink lg:block">
        <Image
          src="/login.png"
          alt="Farmacia Admin"
          fill
          priority
          unoptimized
          sizes="38vw"
          className="object-cover object-left"
        />
      </div>

      <div className="flex flex-1 items-center justify-center p-6">
        <form action={action} className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Marca size={32} className="text-brand" />
          </div>
          <h1 className="mb-1 text-xl font-semibold tracking-tight text-ink">Ingresar</h1>
          <p className="mb-7 text-sm text-muted">Acceso para admin, gerente y superadmin.</p>

          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="input mb-4 py-2.5"
          />

          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink">
            Contraseña
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="input mb-4 py-2.5"
          />

          {state?.error && (
            <p className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-brand px-3 py-2.5 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </div>
    </main>
  );
}
