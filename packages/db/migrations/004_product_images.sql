-- 004: fotos de productos y caché de fotos subidas a cada canal.

CREATE TABLE product_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position >= 0),
  mime_type  text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  data       bytea NOT NULL,
  bytes      integer NOT NULL,
  sha256     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, position)
);
CREATE INDEX product_images_tenant_idx ON product_images (tenant_id);

-- WhatsApp devuelve un id por cada archivo subido que dura 30 días: se reutiliza para no
-- subir la misma foto en cada conversación.
CREATE TABLE channel_media (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
  product_image_id   uuid NOT NULL REFERENCES product_images (id) ON DELETE CASCADE,
  image_sha256       text NOT NULL,
  external_media_id  text NOT NULL,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, product_image_id)
);

ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_images USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE channel_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_media USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON product_images, channel_media TO zenith_app;
