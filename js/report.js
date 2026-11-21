/*
 * Draws the measurement report straight onto a canvas, so saving it needs no extra
 * library and works offline. Text and numbers are handed in; nothing is computed here.
 */
(() => {
  'use strict';

  const WIDTH = 800;
  const HEIGHT = 520;
  const SCALE = 2; // exported at twice the layout size so it stays sharp
  const PAD = 48;
  const FONT = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';
  const TONE = {
    safe: { text: '#085d3a', background: '#dcfae6' },
    caution: { text: '#7a4d00', background: '#fef0c7' },
    high: { text: '#912018', background: '#fee4e2' },
  };

  function wrapWords(ctx, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function roundedBox(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius);
    else ctx.rect(x, y, width, height);
    ctx.fill();
  }

  /**
   * @param {object} data { title, date, time, averageLabel, average, minLabel, min, maxLabel, max,
   *                        unit, verdict, tone: 'safe'|'caution'|'high', guidance, footnote }
   * @returns {HTMLCanvasElement}
   */
  function render(data) {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = HEIGHT * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    const text = (weight, size, color, align = 'left') => {
      ctx.font = `${weight} ${size}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
    };

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = 'alphabetic';

    // heading with date and time
    text(700, 28, '#131a26');
    ctx.fillText(data.title, PAD, 76);
    text(600, 15, '#475467', 'right');
    ctx.fillText(data.date, WIDTH - PAD, 60);
    text(400, 13, '#8a94a6', 'right');
    ctx.fillText(data.time, WIDTH - PAD, 82);
    ctx.fillStyle = '#e2e6ed';
    ctx.fillRect(PAD, 104, WIDTH - PAD * 2, 1);

    // the average, large
    text(600, 14, '#5d6879');
    ctx.fillText(data.averageLabel, PAD, 146);
    text(700, 92, '#2b6de8');
    ctx.fillText(data.average, PAD - 4, 236);
    const averageWidth = ctx.measureText(data.average).width;
    text(500, 28, '#8a94a6');
    ctx.fillText(data.unit, PAD + averageWidth + 8, 236);

    // verdict badge
    const tone = TONE[data.tone];
    text(700, 15, tone.background);
    const badgeWidth = ctx.measureText(data.verdict).width + 32;
    roundedBox(ctx, WIDTH - PAD - badgeWidth, 198, badgeWidth, 36, 18);
    text(700, 15, tone.text, 'center');
    ctx.fillText(data.verdict, WIDTH - PAD - badgeWidth / 2, 222);

    // minimum and maximum
    const tileWidth = (WIDTH - PAD * 2 - 16) / 2;
    for (const [label, value, x] of [
      [data.minLabel, data.min, PAD],
      [data.maxLabel, data.max, PAD + tileWidth + 16],
    ]) {
      ctx.fillStyle = '#f6f7f9';
      roundedBox(ctx, x, 268, tileWidth, 84, 12);
      text(600, 13, '#5d6879');
      ctx.fillText(label, x + 20, 298);
      text(700, 28, '#131a26');
      ctx.fillText(value, x + 20, 334);
      const valueWidth = ctx.measureText(value).width;
      text(500, 15, '#8a94a6');
      ctx.fillText(data.unit, x + 26 + valueWidth, 334);
    }

    // guidance for the average level
    text(400, 15, '#344054');
    wrapWords(ctx, data.guidance, WIDTH - PAD * 2)
      .slice(0, 3)
      .forEach((line, i) => ctx.fillText(line, PAD, 394 + i * 24));

    text(400, 12, '#8a94a6');
    ctx.fillText(data.footnote, PAD, HEIGHT - 30);

    return canvas;
  }

  window.NoiseReport = { render };
})();
