"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Rol } from "@farmacia/db";
import { logout } from "@/lib/auth-actions";

function IconSubir({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 15V4M12 4l-4 4M12 4l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBandeja({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 12 2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ITEMS: {
  label: string;
  href: string | null;
  roles: Rol[];
  icon?: (props: { className?: string }) => React.JSX.Element;
}[] = [
  { label: "Importar catálogo", href: "/importar", roles: ["admin", "gerente", "superadmin"], icon: IconSubir },
  { label: "Productos", href: "/productos", roles: ["admin", "gerente", "superadmin"] },
  { label: "Bandeja de revisión", href: "/desconocidos", roles: ["admin", "gerente", "superadmin"], icon: IconBandeja },
  { label: "Conteos", href: "/conteos", roles: ["admin", "gerente", "superadmin"] },
  { label: "Superadmin", href: "/superadmin", roles: ["superadmin"] },
];

export function NavAdmin({ rol, nombre }: { rol: Rol; nombre: string }) {
  const pathname = usePathname();
  const visibles = ITEMS.filter((item) => item.roles.includes(rol));

  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-6 border-b border-line bg-surface px-8 py-3">
      <Link href="/" className="flex items-center gap-2.5 justify-self-start whitespace-nowrap">
        <Image src="/logofar.png" alt="" width={28} height={28} className="shrink-0" unoptimized />
        <span className="text-lg font-semibold tracking-tight text-ink">
          Farmacia <span className="font-normal text-brand">Admin</span>
        </span>
      </Link>

      <nav className="flex items-center gap-2 justify-self-center">
        {visibles.map((item) => {
          const activo = item.href !== null && pathname.startsWith(item.href);
          const Icon = item.icon;
          return item.href ? (
            <Link
              key={item.label}
              href={item.href}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium transition-colors ${
                activo ? "bg-brand-soft text-brand" : "text-ink/70 hover:bg-paper hover:text-ink"
              }`}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              {item.label}
            </Link>
          ) : (
            <span
              key={item.label}
              title="Todavía no implementado"
              className="flex cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium text-muted"
            >
              {item.label}
            </span>
          );
        })}
      </nav>

      <div className="flex items-center gap-4 justify-self-end whitespace-nowrap">
        <p className="text-sm text-ink">
          <span className="font-medium">{nombre}</span> <span className="text-muted">· {rol}</span>
        </p>
        <form action={logout}>
          <button type="submit" className="text-sm font-medium text-brand transition-colors hover:text-brand-bright">
            Salir
          </button>
        </form>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white">
          {nombre.charAt(0).toUpperCase()}
        </div>
      </div>
    </header>
  );
}
