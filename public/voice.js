// Voice note → order draft, on the Orders page. Record with the mic or pick a forwarded WhatsApp voice note;
// the server writes down what was said (Hindi, English or Hinglish) and drafts the order the same way as a
// pasted message. Nothing is saved until "Confirm and save". Plain browser script (no build);
// voiceMime and voiceProblem have no DOM, so they are unit-tested.
const VOICE_NOTE = { maxBytes: 10 * 1024 * 1024, minBytes: 800, maxSeconds: 120 };
const VOICE_EXT = { ogg: 'audio/ogg', opus: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm' };
const VOICE_SAY = {
  hint: 'Hindi, English or Hinglish. Forwarded WhatsApp voice notes work too.',
  recording: 'Recording. Say the order, then tap Stop.',
  denied: 'The microphone is off for this site. Allow it in your browser settings, or upload the voice note instead.',
  noMic: "Couldn't find a microphone. Upload the voice note instead.",
  cantRecord: "This browser can't record here. Upload the voice note instead.",
  off: "Voice notes aren't available right now. Type or paste the message instead.",
  notAudio: "That file isn't a voice note. Pick an audio file, like a WhatsApp voice note.",
  tooBig: 'That voice note is too long to send. Send one under 10 MB, about 10 minutes.',
  tooShort: 'That was too short to hear anything. Record a little longer.',
  noOrder: 'No order in what was said. Say the customer, the products and how many, then try again.',
};

/** File name + reported type → the audio type to send, or '' when it is not audio. WhatsApp .opus is Ogg audio. */
function voiceMime(name = '', type = '') {
  const t = String(type).split(';')[0].trim().toLowerCase();
  if (t === 'audio/opus' || t === 'audio/x-opus+ogg') return 'audio/ogg';
  if (t.startsWith('audio/')) return t;
  if (t === 'video/mp4' || t === 'video/webm') return t.replace('video/', 'audio/'); // some phones label voice recordings as video
  return VOICE_EXT[String(name).split('.').pop().toLowerCase()] ?? '';
}
/** Plain-words reason not to send, or '' when the clip is fine. */
function voiceProblem(bytes, mime) {
  if (!mime) return VOICE_SAY.notAudio;
  if (bytes > VOICE_NOTE.maxBytes) return VOICE_SAY.tooBig;
  if (bytes < VOICE_NOTE.minBytes) return VOICE_SAY.tooShort;
  return '';
}

const voiceOn = () => health?.integrations?.elevenlabs?.status !== 'standby' && health?.integrations?.elevenlabs?.status !== 'off';
const canRecord = () => !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia && window.isSecureContext);
const voiceStatus = (msg, warn = false) => { const s = $('#vstat'); if (s) { s.textContent = msg; s.classList.toggle('red', warn); } };
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The control under the message box. Record hides where the browser can't record; everything disables when voice is off. */
function voiceBox() {
  const on = voiceOn(), rec = canRecord();
  return `<div class="voice" id="voice"><h3 class="lbl">From a voice note</h3>
    <div class="acts">${rec ? `<button class="btn" id="vrec" onclick="voiceRecord(this)"${on ? '' : ' disabled'}><span class="dot" aria-hidden="true"></span><span class="vl">Record</span></button>` : ''}
      <button class="btn" id="vup" onclick="$('#vfile').click()"${on ? '' : ' disabled'}>Upload a voice note</button>
      <input type="file" id="vfile" accept="audio/*,.opus,.ogg,.m4a,.mp3,.wav,.aac,.webm" hidden onchange="voiceFile(this)"></div>
    <p class="small quiet" id="vstat" role="status">${on ? (rec ? VOICE_SAY.hint : VOICE_SAY.cantRecord) : VOICE_SAY.off}</p></div>`;
}

let voiceRec = null, voiceTick = 0;
function voiceBusy(on) { for (const b of document.querySelectorAll('#voice .btn')) if (b.id !== 'vrec' || !voiceRec) b.disabled = on; }
async function voiceRecord(btn) {
  if (voiceRec) { if (voiceRec.state === 'recording') voiceRec.stop(); return; }
  if (!canRecord()) return voiceStatus(VOICE_SAY.cantRecord, true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return voiceStatus(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? VOICE_SAY.denied : VOICE_SAY.noMic, true); }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported?.(t));
  const chunks = [], started = Date.now();
  try { voiceRec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
  catch { stream.getTracks().forEach(t => t.stop()); return voiceStatus(VOICE_SAY.cantRecord, true); }
  voiceRec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  voiceRec.onstop = () => {
    const mime = (voiceRec.mimeType || type || 'audio/webm').split(';')[0];
    stream.getTracks().forEach(t => t.stop());
    clearInterval(voiceTick); voiceRec = null;
    btn.classList.remove('recording'); btn.querySelector('.vl').textContent = 'Record';
    sendVoice(new Blob(chunks, { type: mime }));
  };
  voiceRec.start();
  btn.classList.add('recording');
  voiceBusy(true);
  voiceStatus(VOICE_SAY.recording);
  const show = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    btn.querySelector('.vl').textContent = `Stop · ${clock(s)}`;
    if (s >= VOICE_NOTE.maxSeconds && voiceRec?.state === 'recording') voiceRec.stop();
  };
  show(); voiceTick = setInterval(show, 250);
}
function voiceFile(input) {
  const f = input.files?.[0];
  input.value = ''; // picking the same file again still sends it
  if (f) sendVoice(f);
}
async function sendVoice(clip) {
  const mime = voiceMime(clip.name, clip.type), problem = voiceProblem(clip.size, mime);
  voiceBusy(false);
  if (problem) return voiceStatus(problem, true);
  voiceStatus(VOICE_SAY.hint);
  voiceBusy(true);
  $('#draft').innerHTML = '<p class="loading" role="status">Listening to the voice note…</p>';
  try {
    const r = await api('/voice/order', { method: 'POST', body: new Blob([clip], { type: mime }), timeoutMs: API.longTimeoutMs });
    if (r.text && $('#otext')) $('#otext').value = r.text.slice(0, 500); // she can fix a word and read it again
    showDraft(r, r.text);
  } catch (e) {
    // heard words but found no order in them: say so in voice-note terms, not "reword the message"
    const err = e instanceof ApiError && e.status === 422 && e.code !== 'no_speech' ? new ApiError('request', { status: 422, userMessage: VOICE_SAY.noOrder }) : e;
    if ($('#draft')) $('#draft').innerHTML = errorBox(err, 'read the voice note', () => sendVoice(clip));
  }
  voiceBusy(false);
}
