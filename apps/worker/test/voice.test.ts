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

describe.skipIf(!hasFfmpeg)('cuadro de un video (ffmpeg)', () => {
  it('saca una imagen JPEG de un MP4 y no deja archivos temporales', async () => {
    const { videoFrame } = await import('../src/customer-images.js');
    const tmp = (await import('node:os')).tmpdir();
    const { readdir } = await import('node:fs/promises');
    const made = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );
    expect(made.status).toBe(0);
    const frame = await videoFrame(made.stdout as Buffer);
    expect(frame?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect((await readdir(tmp)).some((f) => f.startsWith('zenith-video-'))).toBe(false);
    expect(await videoFrame(Buffer.from('no es un video'))).toBeNull();
  });
});
