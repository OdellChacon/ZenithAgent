-- 007: lo que se ve en la foto de cada producto (aspecto, colores, patrón), descrito por el
-- modelo de visión. La tienda casi no describe sus productos, y sin esto el bot no encuentra
-- una pieza por cómo se ve. Va en columnas aparte para que la sincronización del catálogo,
-- que reescribe attributes, no lo borre.

ALTER TABLE products
  ADD COLUMN look jsonb,
  -- sha256 de la foto descrita: si la foto cambia, se vuelve a describir.
  ADD COLUMN look_image_sha256 text,
  ADD COLUMN look_model text,
  ADD COLUMN look_at timestamptz;
