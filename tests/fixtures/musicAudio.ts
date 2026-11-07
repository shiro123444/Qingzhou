/** One second of real mono PCM audio (440 Hz, 8 kHz), with a complete WAV header. */
export function musicTestWav() {
  const rate = 8000;
  const data = new Uint8Array(44 + rate * 2);
  const view = new DataView(data.buffer);
  const text = (offset: number, value: string) => data.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF');
  view.setUint32(4, data.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, rate * 2, true);
  for (let i = 0; i < rate; i++)
    view.setInt16(44 + i * 2, Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 8000), true);
  return data;
}
