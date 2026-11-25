import { useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { BrandMark } from './Brand';

/** Negocio dueño de este panel; el login aún no sabe a qué negocio entra el asesor. */
const BRAND = (import.meta.env.VITE_PANEL_BRAND as string | undefined) ?? 'Inversiones Mora Mora';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) return setError('Escribe tu correo y tu contraseña.');
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      onLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit} noValidate>
        <BrandMark tenantName={BRAND} big />
        <h1>Panel de asesores</h1>
        <span className="muted small">{BRAND}</span>
        <p className="muted">Atiende a los clientes que el bot te pasa.</p>
        <label>
          Correo
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Contraseña
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
