-- 003: orden estable de mensajes.
-- WhatsApp informa la hora al segundo, así que dos mensajes seguidos pueden tener el mismo
-- created_at. seq registra el orden en que se guardaron y sirve de desempate.

ALTER TABLE messages ADD COLUMN seq bigserial;
CREATE INDEX messages_conversation_order_idx ON messages (conversation_id, created_at DESC, seq DESC);
DROP INDEX IF EXISTS messages_conversation_idx;

GRANT USAGE ON SEQUENCE messages_seq_seq TO zenith_app;
