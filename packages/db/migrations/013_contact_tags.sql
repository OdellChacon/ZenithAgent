-- 013: etiquetas de contactos administrables.
--
-- contacts.tags sigue guardando los nombres (en minúsculas) para filtrar rápido. Estas tablas
-- agregan lo que el equipo administra: color, descripción y grupo de cada etiqueta. Un grupo
-- "exclusivo" (ej. "Tipo de cliente": mayorista, proveedor…) admite una sola etiqueta por contacto.

CREATE TABLE contact_tag_groups (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  exclusive   boolean NOT NULL DEFAULT false,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE contact_tag_defs (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  color        text NOT NULL DEFAULT 'gray'
               CHECK (color IN ('gray', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink')),
  group_name   text,
  description  text CHECK (char_length(description) <= 200),
  position     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name),
  FOREIGN KEY (tenant_id, group_name) REFERENCES contact_tag_groups (tenant_id, name)
    ON UPDATE CASCADE ON DELETE SET NULL (group_name)
);

ALTER TABLE contact_tag_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_tag_groups USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE contact_tag_defs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_tag_defs USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_tag_groups, contact_tag_defs TO zenith_app;

-- Punto de partida para cada negocio: el grupo "Tipo de cliente" con los tipos más comunes.
INSERT INTO contact_tag_groups (tenant_id, name, exclusive, position)
SELECT id, 'Tipo de cliente', true, 0 FROM tenants;

INSERT INTO contact_tag_defs (tenant_id, name, color, group_name, description, position)
SELECT t.id, d.name, d.color, 'Tipo de cliente', d.description, d.position
  FROM tenants t
 CROSS JOIN (VALUES
   ('cliente', 'green', 'Ya compró en la tienda', 0),
   ('potencial', 'amber', 'Preguntó o cotizó, todavía no compra', 1),
   ('mayorista', 'blue', 'Compra al mayor', 2),
   ('proveedor', 'violet', 'Nos vende o distribuye productos', 3)
 ) AS d(name, color, description, position);

-- Las etiquetas que el equipo ya usaba quedan registradas, sin grupo, con colores variados.
INSERT INTO contact_tag_defs (tenant_id, name, color, position)
SELECT u.tenant_id, u.tag,
       (ARRAY['teal', 'sky', 'pink', 'orange', 'lime', 'red'])[1 + (row_number() OVER (PARTITION BY u.tenant_id ORDER BY u.tag) - 1) % 6],
       100 + row_number() OVER (PARTITION BY u.tenant_id ORDER BY u.tag)
  FROM (SELECT DISTINCT tenant_id, unnest(tags) AS tag FROM contacts) u
 WHERE char_length(u.tag) BETWEEN 1 AND 30
ON CONFLICT DO NOTHING;
