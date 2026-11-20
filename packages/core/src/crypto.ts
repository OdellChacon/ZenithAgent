import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de sobre para credenciales por tenant (tokens de Meta, TikTok…).
 * Cada registro tiene su propia clave de datos (DEK) AES-256-GCM, envuelta con la clave
 * maestra. Rotar la clave maestra implica re-envolver las DEK, no re-cifrar los datos.
 *
 * Formato: [versión 1 B][iv DEK 12][tag DEK 16][DEK cifrada 32][iv 12][tag 16][datos…]
 */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN + KEY_LEN + IV_LEN + TAG_LEN;

export class CredentialsCryptoError extends Error {
  override name = 'CredentialsCryptoError';
}

export function parseMasterKey(base64: string | undefined): Buffer {
  if (!base64) throw new CredentialsCryptoError('Falta la clave maestra de cifrado');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_LEN) {
    throw new CredentialsCryptoError(`La clave maestra debe tener ${KEY_LEN} bytes (base64)`);
  }
  return key;
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * @param aad contexto que queda ligado al cifrado (ej. id del channel_account), para que un
 *            blob copiado a otro registro no se pueda descifrar.
 */
export function encryptCredentials(plaintext: string, masterKey: Buffer, aad: string): Buffer {
  const aadBuf = Buffer.from(aad, 'utf8');
  const dek = randomBytes(KEY_LEN);
  try {
    const wrapped = seal(masterKey, dek, aadBuf);
    const body = seal(dek, Buffer.from(plaintext, 'utf8'), aadBuf);
    return Buffer.concat([
      Buffer.from([VERSION]),
      wrapped.iv,
      wrapped.tag,
      wrapped.data,
      body.iv,
      body.tag,
      body.data,
    ]);
  } finally {
    dek.fill(0);
  }
}

export function decryptCredentials(blob: Buffer, masterKey: Buffer, aad: string): string {
  if (blob.length < HEADER_LEN || blob[0] !== VERSION) {
    throw new CredentialsCryptoError('Formato de credenciales cifradas no reconocido');
  }
  const aadBuf = Buffer.from(aad, 'utf8');
  let offset = 1;
  const take = (len: number) => blob.subarray(offset, (offset += len));
  const wIv = take(IV_LEN);
  const wTag = take(TAG_LEN);
  const wData = take(KEY_LEN);
  const iv = take(IV_LEN);
  const tag = take(TAG_LEN);
  const data = blob.subarray(offset);

  let dek: Buffer | undefined;
  try {
    dek = open(masterKey, wIv, wTag, wData, aadBuf);
    return open(dek, iv, tag, data, aadBuf).toString('utf8');
  } catch (err) {
    if (err instanceof CredentialsCryptoError) throw err;
    throw new CredentialsCryptoError('No se pudieron descifrar las credenciales (clave o contexto incorrectos)');
  } finally {
    dek?.fill(0);
  }
}
