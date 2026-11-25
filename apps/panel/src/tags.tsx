/**
 * Etiquetas de contactos: catálogo compartido (con color, grupo y descripción), chips de color y
 * el selector con buscador que se usa en la ficha y en la conversación.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, ApiError, TAG_COLORS, type TagCatalog, type TagColor, type TagDef } from './api';
import { playSound } from './sounds';

/** Igual que la API: minúsculas, sin # ni espacios de más. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLocaleLowerCase('es');
}
export const TAG_RE = /^[\p{L}\p{N} _-]{1,30}$/u;
export const MAX_TAGS = 15;

export const COLOR_NAMES: Record<TagColor, string> = {
  gray: 'Gris',
  red: 'Rojo',
  orange: 'Naranja',
  amber: 'Ámbar',
  lime: 'Lima',
  green: 'Verde',
  teal: 'Turquesa',
  sky: 'Celeste',
  blue: 'Azul',
  violet: 'Violeta',
  pink: 'Rosa',
};

/** "cliente frecuente" → "Cliente frecuente" (se guardan en minúsculas). */
export const tagLabel = (t: string) => t.charAt(0).toLocaleUpperCase('es') + t.slice(1);

// ------------------------------------------------------------------ catálogo compartido

let cache: TagCatalog | null = null;
let inflight: Promise<TagCatalog> | null = null;
const subs = new Set<(c: TagCatalog) => void>();

