import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FileText, RefreshCw } from 'lucide-react';
import { api, ApiError, type MessageTemplate } from './api';
import { playSound } from './sounds';
import { Icon } from './ui';

const CATEGORY: Record<string, { label: string; hint: string }> = {
  MARKETING: { label: 'Marketing', hint: 'Meta la cobra como mensaje de marketing.' },
  UTILITY: { label: 'Utilidad', hint: 'Meta la cobra como mensaje de utilidad (más barata que marketing).' },
  AUTHENTICATION: { label: 'Autenticación', hint: 'Para códigos de verificación.' },
};

/** "retomar_consulta" → "Retomar consulta". */
const prettyName = (name: string) => {
  const s = name.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const firstName = (name: string) => {
  const w = name.trim().split(/\s+/)[0] ?? '';
  return /^cliente$/i.test(w) ? '' : w;
};

/** Texto del cuerpo con los datos puestos; los que faltan se ven como [dato 2]. */
function Preview({ body, values }: { body: string; values: string[] }) {
  const parts = body.split(/(\{\{\s*\d+\s*\}\})/g);
  return (
    <p className="tpl-preview">
      {parts.map((p, i) => {
        const m = /\{\{\s*(\d+)\s*\}\}/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const v = values[Number(m[1]) - 1]?.trim();
        return v ? (
          <mark key={i} className="tpl-filled">
            {v}
          </mark>
        ) : (
          <mark key={i} className="tpl-missing">
            dato {m[1]}
          </mark>
        );
      })}
    </p>
  );
}

/**
 * Pasadas 24 h desde el último mensaje del cliente, WhatsApp solo deja escribirle con una
 * plantilla aprobada por Meta. El asesor elige una, completa sus datos y la envía.
 */
export function TemplateComposer({
  conversationId,
  contactName,
  agentName,
  onSent,
}: {
  conversationId: string;
  contactName: string;
  agentName: string;
  onSent: () => void;
}) {
  const [items, setItems] = useState<MessageTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<MessageTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .templates(conversationId)
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : 'No se pudieron cargar las plantillas.'));
    return () => {
      alive = false;
    };
  }, [conversationId, reload]);

  const choose = (t: MessageTemplate) => {
    setPicked(t);
    setError(null);
    // Sugerencias: {{1}} suele ser el nombre del cliente y {{2}} el del asesor.
    const guess = [firstName(contactName), firstName(agentName)];
    setValues(Array.from({ length: t.params }, (_, i) => guess[i] ?? ''));
  };

  const missing = useMemo(() => values.some((v) => !v.trim()), [values]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked || missing) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendTemplate(conversationId, { name: picked.name, language: picked.language, params: values.map((v) => v.trim()), clientId: crypto.randomUUID() });
      playSound('sent');
      setPicked(null);
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar la plantilla.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tpl">
      <div className="tpl-head">
        <span className="tpl-icon" aria-hidden="true">
          <FileText strokeWidth={1.9} />
        </span>
        <div>
          <b>Pasaron más de 24 h desde el último mensaje del cliente</b>
          <p className="muted small">WhatsApp solo permite escribirle con una plantilla aprobada por Meta. Cuando el cliente responda, vuelves a escribir libre.</p>
        </div>
      </div>

      {error && (
        <p className="error small tpl-error" role="alert">
          {error}{' '}
          <button type="button" className="btn ghost small" onClick={() => setReload((r) => r + 1)}>
            <RefreshCw strokeWidth={2} size={13} /> Reintentar
          </button>
        </p>
      )}
      {items === null && !error && <div className="skeleton"><i /></div>}
      {items?.length === 0 && <p className="muted small">Este número no tiene plantillas aprobadas. Se crean y aprueban en el administrador de WhatsApp de Meta.</p>}

      <AnimatePresence mode="wait" initial={false}>
        {!picked && items && items.length > 0 && (
          <motion.ul key="list" className="tpl-list" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            {items.map((t) => (
              <li key={`${t.name}:${t.language}`}>
                <button type="button" className="tpl-card" onClick={() => choose(t)}>
                  <span className="tpl-card-top">
                    <b>{prettyName(t.name)}</b>
                    <span className="chip" title={CATEGORY[t.category]?.hint}>
                      {CATEGORY[t.category]?.label ?? t.category}
                    </span>
                  </span>
                  <span className="tpl-card-body">{t.body}</span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}

        {picked && (
          <motion.form key="form" className="tpl-form" onSubmit={submit} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <div className="tpl-card-top">
              <b>{prettyName(picked.name)}</b>
              <span className="chip" title={CATEGORY[picked.category]?.hint}>
                {CATEGORY[picked.category]?.label ?? picked.category}
              </span>
              <button type="button" className="btn ghost small tpl-back" onClick={() => setPicked(null)}>
                Cambiar plantilla
              </button>
            </div>
            {picked.params > 0 && (
              <div className="tpl-fields">
                {values.map((v, i) => (
                  <label key={i}>
                    <span>Dato {i + 1}</span>
                    <input
                      value={v}
                      maxLength={200}
                      onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))}
                      placeholder={i === 0 ? 'Nombre del cliente' : i === 1 ? 'Su nombre' : ''}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="tpl-bubble">
              {picked.header && <b>{picked.header}</b>}
              <Preview body={picked.body} values={values} />
              {picked.footer && <small className="muted">{picked.footer}</small>}
              {picked.buttons.length > 0 && (
                <div className="tpl-buttons">
                  {picked.buttons.map((b) => (
                    <span key={b}>{b}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="tpl-actions">
              <span className="muted small">{CATEGORY[picked.category]?.hint}</span>
              <motion.button className="btn primary" type="submit" disabled={busy || missing} whileTap={{ scale: 0.94 }}>
                {busy ? 'Enviando…' : 'Enviar plantilla'} {Icon.send}
              </motion.button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
