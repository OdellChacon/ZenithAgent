-- 012: foto de la fachada del negocio.
--
-- Cuando el cliente pregunta dónde queda la tienda, el bot manda la foto de la fachada con la
-- dirección como pie. Se guarda junto a las fotos de productos para reutilizar el envío y la
-- caché de archivos subidos a WhatsApp (channel_media); no pertenece a ningún producto.

ALTER TABLE product_images
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN purpose text NOT NULL DEFAULT 'product' CHECK (purpose IN ('product', 'storefront')),
  ADD CONSTRAINT product_images_purpose_product CHECK ((purpose = 'product') = (product_id IS NOT NULL));

-- Una sola foto de fachada por negocio.
CREATE UNIQUE INDEX product_images_storefront_idx ON product_images (tenant_id) WHERE purpose = 'storefront';
