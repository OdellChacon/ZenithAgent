-- 017: avance de los envíos en varias partes (Messenger e Instagram).
--
-- Un texto largo sale en varios mensajes, y un archivo con texto sale como archivo y después el
-- texto aparte. Si una parte falla y el envío se reintenta, parts_sent dice cuántas ya llegaron
-- para no mandarlas otra vez ni perder las que faltan.

ALTER TABLE outbound_messages ADD COLUMN parts_sent integer NOT NULL DEFAULT 0 CHECK (parts_sent >= 0);