export function refreshTags(): Promise<TagCatalog> {
  inflight ??= api
    .contactTags()
    .then((c) => {
      cache = c;
      subs.forEach((fn) => fn(c));
      return c;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useTagCatalog(): TagCatalog | null {
  const [catalog, setCatalog] = useState(cache);
  useEffect(() => {
    subs.add(setCatalog);
    void refreshTags().catch(() => undefined);
    return () => void subs.delete(setCatalog);
  }, []);
  return catalog;
}

export function tagDef(catalog: TagCatalog | null, tag: string): TagDef | undefined {
  return catalog?.items.find((i) => i.tag === tag);
}

// ------------------------------------------------------------------ chip

export function TagChip({
  tag,
  color,
  count,
  onRemove,
  title,
}: {
  tag: string;
  color: TagColor;
  count?: number;
  onRemove?: () => void;
  title?: string;
}) {
  return (
    <span className={`tchip tc-${color}`} title={title}>
      <i aria-hidden="true" />
      {tagLabel(tag)}
      {count !== undefined && <span className="tchip-count">{count}</span>}
      {onRemove && (
        <button type="button" aria-label={`Quitar etiqueta ${tag}`} onClick={onRemove}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </span>
  );
}

export function ColorSwatches({ value, onChange }: { value: TagColor; onChange: (c: TagColor) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_NAMES[c]}
          title={COLOR_NAMES[c]}
          className={`swatch tc-${c} ${value === c ? 'on' : ''}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ selector

/**
 * Lista desplegable con buscador: marca y desmarca etiquetas, agrupadas como en el catálogo, y
 * permite crear una nueva (con su color) escribiendo su nombre.
 */
function TagPicker({ selected, onToggle, onClose }: { selected: string[]; onToggle: (tag: string) => void; onClose: () => void }) {
  const catalog = useTagCatalog();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [newColor, setNewColor] = useState<TagColor>('teal');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const query = normalizeTag(q);
  const items = useMemo(
    () => (catalog?.items ?? []).filter((t) => !query || t.tag.includes(query) || (t.group ?? '').toLocaleLowerCase('es').includes(query)),
    [catalog, query],
  );
  const exclusive = new Set(catalog?.groups.filter((g) => g.exclusive).map((g) => g.name));
  const canCreate = !!query && !catalog?.items.some((t) => t.tag === query);
  // Orden de navegación con el teclado: las visibles y, al final, "crear".
  const options = [...items.map((i) => i.tag), ...(canCreate ? ['__create__'] : [])];

  useEffect(() => setActive(0), [query]);

  const create = async () => {
    if (!TAG_RE.test(query)) return setError('Usa letras, números, espacios, - o _ (máximo 30).');
    try {
      await api.createTag({ name: query, color: newColor });
      await refreshTags();
      onToggle(query);
      setQ('');
      playSound('success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la etiqueta.');
    }
  };

  const choose = (opt: string | undefined) => {
    if (!opt) return;
    if (opt === '__create__') void create();
    else onToggle(opt);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // Agrupa respetando el orden del catálogo.
  const sections: { group: string | null; tags: TagDef[] }[] = [];
  for (const t of items) {
    const last = sections.at(-1);
    if (last && last.group === t.group) last.tags.push(t);
    else sections.push({ group: t.group, tags: [t] });
  }

  return (
    <motion.div
      className="tag-picker"
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
    >
      <input
        ref={input}
        className="tag-search"
        value={q}
        maxLength={40}
        placeholder="Buscar o crear etiqueta…"
        aria-label="Buscar o crear etiqueta"
        role="combobox"
        aria-expanded="true"
        aria-controls="tag-options"
        onChange={(e) => {
          setQ(e.target.value);
          setError(null);
        }}
        onKeyDown={onKey}
      />
      <div className="tag-options" id="tag-options" role="listbox" aria-multiselectable="true">
        {catalog === null && <p className="muted small pad">Cargando…</p>}
        {sections.map((s) => (
          <div key={s.group ?? '__none__'} className="tag-section">
            <div className="tag-section-head">
              {s.group ?? 'Otras etiquetas'}
              {s.group && exclusive.has(s.group) && <span>una sola</span>}
            </div>
            {s.tags.map((t) => {
              const on = selected.includes(t.tag);
              const idx = options.indexOf(t.tag);
              return (
                <button
                  key={t.tag}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`tag-option ${idx === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(t.tag)}
                >
                  <span className={`tdot tc-${t.color}`} aria-hidden="true" />
                  <span className="grow">
                    {tagLabel(t.tag)}
                    {t.description && <small>{t.description}</small>}
                  </span>
                  <span className="muted small">{t.count}</span>
                  <span className={`check ${on ? 'on' : ''}`} aria-hidden="true">
                    <svg viewBox="0 0 16 16">
                      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {catalog && !items.length && !canCreate && <p className="muted small pad">No hay etiquetas todavía. Escribe un nombre para crear una.</p>}
        {canCreate && (
          <div className={`tag-create ${options.indexOf('__create__') === active ? 'active' : ''}`}>
            <button type="button" className="tag-option" onClick={() => void create()} onMouseEnter={() => setActive(options.indexOf('__create__'))}>
              <span className={`tdot tc-${newColor}`} aria-hidden="true" />
              <span className="grow">
                Crear «{tagLabel(query)}»
              </span>
              <span className="kbd">Enter</span>
            </button>
            <ColorSwatches value={newColor} onChange={setNewColor} />
          </div>
        )}
      </div>
      {error && <p className="error small pad">{error}</p>}
    </motion.div>
  );
}

// ------------------------------------------------------------------ editor de un contacto

/**
 * Etiquetas de un contacto: chips de color y un botón que abre el selector. Cada cambio se guarda
 * al momento; en los grupos de una sola opción, el servidor deja solo la última elegida.
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
  const catalog = useTagCatalog();
  const [current, setCurrent] = useState(tags);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => setCurrent(tags), [tags]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const save = async (next: string[]) => {
    const before = current;
    setCurrent(next);
    setError(null);
    try {
      const r = await api.updateContact(contactId, { tags: next });
      const saved = r.tags ?? next;
      setCurrent(saved);
      onSaved(saved);
      void refreshTags();
    } catch (err) {
      setCurrent(before);
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
    }
  };

  const toggle = (tag: string) => {
    if (current.includes(tag)) return void save(current.filter((t) => t !== tag));
    if (current.length >= MAX_TAGS) return setError(`Máximo ${MAX_TAGS} etiquetas por contacto.`);
    playSound('tap');
    void save([...current, tag]);
  };

  return (
    <div className={`tag-editor ${compact ? 'compact' : ''}`} ref={wrap}>
      <div className="tag-row">
        <AnimatePresence initial={false}>
          {current.map((t) => {
            const def = tagDef(catalog, t);
            return (
              <motion.span
                key={t}
                layout
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7, transition: { duration: 0.12 } }}
                transition={{ type: 'spring', stiffness: 600, damping: 30 }}
              >
                <TagChip
                  tag={t}
                  color={def?.color ?? 'gray'}
                  title={[def?.group, def?.description].filter(Boolean).join(' · ') || undefined}
                  onRemove={() => void save(current.filter((x) => x !== t))}
                />
              </motion.span>
            );
          })}
        </AnimatePresence>
        <button type="button" className="tag-add" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {current.length ? 'Etiqueta' : 'Agregar etiqueta'}
        </button>
      </div>
      <AnimatePresence>{open && <TagPicker selected={current} onToggle={toggle} onClose={() => setOpen(false)} />}</AnimatePresence>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
