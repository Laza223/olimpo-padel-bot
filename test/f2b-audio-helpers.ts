// Conversor y transcriptor falsos para las pruebas de audios (F2b): sin ffmpeg, sin red y sin OpenAI.
import { TRANSCRIBE_USD_PER_MIN } from '../src/audio.ts';
import type { AudioDeps, ConvertAudio, Transcriber } from '../src/audio.ts';
import { policy } from './f2-helpers.ts';

export class ScriptedAudio implements AudioDeps {
  seconds = 12; // duración que "mide" el conversor
  converted = 0; // veces que se convirtió un audio
  transcribed = 0; // veces que se llamó al transcriptor (incluidas las que tiraron)
  script: (string | Error)[] = ['quiero una cancha en Pilar']; // lo que contesta el transcriptor, en orden; la última se repite
  convertError?: Error;
  convert: ConvertAudio;
  transcriber: Transcriber;

  constructor(o: { convert?: ConvertAudio } = {}) {
    this.convert = async (data) => {
      this.converted++;
      if (o.convert) return o.convert(data);
      if (this.convertError) throw this.convertError;
      return { mp3: new Uint8Array([9, 9, 9]), seconds: this.seconds };
    };
    this.transcriber = {
      model: 'gpt-transcribe',
      costPerMinuteUsd: TRANSCRIBE_USD_PER_MIN,
      transcribe: async () => {
        const r = this.script[Math.min(this.transcribed++, this.script.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    };
  }
}

// El pedido de texto de un audio ilegible. Si es el primer mensaje del bot (las pruebas corren a las 14:00), va con el saludo y la presentación aprobados delante, en un solo globo.
export const ASK = policy.audioIlegibleText;
export const ASK_FIRST = `Buenas tardes, te escribimos de Olimpo Padel. ${ASK}`;
