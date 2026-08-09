"use client";

import { useActionState } from "react";
import { login } from "@/lib/auth-actions";
import { MarcaConteo } from "@/components/marca-conteo";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <MarcaConteo />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-paper">Conteo</h1>
          <p className="mt-1 text-sm text-muted">Escaneá. Contá. Listo.</p>
        </div>

        <form action={action} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-muted">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-md border border-line bg-ink-2 px-4 py-3.5 text-base text-paper outline-none transition-colors focus:border-brand"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-muted">
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded-md border border-line bg-ink-2 px-4 py-3.5 text-base text-paper outline-none transition-colors focus:border-brand"
            />
          </div>

          {state?.error && (
            <p className="rounded-md border border-notfound/30 bg-notfound-bg px-3.5 py-2.5 text-sm text-notfound">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-brand px-4 py-3.5 text-base font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </div>
    </main>
  );
}
