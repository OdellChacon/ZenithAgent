import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from './api';

/** Igual que la API: minúsculas, sin # ni espacios de más. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

const TAG_RE = /^[\p{L}\p{N} _-]{1,30}$/u;
const MAX_TAGS = 15;

/**
 * Etiquetas de un contacto: se agregan con Enter o coma y se quitan con la ×. Cada cambio se
 * guarda al momento. Sugiere las etiquetas que el equipo ya usa para no crear variantes.
 */
export function TagEditor({
  contactId,
  tags,
  onSaved,
  compact = false,
}: {
  contactId: string;
  tags: string[];
  onSaved: (tags: string[]) => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState('');
  const [current, setCurrent] = useState(tags);
  const [known, setKnown] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  useEffect(() => setCurrent(tags), [tags]);
  useEffect(() => {
    api
      .contactTags()
      .then((r) => setKnown(r.items.map((i) => i.tag)))
      .catch(() => undefined);
  }, []);

  const save = async (next: string[]) => {
    const before = current;
    setCurrent(next);
    setBusy(true);
    setError(null);
    try {
      await api.updateContact(contactId, { tags: next });
      onSaved(next);
    } catch (err) {
      setCurrent(before);
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const tag = normalizeTag(value);
    if (!tag) return;
    if (!TAG_RE.test(tag)) return setError('Usa letras, números, espacios, - o _ (máximo 30).');
    if (current.includes(tag)) return setValue('');
    if (current.length >= MAX_TAGS) return setError(`Máximo ${MAX_TAGS} etiquetas.`);
    setValue('');
    void save([...current, tag]);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !value && current.length) {
      void save(current.slice(0, -1));
    }
  };

  return (
    <div className={`tag-editor ${compact ? 'compact' : ''}`}>
      <div className="chips">
        {current.map((t) => (
          <span key={t} className="chip tag">
            {t}
            <button type="button" aria-label={`Quitar etiqueta ${t}`} disabled={busy} onClick={() => void save(current.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="tag-input"
          value={value}
          list={listId}
          maxLength={40}
          disabled={busy}
          placeholder={current.length ? 'Agregar…' : 'Agregar etiqueta…'}
          aria-label="Agregar etiqueta"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => value.trim() && add()}
        />
        <datalist id={listId}>
          {known
            .filter((k) => !current.includes(k))
            .map((k) => (
              <option key={k} value={k} />
            ))}
        </datalist>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
