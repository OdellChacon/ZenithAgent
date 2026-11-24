import { spawnSync } from 'node:child_process';

/** Un segundo de tono en ogg/opus, como las notas de voz de WhatsApp. */
export function oggTone(): Buffer {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', 'pipe:1'],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return res.stdout;
}
