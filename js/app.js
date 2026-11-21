/*
 * The page itself: microphone and audio graph, what is shown, calibration, the exposure
 * calculator and the report. All arithmetic lives in meter-core.js.
 */
(() => {
  'use strict';

  const core = window.MeterCore;
  const $ = (id) => document.getElementById(id);
  const shown = (db) => db.toFixed(1); // every level is displayed with one decimal

  // Analyser window and processing block, in samples: one reading per block
  // (about 23 readings a second at 48 kHz).
  const FRAME_SIZE = 2048;

  const limit = (duration, advice) => `권장 노출 한도는 하루 <strong>${duration}</strong>입니다. ${advice}`;
  const TEXT = {
    start: '측정 시작',
    stop: '측정 중지',
    stopped: '측정을 멈췄습니다',
    indistinct: '기기 소음과 구분되지 않음 · 표시값 이하',
    deviceNoise: {
      none: '기기 소음: 저장 안 됨',
      saved: (level) => `기기 소음: ${level} dB`,
      measuring: '기기 소음 재는 중… 조용히 기다리세요',
    },
    band: {
      quiet: '조용함 · 편안한 수준',
      moderate: '보통 · 일상적인 소음',
      elevated: '다소 높음 · 오래 들으면 피로',
      loud: '시끄러움 · 청력에 부담',
      veryLoud: '매우 시끄러움 · 위험한 수준',
    },
    tier: { ok: '상태', caution: '주의', warning: '경고', danger: '위험' },
    exposure: {
      veryQuiet: '아주 조용한 환경입니다. 오래 머물러도 괜찮습니다.',
      safe: '안전한 수준입니다. 노출 시간에 제한이 없습니다.',
      extended: '오래 들으면 피로해질 수 있습니다. 가능하면 노출 시간을 줄이세요.',
      '8h': limit('8시간', '더 오래 머문다면 청력 보호구를 쓰세요.'),
      '4h': limit('4시간', '청력 보호구를 권합니다.'),
      '2h': limit('2시간', '귀마개를 착용하세요.'),
      '1h': limit('1시간', '청력이 손상될 위험이 큽니다.'),
      '30m': limit('30분', '귀를 보호하세요.'),
      '15m': limit('15분', '위험한 수준입니다.'),
      '7m': limit('7~8분', '매우 위험합니다.'),
      '3m': limit('3~4분', '심각하게 위험합니다.'),
      '1m': limit('1~2분', '바로 자리를 옮기세요.'),
      under1m: limit('1분 미만', '지금 자리를 피하세요.'),
      immediate: '<strong>바로 청력이 손상될 수 있는 크기입니다.</strong> 지금 그 자리를 떠나세요.',
    },
    error: {
      micDenied: '마이크 사용이 허용되지 않았습니다. 브라우저에서 이 페이지의 마이크 권한을 허용한 뒤 다시 시도하세요.',
      micMissing: '사용할 수 있는 마이크를 찾지 못했습니다. 마이크 연결을 확인하세요.',
      micFailed: '마이크를 사용할 수 없습니다. 권한과 연결 상태를 확인하세요.',
      report: '보고서를 만들지 못했습니다. 다시 시도하세요.',
    },
    calibrationDefault: '보정: 기본값',
    calibrationOffset: (delta) => `보정: ${delta} dB`,
    calibration: {
      needNumber: '기준 소음계에 표시된 평균값(dB)을 입력하세요.',
      outOfRange: '20~130 dB 사이의 값을 입력하세요.',
      notRunning: '먼저 측정을 시작하고, 평균이 안정될 때까지(30~60초) 기다린 뒤 맞추세요.',
      noReading: '평균값이 표시될 때까지 잠시 기다린 뒤 다시 시도하세요.',
      failed: '저장하지 못했습니다. 다시 시도하세요.',
    },
    duration: {
      under1: () => '1분 미만',
      minutes: (value) => `${value}분`,
      hours: (value) => `${value}시간`,
      over24: () => '24시간 이상',
    },
    note: {
      low: '낮은 수준이라 청력에 미치는 위험은 작습니다. 다만 편안함과 수면에는 영향을 줄 수 있습니다.',
      everyday: '일상에서 흔한 크기입니다. 오래 이어지면 피로해질 수 있습니다.',
      high: '85 dB를 넘으면 안전한 시간이 빠르게 줄어듭니다. 순간적인 최댓값보다 평균과 머문 시간을 기준으로 판단하세요.',
      extreme: '이 정도로 큰 소리는 짧은 시간에도 위험할 수 있습니다. 거리를 두고 청력 보호구를 쓰세요.',
    },
    report: {
      title: '소음 측정 보고서',
      average: '평균 소음',
      min: '최소',
      max: '최대',
      tier: { safe: '안전한 환경', caution: '주의 필요', high: '소음이 높음' },
      footnote: '기기 마이크로 추정한 참고용 값이며, 공인된 소음 측정 결과가 아닙니다.',
    },
  };

  const el = {
    meter: $('meter'),
    level: $('level'),
    status: $('status'),
    stats: $('stats'),
    statMin: $('statMin'),
    statAvg: $('statAvg'),
    statMax: $('statMax'),
    levelBar: $('levelBar'),
    guidance: $('guidance'),
    guidanceLabel: $('guidanceLabel'),
    guidanceText: $('guidanceText'),
    error: $('micError'),
    start: $('startButton'),
    saveReport: $('saveReportButton'),
    micHold: $('micHold'),
    releaseMic: $('releaseMic'),
    calibrationStatus: $('calibrationStatus'),
    openCalibration: $('openCalibration'),
    dialog: $('calibrationDialog'),
    calibrationAverage: $('calibrationAverage'),
    calibrationReference: $('calibrationReference'),
    calibrationMessage: $('calibrationMessage'),
    calibrationSave: $('calibrationSave'),
    calibrationReset: $('calibrationReset'),
    calibrationClose: $('calibrationClose'),
    accurateMode: $('accurateMode'),
    deviceNoiseTools: $('deviceNoiseTools'),
    deviceNoiseStatus: $('deviceNoiseStatus'),
    measureDeviceNoise: $('measureDeviceNoise'),
    clearDeviceNoise: $('clearDeviceNoise'),
    calcLevel: $('calcLevel'),
    calcSlider: $('calcSlider'),
    calcResult: $('calcResult'),
    calcNote: $('calcNote'),
  };

  // Storage may be blocked; every call can throw, and meter-core copes with that.
  const storage = {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  };

  // The charts (and anything else) follow the meter through these window events.
  const announce = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

  let offsetDb = core.DEFAULT_OFFSET_DB;
  let stats = core.createRunningStats();
  let session = null; // audio objects of the run in progress, null when not measuring
  let starting = false;
  // The microphone stream outlives a run, as it does on the reference meter. That keeps the
  // browser's noise suppression and gain settled, so a second run continues at the same
  // level instead of starting high and sinking again over the first seconds.
  let heldStream = null;
  // Accurate mode (not part of the reference meter): browser processing off, device noise removed.
  // The device noise is kept relative to the calibration offset, so recalibrating keeps it valid.
  let { accurate, deviceNoise } = core.loadAccurateSettings(storage);
  let noiseSample = null; // raw readings collected while the device noise is being measured

  // ---------------------------------------------------------------- what is shown

  function showLevel(db) {
    el.level.textContent = shown(db);
    const band = core.levelBand(db);
    el.meter.dataset.level = band;
    el.status.textContent = TEXT.band[band];
    const tier = core.alertTier(db);
    el.guidance.dataset.tier = tier;
    el.guidanceLabel.textContent = TEXT.tier[tier];
    el.guidanceText.innerHTML = TEXT.exposure[core.exposureBand(db)];
    el.levelBar.style.width = core.barPercent(db) + '%';
  }

  function showStats({ min, max, average }) {
    el.statMin.textContent = shown(min);
    el.statAvg.textContent = shown(average);
    el.statMax.textContent = shown(max);
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  // ---------------------------------------------------------------- measuring

  async function start() {
    // Plain { audio: true } unless accurate mode is on: the browser keeps its own processing
    // (echo cancellation, noise suppression, automatic gain), exactly as the reference meter measures.
    const stream = await navigator.mediaDevices.getUserMedia(core.microphoneRequest(accurate));
    releaseMicrophone(); // the previous run's stream; the new one already keeps the device open
    heldStream = stream;
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const displayAnalyser = context.createAnalyser(); // smoothed spectrum for the chart
      const levelAnalyser = context.createAnalyser(); // raw frames for the level
      const source = context.createMediaStreamSource(stream);
      // Used only as a clock: one callback per block of FRAME_SIZE samples.
      const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);

      displayAnalyser.smoothingTimeConstant = 0.8;
      displayAnalyser.fftSize = FRAME_SIZE;
      levelAnalyser.smoothingTimeConstant = 0;
      levelAnalyser.fftSize = FRAME_SIZE;
      levelAnalyser.minDecibels = -120;
      levelAnalyser.maxDecibels = -10;

      offsetDb = core.resolveStartOffset({ search: window.location.search, storage, current: offsetDb });
      const estimator = core.createLevelEstimator({
        sampleRate: context.sampleRate,
        fftSize: FRAME_SIZE,
        floorDb: levelAnalyser.minDecibels,
        offsetDb,
      });
      const samples = new Float32Array(levelAnalyser.fftSize);
      const spectrum = new Float32Array(levelAnalyser.frequencyBinCount);
      const readSpectrum = () => {
        levelAnalyser.getFloatFrequencyData(spectrum);
        return spectrum;
      };

      source.connect(displayAnalyser);
      source.connect(levelAnalyser);
      displayAnalyser.connect(processor);
      levelAnalyser.connect(processor);
      processor.connect(context.destination); // the processor writes nothing, so no sound is played back

      stats = core.createRunningStats();
      session = { context, source, displayAnalyser, levelAnalyser, processor, estimator, accurate };

      processor.onaudioprocess = () => {
        if (!session) return;
        levelAnalyser.getFloatTimeDomainData(samples);
        const raw = estimator.measure(samples, readSpectrum);
        // readings taken while the device noise is being measured are shown as they are
        const useNoise = accurate && deviceNoise !== null && !noiseSample;
        if (noiseSample) collectDeviceNoise(raw, estimator.offsetDb);
        const { db, indistinct } = useNoise ? core.removeDeviceNoise(raw, deviceNoise + estimator.offsetDb) : { db: raw, indistinct: false };
        showStats(stats.add(db));
        announce('noise-reading', { db, raw });
        showLevel(db);
        if (indistinct) el.status.textContent = TEXT.indistinct;
      };

      el.stats.hidden = false;
      el.micHold.hidden = true;
      el.meter.dataset.running = 'true';
      el.start.textContent = TEXT.stop;
      el.saveReport.disabled = true;
      showCalibrationStatus(); // ?cal= in the address may just have saved a new offset
      showAccurateMode();
      announce('noise-start', { analyser: displayAnalyser, sampleRate: context.sampleRate, frameSize: FRAME_SIZE });
    } catch (error) {
      releaseMicrophone();
      throw error;
    }
  }

  function releaseMicrophone() {
    if (!heldStream) return;
    heldStream.getTracks().forEach((track) => track.stop());
    heldStream = null;
  }

  function stop() {
    const { context, source, displayAnalyser, levelAnalyser, processor } = session;
    session = null;
    noiseSample = null; // an unfinished device-noise measurement is dropped

    processor.disconnect();
    processor.onaudioprocess = null;
    displayAnalyser.disconnect();
    levelAnalyser.disconnect();
    source.disconnect();
    context.close().catch(() => {});
    el.micHold.hidden = false; // the stream stays open (see heldStream); offer to release it

    // The last readings contain the click on the button; show the run without them.
    const result = stats.finish();
    if (result) {
      el.statAvg.textContent = shown(result.average);
      showLevel(result.final);
    }
    el.meter.dataset.running = 'false';
    el.start.textContent = TEXT.start;
    el.status.textContent = TEXT.stopped;
    el.saveReport.disabled = stats.count === 0;
    announce('noise-stop');
    showAccurateMode();
  }

  // ---------------------------------------------------------------- accurate mode

  function showAccurateMode() {
    el.accurateMode.checked = accurate;
    el.accurateMode.disabled = Boolean(session); // the microphone is requested once per run
    el.deviceNoiseTools.hidden = !accurate;
    el.measureDeviceNoise.disabled = !session || Boolean(noiseSample);
    el.clearDeviceNoise.hidden = deviceNoise === null;
    el.deviceNoiseStatus.textContent = noiseSample
      ? TEXT.deviceNoise.measuring
      : deviceNoise === null
        ? TEXT.deviceNoise.none
        : TEXT.deviceNoise.saved(shown(deviceNoise + (session ? session.estimator.offsetDb : offsetDb)));
  }

  function collectDeviceNoise(raw, offset) {
    noiseSample.push(raw);
    if (noiseSample.length < core.DEVICE_NOISE_READINGS) return;
    deviceNoise = core.deviceNoiseLevel(noiseSample) - offset;
    noiseSample = null;
    core.rememberDeviceNoise(storage, deviceNoise);
    showAccurateMode();
  }

  async function toggle() {
    if (session) {
      stop();
      return;
    }
    if (starting) return; // the permission prompt is still open
    starting = true;
    el.error.hidden = true;
    try {
      await start();
    } catch (error) {
      console.error('Could not start measuring:', error);
      const name = error && error.name;
      showError(name === 'NotAllowedError' ? TEXT.error.micDenied : name === 'NotFoundError' ? TEXT.error.micMissing : TEXT.error.micFailed);
    } finally {
      starting = false;
    }
  }

  // ---------------------------------------------------------------- calibration

  function showCalibrationStatus() {
    const delta = core.offsetDeltaLabel(core.savedOffsetText(storage));
    el.calibrationStatus.textContent = delta === null ? TEXT.calibrationDefault : TEXT.calibrationOffset(delta);
  }

  function applyOffset(value) {
    offsetDb = value;
    if (session) session.estimator.offsetDb = value; // takes effect from the next reading
  }

  function refreshCalibrationDialog() {
    const average = core.shownLevel(el.statAvg.textContent);
    el.calibrationAverage.textContent = average === null ? '--' : shown(average);
    el.calibrationSave.disabled = !core.canSaveCalibration({ running: Boolean(session), shownAverage: el.statAvg.textContent });
  }

  function openCalibration() {
    el.calibrationReference.value = '';
    el.calibrationMessage.textContent = session ? '' : TEXT.calibration.notRunning;
    refreshCalibrationDialog();
    el.dialog.showModal();
  }

  function saveCalibration() {
    const plan = core.planCalibration({
      reference: el.calibrationReference.value,
      running: Boolean(session),
      shownAverage: el.statAvg.textContent,
      shownValue: el.level.textContent,
      offset: offsetDb,
    });
    if (!plan.ok) {
      el.calibrationMessage.textContent = TEXT.calibration[plan.reason];
      return;
    }
    applyOffset(plan.offset);
    core.rememberOffset(storage, plan.offset);
    showCalibrationStatus();
    showAccurateMode(); // the device noise is shown at the new offset
    el.dialog.close();
  }

  function resetCalibration() {
    applyOffset(core.DEFAULT_OFFSET_DB);
    core.forgetOffset(storage);
    showCalibrationStatus();
    el.dialog.close();
  }

  // ---------------------------------------------------------------- exposure calculator

  /** `tidyField` rewrites the number field with the level actually used; not done while typing. */
  function showCalculator(raw, { tidyField }) {
    const db = core.calculatorLevel(raw);
    el.calcSlider.value = String(db);
    if (tidyField) el.calcLevel.value = String(db);
    const duration = core.describeDuration(core.safeExposureMinutes(db));
    el.calcResult.textContent = TEXT.duration[duration.kind](duration.value);
    el.calcNote.textContent = TEXT.note[core.calculatorNote(db)];
  }

  // ---------------------------------------------------------------- report

  function saveReport() {
    const summary = core.reportSummary({ avg: el.statAvg.textContent, min: el.statMin.textContent, max: el.statMax.textContent });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const canvas = window.NoiseReport.render({
      title: TEXT.report.title,
      date: now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }),
      time: now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      averageLabel: TEXT.report.average,
      average: summary.avg,
      minLabel: TEXT.report.min,
      min: summary.min,
      maxLabel: TEXT.report.max,
      max: summary.max,
      unit: 'dB',
      verdict: TEXT.report.tier[summary.tier],
      tone: summary.tier,
      guidance: TEXT.exposure[summary.exposure].replace(/<[^>]+>/g, ''),
      footnote: TEXT.report.footnote,
    });
    canvas.toBlob((blob) => {
      if (!blob) {
        showError(TEXT.error.report);
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `소음측정-보고서-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    }, 'image/png');
  }

  // ---------------------------------------------------------------- wiring

  el.start.addEventListener('click', toggle);
  el.saveReport.addEventListener('click', saveReport);
  el.releaseMic.addEventListener('click', () => {
    releaseMicrophone();
    el.micHold.hidden = true;
  });

  el.accurateMode.addEventListener('change', () => {
    accurate = el.accurateMode.checked;
    core.rememberAccurateMode(storage, accurate);
    showAccurateMode();
  });
  el.measureDeviceNoise.addEventListener('click', () => {
    if (!session || !accurate) return;
    noiseSample = [];
    showAccurateMode();
  });
  el.clearDeviceNoise.addEventListener('click', () => {
    deviceNoise = null;
    core.forgetDeviceNoise(storage);
    showAccurateMode();
  });

  el.openCalibration.addEventListener('click', openCalibration);
  el.calibrationSave.addEventListener('click', saveCalibration);
  el.calibrationReset.addEventListener('click', resetCalibration);
  el.calibrationClose.addEventListener('click', () => el.dialog.close());
  el.calibrationReference.addEventListener('input', refreshCalibrationDialog);
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog) el.dialog.close(); // a click on the backdrop
  });
  window.addEventListener('noise-reading', () => {
    if (el.dialog.open) refreshCalibrationDialog();
  });

  el.calcLevel.addEventListener('input', () => showCalculator(el.calcLevel.value, { tidyField: false }));
  el.calcLevel.addEventListener('change', () => showCalculator(el.calcLevel.value, { tidyField: true }));
  el.calcSlider.addEventListener('input', () => showCalculator(el.calcSlider.value, { tidyField: true }));

  showCalibrationStatus();
  showAccurateMode();
  showCalculator(el.calcLevel.value, { tidyField: true });
})();
