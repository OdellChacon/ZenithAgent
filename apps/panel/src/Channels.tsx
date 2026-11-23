import { useEffect, useState } from 'react';
import { api, type ChannelStatus } from './api';
import { runEmbeddedSignup, type SignupConfig } from './signup';

/** Id de cuenta ficticio para el simulador local (no hay cuenta de Meta real). */
const SIMULATED_WABA_ID = '100000000000999';

const HISTORY_LABELS: Record<string, string> = {
  importing: 'Importando chats anteriores',
  done: 'Chats anteriores importados',
  declined: 'El negocio no compartió sus chats anteriores',
};

function ChannelCard({ c }: { c: ChannelStatus }) {
  return (
    <li className="card channel-card">
      <div className="item-top">
        <b>{c.name}</b>
        <span className="muted small">Conectado el {new Date(c.connectedAt).toLocaleDateString('es-VE')}</span>
      </div>
      <div className="chips">
        {c.disconnected ? <span className="chip hot">Desconectado</span> : <span className="chip ok">Activo</span>}
        {c.coexistence && <span className="chip">También en la app del teléfono</span>}
        {c.history && (
          <span className="chip muted-chip">
            {HISTORY_LABELS[c.history.status] ?? c.history.status}
            {c.history.status === 'importing' ? ` (${c.history.progress}%)` : ''}
          </span>
        )}
      </div>
      {c.disconnected && <p className="notice">{c.disconnected.label} Vuelve a conectarlo con el botón de abajo.</p>}
    </li>
  );
}

export function Channels({ tick }: { tick: number }) {
  const [items, setItems] = useState<ChannelStatus[] | null>(null);
  const [cfg, setCfg] = useState<SignupConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; warnings?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .channels()
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, [tick]);
  useEffect(() => {
    api
      .signupConfig()
      .then(setCfg)
      .catch(() => setCfg({ enabled: false, canConnect: false }));
  }, []);

  const connect = async () => {
    if (!cfg) return;
    setBusy(true);
    setResult(null);
    try {
      const signup = cfg.simulated
        ? { code: 'simulador', phoneNumberId: cfg.simulated.phoneNumberId, wabaId: SIMULATED_WABA_ID }
        : await runEmbeddedSignup(cfg);
      const res = await api.connectWhatsApp(signup);
      setResult({ ok: true, text: `Listo: ${res.name ?? 'el número'} quedó conectado.`, warnings: res.warnings });
      setItems((await api.channels()).items);
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'No se pudo conectar' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="channels-page">
      <h2>Números de WhatsApp</h2>
      {error && <p className="error">{error}</p>}
      {items === null && !error && <p className="muted">Cargando…</p>}
      {items?.length === 0 && <p className="muted">Todavía no hay números conectados.</p>}
      <ul className="channel-list">
        {items?.map((c) => (
          <ChannelCard key={c.id} c={c} />
        ))}
      </ul>

      {cfg?.canConnect && (
        <div className="card connect-box">
          <b>Conectar un número</b>
          <p className="muted">
            Se abre una ventana de Meta: elige la cuenta del negocio y el número. Si el número ya se usa en la app WhatsApp Business, sigue
            funcionando en el teléfono y el sistema trae los chats de los últimos 6 meses.
          </p>
          {cfg.enabled ? (
            <button className="btn primary" type="button" disabled={busy} onClick={() => void connect()}>
              {busy ? 'Conectando…' : cfg.simulated ? 'Conectar el número de prueba (simulador)' : 'Conectar WhatsApp'}
            </button>
          ) : (
            <p className="notice">Falta configurar la app de Meta en el servidor (META_APP_ID y META_ES_CONFIG_ID).</p>
          )}
          {result && (
            <div role="status" className="connect-result">
              <p className={result.ok ? 'ok-text' : 'error'}>{result.text}</p>
              {result.warnings?.map((w) => (
                <p key={w} className="notice">
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
