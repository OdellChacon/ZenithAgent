import { useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, ApiError, type TagColor, type TagDef, type TagGroup } from './api';
import { ColorSwatches, normalizeTag, refreshTags, TAG_RE, tagLabel, useTagCatalog } from './tags';
import { playSound } from './sounds';
import { Trash2, X } from 'lucide-react';

/** Ejecuta un cambio del catálogo, recarga y devuelve el mensaje de error si falló. */
async function run(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    await refreshTags();
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : 'No se pudo guardar.';
  }
}

function TagRow({ t, groups, canManage, onError }: { t: TagDef; groups: TagGroup[]; canManage: boolean; onError: (m: string | null) => void }) {
  const [name, setName] = useState(t.tag);
  const [description, setDescription] = useState(t.description ?? '');
  const [colors, setColors] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'merge' | null>(null);
  const all = useTagCatalog();
  useEffect(() => setName(t.tag), [t.tag]);
  useEffect(() => setDescription(t.description ?? ''), [t.description]);

  const patch = async (p: Parameters<typeof api.updateTag>[1]) => onError(await run(() => api.updateTag(t.tag, p)));

  const rename = async () => {
    const next = normalizeTag(name);
    if (next === t.tag) return;
    if (!TAG_RE.test(next)) {
      setName(t.tag);
      return onError('Usa letras, números, espacios, - o _ (máximo 30).');
    }
    // Renombrar a una que ya existe las fusiona: se pide confirmación.
    if (all?.items.some((i) => i.tag === next) && confirm !== 'merge') return setConfirm('merge');
    setConfirm(null);
    await patch({ name: next });
  };

  return (
    <motion.li layout className="tm-row" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }}>
      <div className="tm-main">
        <button
          type="button"
          className={`tm-color tdot tc-${t.color}`}
          disabled={!canManage}
          aria-label={`Color de ${t.tag}`}
          onClick={() => setColors(!colors)}
        />
        {canManage ? (
          <input
            className="tm-name"
            value={name}
            maxLength={40}
            aria-label="Nombre de la etiqueta"
            onChange={(e) => {
              setName(e.target.value);
              setConfirm(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), void rename())}
            onBlur={() => void rename()}
          />
        ) : (
          <b className="tm-name">{tagLabel(t.tag)}</b>
        )}
        <span className="tm-count" title="Contactos con esta etiqueta">
          {t.count} {t.count === 1 ? 'contacto' : 'contactos'}
        </span>
        {canManage && (
          <>
            <select
              className="tm-group"
              value={t.group ?? ''}
              aria-label="Grupo"
              onChange={(e) => void patch({ group: e.target.value || null })}
            >
              <option value="">Sin grupo</option>
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
            <button type="button" className="icon-btn tm-del" aria-label={`Borrar ${t.tag}`} onClick={() => setConfirm(confirm === 'delete' ? null : 'delete')}>
              <Trash2 strokeWidth={1.9} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {canManage ? (
        <input
          className="tm-desc"
          value={description}
          maxLength={200}
          placeholder="Descripción (opcional): para qué sirve esta etiqueta"
          aria-label="Descripción"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description.trim() !== (t.description ?? '') && void patch({ description: description.trim() || null })}
        />
      ) : (
        t.description && <p className="tm-desc-ro">{t.description}</p>
      )}
      <AnimatePresence>
        {colors && canManage && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden' }}>
            <ColorSwatches
              value={t.color}
              onChange={(c: TagColor) => {
                setColors(false);
                void patch({ color: c });
              }}
            />
          </motion.div>
        )}
        {confirm && (
          <motion.div className="tm-confirm" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <span>
              {confirm === 'delete'
                ? t.count
                  ? `Se quitará de ${t.count} ${t.count === 1 ? 'contacto' : 'contactos'}. No se puede deshacer.`
                  : '¿Borrar esta etiqueta?'
                : `Ya existe «${tagLabel(normalizeTag(name))}». Se unirán: los contactos de «${tagLabel(t.tag)}» quedarán con la otra.`}
            </span>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setConfirm(null);
                setName(t.tag);
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn small danger-btn"
              onClick={async () => {
                if (confirm === 'delete') onError(await run(() => api.deleteTag(t.tag)));
                else await patch({ name: normalizeTag(name) });
                setConfirm(null);
              }}
            >
              {confirm === 'delete' ? 'Borrar' : 'Unir'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function GroupHead({ g, count, canManage, onError }: { g: TagGroup; count: number; canManage: boolean; onError: (m: string | null) => void }) {
  const [name, setName] = useState(g.name);
  useEffect(() => setName(g.name), [g.name]);
  return (
    <div className="tm-group-head">
      {canManage ? (
        <input
          className="tm-group-name"
          value={name}
          maxLength={30}
          aria-label="Nombre del grupo"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={async () => {
            const next = name.trim().replace(/\s+/g, ' ');
            if (!next || next === g.name) return setName(g.name);
            const e = await run(() => api.updateTagGroup(g.name, { name: next }));
            if (e) setName(g.name);
            onError(e);
          }}
        />
      ) : (
        <h3>{g.name}</h3>
      )}
      <span className="muted small">{count}</span>
      <label className={`tm-exclusive ${canManage ? '' : 'ro'}`} title="Un contacto solo puede tener una etiqueta de este grupo">
        <input
          type="checkbox"
          checked={g.exclusive}
          disabled={!canManage}
          onChange={async (e) => onError(await run(() => api.updateTagGroup(g.name, { exclusive: e.target.checked })))}
        />
        <span className={`switch ${g.exclusive ? 'on' : ''}`} aria-hidden="true" />
        Una sola por contacto
      </label>
      {canManage && (
        <button
          type="button"
          className="btn ghost small"
          title="Borrar el grupo (las etiquetas se conservan, sin grupo)"
          onClick={async () => onError(await run(() => api.deleteTagGroup(g.name)))}
        >
          Quitar grupo
        </button>
      )}
    </div>
  );
}

/** Panel lateral para administrar las etiquetas del negocio. */
export function TagManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const catalog = useTagCatalog();
  const [error, setError] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');
  const [newColor, setNewColor] = useState<TagColor>('teal');
  const [newGroup, setNewGroup] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const canManage = !!catalog?.canManage;
  const groups = catalog?.groups ?? [];
  const sections: { group: TagGroup | null; tags: TagDef[] }[] = [
    ...groups.map((g) => ({ group: g, tags: (catalog?.items ?? []).filter((t) => t.group === g.name) })),
    { group: null, tags: (catalog?.items ?? []).filter((t) => !t.group) },
  ];

  const addTag = async (e: FormEvent) => {
    e.preventDefault();
    const name = normalizeTag(newTag);
    if (!name) return;
    if (!TAG_RE.test(name)) return setError('Usa letras, números, espacios, - o _ (máximo 30).');
    const err = await run(() => api.createTag({ name, color: newColor }));
    setError(err);
    if (!err) {
      setNewTag('');
      playSound('success');
    }
  };

  const addGroup = async (e: FormEvent) => {
    e.preventDefault();
    const name = newGroup.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const err = await run(() => api.createTagGroup({ name }));
    setError(err);
    if (!err) setNewGroup('');
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Administrar etiquetas"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 40 }}
          >
            <header className="drawer-head">
              <div>
                <h2>Etiquetas</h2>
                <p className="muted small">
                  Clasifica a tus contactos: tipo de cliente, perfil, obra… Los grupos de “una sola por contacto” sirven para cosas como mayorista, proveedor o
                  potencial.
                </p>
              </div>
              <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
                <X strokeWidth={1.9} aria-hidden="true" />
              </button>
            </header>

            <form className="tm-new" onSubmit={addTag}>
              <div className="tm-new-row">
                <span className={`tdot tc-${newColor}`} aria-hidden="true" />
                <input value={newTag} onChange={(e) => setNewTag(e.target.value)} maxLength={40} placeholder="Nueva etiqueta (ej.: arquitecto)" aria-label="Nueva etiqueta" />
                <button className="btn primary small" type="submit" disabled={!newTag.trim()}>
                  Crear
                </button>
              </div>
              <ColorSwatches value={newColor} onChange={setNewColor} />
            </form>

            {!canManage && catalog && (
              <p className="notice small" style={{ margin: '0 18px' }}>
                Puedes crear etiquetas y ponérselas a tus contactos. Cambiar colores, renombrar, agrupar o borrar lo hace un administrador.
              </p>
            )}
            <AnimatePresence>
              {error && (
                <motion.p className="error small tm-error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert">
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <div className="drawer-body">
              {catalog === null && <p className="muted pad">Cargando…</p>}
              {sections.map((s) =>
                !s.group && !s.tags.length ? null : (
                  <section key={s.group?.name ?? '__none__'} className="tm-section">
                    {s.group ? (
                      <GroupHead g={s.group} count={s.tags.length} canManage={canManage} onError={setError} />
                    ) : (
                      <div className="tm-group-head">
                        <h3>Sin grupo</h3>
                        <span className="muted small">{s.tags.length}</span>
                      </div>
                    )}
                    <ul className="tm-list">
                      <AnimatePresence initial={false}>
                        {s.tags.map((t) => (
                          <TagRow key={t.tag} t={t} groups={groups} canManage={canManage} onError={setError} />
                        ))}
                      </AnimatePresence>
                      {s.group && !s.tags.length && <li className="muted small tm-empty">Sin etiquetas: asígnale este grupo a alguna desde su fila.</li>}
                    </ul>
                  </section>
                ),
              )}
              {canManage && (
                <form className="tm-new-group" onSubmit={addGroup}>
                  <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} maxLength={30} placeholder="Nuevo grupo (ej.: Perfil, Origen)" aria-label="Nuevo grupo" />
                  <button className="btn small" type="submit" disabled={!newGroup.trim()}>
                    Crear grupo
                  </button>
                </form>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
