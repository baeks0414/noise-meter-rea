/*
 * Spectrum and level-history charts.
 * Listens to the meter's window events (noise-start / noise-reading / noise-stop) and
 * knows nothing else about it.
 */
(() => {
  'use strict';

  const core = window.MeterCore;

  const BAR_COUNT = 64; // bars across 0 Hz .. half the sample rate, linear
  const HISTORY_TOP_DB = 120;
  const FONT = '11px "Pretendard", "Malgun Gothic", system-ui, sans-serif';
  const COLOR = {
    grid: '#e4e8ef',
    label: '#7b8698',
    line: '#2b6de8',
    barTop: '#1f55c4',
    barBottom: '#8db4f8',
    caution: '#c28a00',
    danger: '#d6302a',
  };

  const history = core.createHistory();
  let analyser = null; // only set while measuring
  let bytes = null;
  let lastBars = null;
  // Until the first run tells us otherwise, assume the usual 48 kHz / 2048-sample frames.
  let sampleRate = 48000;
  let frameSize = 2048;

  /** Sizes a canvas to its box (sharp on high-density screens) and returns a drawing view. */
  function fit(canvas) {
    const box = canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * ratio));
    canvas.height = Math.max(1, Math.round(box.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width: box.width, height: box.height };
  }

  const frequencyLabel = (hz) => (hz === 0 ? '0 Hz' : `${Math.round(hz / 100) / 10} kHz`);
  const secondsLabel = (s) => `${Math.round(s * 10) / 10}초 전`;

  function drawSpectrum({ ctx, width, height }, bars) {
    const axis = 22; // room for the frequency labels
    const plot = height - axis;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = COLOR.grid;
    ctx.fillRect(0, plot - 1, width, 1);

    if (bars) {
      const slot = width / bars.length;
      const gradient = ctx.createLinearGradient(0, plot, 0, 0);
      gradient.addColorStop(0, COLOR.barBottom);
      gradient.addColorStop(1, COLOR.barTop);
      ctx.fillStyle = gradient;
      bars.forEach((value, i) => {
        const barHeight = (value / 255) * plot;
        if (barHeight <= 0) return;
        const x = i * slot;
        const w = Math.max(1, slot - 1);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, plot - barHeight, w, barHeight, [3, 3, 0, 0]);
        else ctx.rect(x, plot - barHeight, w, barHeight);
        ctx.fill();
      });
    }

    const top = sampleRate / 2;
    ctx.font = FONT;
    ctx.fillStyle = COLOR.label;
    ctx.textBaseline = 'alphabetic';
    for (const [at, align] of [[0, 'left'], [0.25, 'center'], [0.5, 'center'], [0.75, 'center'], [1, 'right']]) {
      ctx.textAlign = align;
      ctx.fillText(frequencyLabel(top * at), width * at, height - 6);
    }
  }

  function drawHistory({ ctx, width, height }, values) {
    const left = 30;
    const right = 48; // gutter for the threshold labels, clear of the curve
    const top = 14;
    const bottom = 22;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const y = (db) => top + plotHeight - (Math.max(0, Math.min(HISTORY_TOP_DB, db)) / HISTORY_TOP_DB) * plotHeight;
    const rule = (level) => {
      ctx.beginPath();
      ctx.moveTo(left, y(level));
      ctx.lineTo(width - right, y(level));
      ctx.stroke();
    };

    ctx.clearRect(0, 0, width, height);
    ctx.font = FONT;
    ctx.lineWidth = 1;

    // level grid
    ctx.setLineDash([]);
    ctx.strokeStyle = COLOR.grid;
    ctx.fillStyle = COLOR.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const level of [30, 60, 90, 120]) {
      rule(level);
      ctx.fillText(String(level), left - 6, y(level));
    }

    // the two levels that matter for hearing
    ctx.textAlign = 'left';
    for (const [level, color, label] of [[85, COLOR.danger, '85 위험'], [70, COLOR.caution, '70 주의']]) {
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      rule(level);
      ctx.fillStyle = color;
      ctx.fillText(label, width - right + 8, y(level));
    }
    ctx.setLineDash([]);

    // time axis: the window is one point per reading, so its length follows the audio frame rate
    const windowSeconds = (values.length * frameSize) / sampleRate;
    ctx.fillStyle = COLOR.label;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(secondsLabel(windowSeconds), left, height - 6);
    ctx.textAlign = 'center';
    ctx.fillText(secondsLabel(windowSeconds / 2), left + plotWidth / 2, height - 6);
    ctx.textAlign = 'right';
    ctx.fillText('지금', width - right, height - 6);

    // the curve, its soft fill, and a dot on the current level
    const step = plotWidth / (values.length - 1);
    const lastX = left + (values.length - 1) * step;
    ctx.beginPath();
    values.forEach((db, i) => {
      if (i === 0) ctx.moveTo(left, y(db));
      else ctx.lineTo(left + i * step, y(db));
    });
    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo(lastX, top + plotHeight);
    ctx.lineTo(left, top + plotHeight);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, top + plotHeight);
    fill.addColorStop(0, 'rgba(43, 109, 232, 0.22)');
    fill.addColorStop(1, 'rgba(43, 109, 232, 0)');
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lastX, y(values[values.length - 1]), 4, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.line;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  const canvases = { spectrum: document.getElementById('spectrumCanvas'), history: document.getElementById('historyCanvas') };
  const views = { spectrum: fit(canvases.spectrum), history: fit(canvases.history) };

  function frame() {
    if (analyser) {
      analyser.getByteFrequencyData(bytes);
      lastBars = core.spectrumBars(bytes, BAR_COUNT);
      drawSpectrum(views.spectrum, lastBars);
    } else if (!history.hasData) {
      drawSpectrum(views.spectrum, null);
    }
    // otherwise the last measured spectrum stays on screen
    drawHistory(views.history, history.values);
    requestAnimationFrame(frame);
  }

  const resized = new ResizeObserver(() => {
    views.spectrum = fit(canvases.spectrum);
    views.history = fit(canvases.history);
    if (!analyser && history.hasData) drawSpectrum(views.spectrum, lastBars); // resizing wiped the frozen picture
  });
  resized.observe(canvases.spectrum.parentElement);
  resized.observe(canvases.history.parentElement);

  window.addEventListener('noise-start', (event) => {
    ({ analyser, sampleRate, frameSize } = event.detail);
    bytes = new Uint8Array(analyser.frequencyBinCount);
  });
  window.addEventListener('noise-reading', (event) => history.push(event.detail.db));
  window.addEventListener('noise-stop', () => {
    analyser = null;
  });

  frame();
})();
