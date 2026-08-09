// Beeps sintetizados (sin archivos de audio) + vibración. Cada resultado
// tiene un sonido y un patrón de vibración distintos, tal como pide el
// spec ("feedback sonoro y vibración distintos para encontrado /
// desconocido / duplicado").

function beep(frecuencia: number, duracionMs: number, volumen = 0.2) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frecuencia;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volumen, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + duracionMs / 1000);
    osc.onended = () => ctx.close();
  } catch {
    // Audio no soportado o bloqueado por el navegador — no es crítico
    // para el conteo, se ignora.
  }
}

function vibrar(patron: number | number[]) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(patron);
  }
}

export function feedbackEncontrado() {
  beep(880, 80);
  vibrar(30);
}

export function feedbackNoEncontrado() {
  beep(220, 250);
  vibrar([100, 50, 100]);
}

export function feedbackDuplicado() {
  beep(440, 60);
  setTimeout(() => beep(440, 60), 100);
  vibrar(15);
}

export function feedbackCodigoInvalido() {
  beep(180, 300);
  vibrar([50, 30, 50, 30, 50]);
}
