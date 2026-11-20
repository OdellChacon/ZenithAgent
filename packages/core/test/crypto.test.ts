import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialsCryptoError, decryptCredentials, encryptCredentials, parseMasterKey } from '../src/crypto.js';

const master = randomBytes(32);
const secret = JSON.stringify({ accessToken: 'token-de-prueba' });

describe('cifrado de credenciales', () => {
  it('descifra lo que cifra con la misma clave y contexto', () => {
    const blob = encryptCredentials(secret, master, 'channel-account-1');
    expect(decryptCredentials(blob, master, 'channel-account-1')).toBe(secret);
  });

  it('no deja el texto en claro dentro del blob', () => {
    const blob = encryptCredentials(secret, master, 'ctx');
    expect(blob.toString('utf8')).not.toContain('token-de-prueba');
  });

  it('cada cifrado es distinto aunque el texto sea igual', () => {
    expect(encryptCredentials(secret, master, 'ctx').equals(encryptCredentials(secret, master, 'ctx'))).toBe(false);
  });

  it('falla con otra clave maestra', () => {
    const blob = encryptCredentials(secret, master, 'ctx');
    expect(() => decryptCredentials(blob, randomBytes(32), 'ctx')).toThrow(CredentialsCryptoError);
  });

  it('falla si el blob se mueve a otro registro (contexto distinto)', () => {
    const blob = encryptCredentials(secret, master, 'channel-account-1');
    expect(() => decryptCredentials(blob, master, 'channel-account-2')).toThrow(CredentialsCryptoError);
  });

  it('falla si el blob fue alterado', () => {
    const blob = encryptCredentials(secret, master, 'ctx');
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptCredentials(blob, master, 'ctx')).toThrow(CredentialsCryptoError);
  });

  it('rechaza blobs truncados o de otra versión', () => {
    expect(() => decryptCredentials(Buffer.alloc(10), master, 'ctx')).toThrow(CredentialsCryptoError);
    const blob = encryptCredentials(secret, master, 'ctx');
    blob[0] = 9;
    expect(() => decryptCredentials(blob, master, 'ctx')).toThrow(CredentialsCryptoError);
  });
});

describe('parseMasterKey', () => {
  it('acepta 32 bytes en base64', () => {
    expect(parseMasterKey(master.toString('base64')).equals(master)).toBe(true);
  });

  it('rechaza claves vacías o de otro tamaño', () => {
    expect(() => parseMasterKey(undefined)).toThrow(CredentialsCryptoError);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(CredentialsCryptoError);
  });
});
