// public/voice.js is a plain browser script; check its file handling in a vm context (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');
const ctx: any = {};
vm.runInNewContext(src + '\nthis.voiceMime = voiceMime; this.voiceProblem = voiceProblem; this.VOICE_SAY = VOICE_SAY; this.VOICE_NOTE = VOICE_NOTE;', ctx);
const { voiceMime, voiceProblem, VOICE_SAY, VOICE_NOTE } = ctx;

test('WhatsApp and phone recordings map to an audio type the server accepts', () => {
  assert.equal(voiceMime('PTT-20261005-WA0003.opus', ''), 'audio/ogg'); // forwarded WhatsApp voice note, no type from the OS
  assert.equal(voiceMime('note.opus', 'audio/opus'), 'audio/ogg');
  assert.equal(voiceMime('note.ogg', 'audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(voiceMime('memo.m4a', 'audio/x-m4a'), 'audio/x-m4a');
  assert.equal(voiceMime('memo.m4a', ''), 'audio/mp4');
  assert.equal(voiceMime('rec.mp4', 'video/mp4'), 'audio/mp4');
  assert.equal(voiceMime('', 'audio/webm;codecs=opus'), 'audio/webm'); // Chrome MediaRecorder
  assert.equal(voiceMime('photo.jpg', 'image/jpeg'), '');
  assert.equal(voiceMime('notes.txt', ''), '');
});

test('clips that are not audio, too big or too short get plain words, not a request', () => {
  assert.equal(voiceProblem(50_000, 'audio/ogg'), '');
  assert.equal(voiceProblem(50_000, ''), VOICE_SAY.notAudio);
  assert.equal(voiceProblem(VOICE_NOTE.maxBytes + 1, 'audio/ogg'), VOICE_SAY.tooBig);
  assert.equal(voiceProblem(100, 'audio/webm'), VOICE_SAY.tooShort);
  assert.equal(VOICE_NOTE.maxBytes, 10 * 1024 * 1024); // matches express.raw({ limit: '10mb' }) on /voice/order
});

test('seller copy stays plain: no codes, formats or service names', () => {
  for (const m of Object.values(VOICE_SAY) as string[]) assert.doesNotMatch(m, /ElevenLabs|Scribe|STT|MediaRecorder|HTTP|\b[45]\d\d\b|error|mime/i, m);
});
