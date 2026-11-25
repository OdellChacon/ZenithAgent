/**
 * Logo del negocio en el panel. Hoy solo Inversiones Mora Mora tiene el suyo (el globo "IMM" de
 * inversionesmoramora.com); los demás negocios ven la inicial de su nombre.
 * Cuando haya más clientes, esto debería venir de la configuración de cada tenant.
 */
import type { ReactNode } from 'react';

const IMM_GLOBE = (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="16" cy="16" r="13" />
    <ellipse cx="16" cy="16" rx="6.5" ry="13" />
    <line x1="3" y1="16" x2="29" y2="16" />
    <path d="M6 9c6 3 14 3 20 0M6 23c6-3 14-3 20 0" />
  </svg>
);

function brandFor(tenantName: string): { mark: ReactNode; word: string } {
  if (/mora\s*mora/i.test(tenantName)) return { mark: IMM_GLOBE, word: 'IMM' };
  const initial = tenantName.trim()[0]?.toUpperCase() ?? 'Z';
  return { mark: <b style={{ fontSize: 18 }}>{initial}</b>, word: tenantName };
}

export function BrandMark({ tenantName, big }: { tenantName: string; big?: boolean }) {
  return <span className={`brand-mark ${big ? 'big' : ''}`}>{brandFor(tenantName).mark}</span>;
}

export function Brand({ tenantName }: { tenantName: string }) {
  const b = brandFor(tenantName);
  return (
    <a className="brand" href="/" aria-label={`${tenantName}: panel de asesores`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <BrandMark tenantName={tenantName} />
      <span className="brand-text">
        <span className="brand-word">{b.word}</span>
        <small>{tenantName} · Panel de asesores</small>
      </span>
    </a>
  );
}
