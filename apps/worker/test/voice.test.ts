import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { toModelAudio } from '../src/voice.js';
import { oggTone } from './audio-fixture.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

describe.skipIf(!hasFfmpeg)('conversión de notas de voz (ffmpeg)', () => {
  it('pasa ogg/opus a mp3 que acepta el modelo', async () => {
    const audio = await toModelAudio(oggTone());
    expect(audio?.format).toBe('mp3');
    const mp3 = Buffer.from(audio!.base64, 'base64');
    // Encabezado ID3 o sincronía de cuadro MPEG.
    expect(mp3.subarray(0, 3).toString() === 'ID3' || (mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0)).toBe(true);
  });

  it('devuelve null si el archivo no es audio', async () => {
    expect(await toModelAudio(Buffer.from('esto no es un audio'))).toBeNull();
  });
});

describe('sin ffmpeg', () => {
  it('devuelve null en vez de romper el turno', async () => {
    expect(await toModelAudio(Buffer.from('x'), 'ffmpeg-que-no-existe-zenith')).toBeNull();
  });
});
