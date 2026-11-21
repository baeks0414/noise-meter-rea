/*
 * Measurement logic of the noise meter. No DOM and no Web Audio in here, so it runs
 * (and is tested) in plain Node as well as in the page.
 *
 * The arithmetic follows the reference meter step for step — same constants, same
 * order of floating-point operations — so identical input gives identical readings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeterCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SILENT_DB = 25; // reading reported for digital silence
  const SMOOTHING = 0.85; // share of the previous level kept on every frame
  const RATIO_MIN = 0.01;
  const RATIO_MAX = 100;
  const DB_MIN = 0;
  const DB_MAX = 130;

  // Weight (in dB) the reference gives to a frequency. It is shaped like the IEC
  // A-curve, but its numerator carries k4 twice, which lifts every value by about
  // 163 dB. The weighted/plain ratio in measure() therefore always lands on RATIO_MAX
  // (a flat +20 dB) and the spectrum has no real influence on the reading.
  // Kept as is on purpose: correcting it would move every reading away from the reference.
  function spectralWeightDb(freq) {
    const f2 = freq * freq;
    const k1 = 20.598997 * 20.598997;
    const k2 = 107.65265 * 107.65265;
    const k3 = 737.86223 * 737.86223;
    const k4 = 12194.217 * 12194.217;
    const response = (k4 * k4 * f2 * f2) / ((f2 + k1) * Math.sqrt((f2 + k2) * (f2 + k3)) * (f2 + k4));
    return 20 * Math.log10(response) + 2.0;
  }

  function spectralWeights(sampleRate, fftSize) {
    const weights = new Float32Array(fftSize / 2); // bin 0 (DC) stays 0
    for (let bin = 1; bin < weights.length; bin++) {
      weights[bin] = Math.pow(10, spectralWeightDb((bin * sampleRate) / fftSize) / 10);
    }
    return weights;
  }

  /**
   * Turns analyser frames into a sound level estimate.
   *   measure(samples, readSpectrumDb) -> dB
   * `samples` is the latest time-domain frame; `readSpectrumDb` returns the matching
   * spectrum in dB and is only called when the frame is not silent.
   */
  function createLevelEstimator({ sampleRate, fftSize = 2048, floorDb = -120, offsetDb = 80 }) {
    const weights = spectralWeights(sampleRate, fftSize);
    let offset = offsetDb;
    let power = null; // smoothed signal power

    return {
      get offsetDb() {
        return offset;
      },
      set offsetDb(value) {
        offset = value;
      },

      measure(samples, readSpectrumDb) {
        let mean = 0;
        for (let i = 0; i < samples.length; i++) mean += samples[i];
        mean /= samples.length;

        let squares = 0;
        for (let i = 0; i < samples.length; i++) {
          const x = samples[i] - mean;
          squares += x * x;
        }
        const rms = Math.sqrt(squares / samples.length);
        if (!(rms > 0)) return SILENT_DB;

        const spectrum = readSpectrumDb();
        let plain = 0;
        let weighted = 0;
        for (let bin = 0; bin < weights.length; bin++) {
          let db = spectrum[bin];
          if (!Number.isFinite(db) || db < floorDb) db = floorDb;
          const binPower = Math.pow(10, db / 10);
          plain += binPower;
          weighted += binPower * weights[bin];
        }
        let ratio = 1;
        if (plain > 0 && weighted > 0) {
          ratio = weighted / plain;
          if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;
          ratio = Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio));
        }

        const framePower = rms * rms * ratio;
        power = power === null ? framePower : SMOOTHING * power + (1 - SMOOTHING) * framePower;
        if (!(power > 0)) return SILENT_DB;

        return Math.max(DB_MIN, Math.min(DB_MAX, 10 * Math.log10(power) + offset));
      },
    };
  }

  // ---------------------------------------------------------------- statistics of a run

  const AVERAGE_WINDOW = 100; // readings the running average covers (about 4 s)
  const TAIL_DROPPED = 12; // readings discarded when a run ends: they contain the click on "stop"
  const SHORT_RUN = 15; // runs up to this length are left untouched
  const FINAL_SPAN = 5; // readings the final level is averaged over

  const meanOf = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

  function createRunningStats() {
    const recent = [];
    let min = Infinity;
    let max = 0;

    return {
      /** Readings currently held (at most AVERAGE_WINDOW). */
      get count() {
        return recent.length;
      },

      /** Minimum and maximum cover the whole run; the average only the latest window. */
      add(db) {
        if (db < min) min = db;
        if (db > max) max = db;
        recent.push(db);
        if (recent.length > AVERAGE_WINDOW) recent.shift();
        return { min, max, average: meanOf(recent) };
      },

      /** Corrected average and final level once a run ends, or null for a short run. */
      finish() {
        if (recent.length <= SHORT_RUN) return null;
        const kept = recent.slice(0, recent.length - TAIL_DROPPED);
        return { average: meanOf(kept), final: meanOf(kept.slice(-FINAL_SPAN)) };
      },
    };
  }

  // ---------------------------------------------------------------- what a level means

  // Each table lists [upper limit, name]; the first limit above the level wins, the last row is the fallback.
  function pick(table, db) {
    for (let i = 0; i < table.length - 1; i++) {
      if (db < table[i][0]) return table[i][1];
    }
    return table[table.length - 1][1];
  }

  const LEVEL_BANDS = [[40, 'quiet'], [70, 'moderate'], [85, 'elevated'], [100, 'loud'], [Infinity, 'veryLoud']];
  // From 85 dB the recommended daily exposure halves with every 3 dB.
  const EXPOSURE_BANDS = [
    [40, 'veryQuiet'],
    [70, 'safe'],
    [85, 'extended'],
    [88, '8h'],
    [91, '4h'],
    [94, '2h'],
    [97, '1h'],
    [100, '30m'],
    [103, '15m'],
    [106, '7m'],
    [109, '3m'],
    [112, '1m'],
    [115, 'under1m'],
    [Infinity, 'immediate'],
  ];
  const ALERT_TIERS = [[70, 'ok'], [85, 'caution'], [100, 'warning'], [Infinity, 'danger']];
  const REPORT_TIERS = [[70, 'safe'], [85, 'caution'], [Infinity, 'high']];

  const levelBand = (db) => pick(LEVEL_BANDS, db);
  const exposureBand = (db) => pick(EXPOSURE_BANDS, db);
  const alertTier = (db) => pick(ALERT_TIERS, db);
  const barPercent = (db) => Math.min((db / DB_MAX) * 100, 100);

  /**
   * The report repeats the statistics as displayed (one decimal, "--" counts as 0)
   * and judges the displayed average.
   */
  function reportSummary({ avg, min, max }) {
    const number = (text) => Number.parseFloat(text) || 0;
    const average = number(avg);
    return {
      avg: average.toFixed(1),
      min: number(min).toFixed(1),
      max: number(max).toFixed(1),
      tier: pick(REPORT_TIERS, average),
      exposure: exposureBand(average),
    };
  }

  // ---------------------------------------------------------------- exposure-time calculator

  const CALCULATOR_MIN = 40;
  const CALCULATOR_MAX = 130;
  const CALCULATOR_DEFAULT = 85;
  const CALCULATOR_NOTES = [[70, 'low'], [85, 'everyday'], [120, 'high'], [Infinity, 'extreme']];

  /** Level the calculator works with for whatever was typed: 40–130 dB, 85 when unreadable. */
  function calculatorLevel(raw) {
    const n = Number.parseFloat(String(raw));
    return Math.min(CALCULATOR_MAX, Math.max(CALCULATOR_MIN, Number.isFinite(n) ? n : CALCULATOR_DEFAULT));
  }

  /** 8 hours at 85 dB, halved for every 3 dB above (and doubled for every 3 dB below). */
  const safeExposureMinutes = (db) => 8 * 60 * Math.pow(2, (85 - db) / 3);

  function describeDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 1) return { kind: 'under1' };
    if (minutes < 60) return { kind: 'minutes', value: Math.round(minutes) };
    const hours = minutes / 60;
    if (hours < 24) return { kind: 'hours', value: Math.round(hours * 10) / 10 };
    return { kind: 'over24' };
  }

  const calculatorNote = (db) => pick(CALCULATOR_NOTES, db);

  // ---------------------------------------------------------------- calibration

  const DEFAULT_OFFSET_DB = 80;
  const OFFSET_MIN = 60;
  const OFFSET_MAX = 200;
  const REFERENCE_MIN = 20;
  const REFERENCE_MAX = 130;
  const STORAGE_KEY = 'noiseMeter.calibrationOffsetDb';

  const parseNumber = (text) => {
    const n = Number.parseFloat(String(text));
    return Number.isFinite(n) ? n : null;
  };
  // A level as shown on screen ("--" or 0.0 means there is none yet).
  const shownLevel = (text) => {
    const n = parseNumber(text);
    return n !== null && n > 0 ? n : null;
  };

  const canSaveCalibration = ({ running, shownAverage }) => Boolean(running) && shownLevel(shownAverage) !== null;

  /**
   * Works out the offset that makes the displayed average equal a trusted reference level.
   * Uses the values as displayed, so the correction matches what the user saw.
   */
  function planCalibration({ reference, running, shownAverage, shownValue, offset }) {
    const target = parseNumber(reference);
    if (target === null) return { ok: false, reason: 'needNumber' };
    if (target < REFERENCE_MIN || target > REFERENCE_MAX) return { ok: false, reason: 'outOfRange' };
    if (!running) return { ok: false, reason: 'notRunning' };
    const average = shownLevel(shownAverage);
    const current = average !== null ? average : parseNumber(shownValue);
    if (current === null || current <= 0) return { ok: false, reason: 'noReading' };
    const next = offset + (target - current);
    if (!Number.isFinite(next)) return { ok: false, reason: 'failed' };
    return { ok: true, offset: Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, next)) };
  }

  /** "+3.5" / "−20.0" for a saved offset that differs from the default, otherwise null. */
  function offsetDeltaLabel(savedText) {
    const saved = savedText === null || savedText === undefined ? null : parseNumber(savedText);
    if (saved === null) return null;
    const delta = saved - DEFAULT_OFFSET_DB;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) return null;
    return (delta >= 0 ? '+' : '−') + Math.abs(delta).toFixed(1);
  }

  /**
   * Offset a new run starts with: `?cal=` in the address (which is also saved), else the
   * saved value, else the offset already in use, else the default.
   */
  function resolveStartOffset({ search, storage, current }) {
    try {
      const fromAddress = new URLSearchParams(search).get('cal');
      if (fromAddress !== null && fromAddress !== '') {
        const n = Number.parseFloat(fromAddress);
        if (Number.isFinite(n)) {
          storage.setItem(STORAGE_KEY, String(n));
          return n;
        }
      }
      const saved = storage.getItem(STORAGE_KEY);
      if (saved !== null && saved !== '') {
        const n = Number.parseFloat(saved);
        if (Number.isFinite(n)) return n;
      }
    } catch (_) {
      // storage unavailable: carry on with what is in use
    }
    return Number.isFinite(current) ? current : DEFAULT_OFFSET_DB;
  }

  function rememberOffset(storage, offset) {
    try {
      storage.setItem(STORAGE_KEY, String(offset));
    } catch (_) {
      // not saved; the offset still applies to this session
    }
  }

  function forgetOffset(storage) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (_) {
      // nothing to remove
    }
  }

  function savedOffsetText(storage) {
    try {
      return storage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------- accurate mode
  // Not part of the reference meter: an optional way of measuring that switches the browser's
  // voice-call processing off and takes the device's own noise out of the readings.

  const ACCURATE_KEY = 'noiseMeter.accurateMode';
  const DEVICE_NOISE_KEY = 'noiseMeter.deviceNoiseDb';
  const DEVICE_NOISE_READINGS = 117; // about 5 s at 48 kHz
  const DISTINCT_MARGIN_DB = 3; // below this margin a reading cannot be told from the device noise

  const toPower = (db) => Math.pow(10, db / 10);
  // What subtracting the device noise takes off a reading that sits `margin` dB above it.
  const noiseShare = (margin) => -10 * Math.log10(1 - toPower(-margin));

  /** How the microphone is asked for: like the reference, or without the browser's processing. */
  const microphoneRequest = (accurate) =>
    accurate ? { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } } : { audio: true };

  /** Level of the device noise: the energy average of the readings taken while only it was audible. */
  const deviceNoiseLevel = (readings) => 10 * Math.log10(meanOf(readings.map(toPower)));

  /**
   * Takes the device noise out of a reading (levels add as energy, so they subtract as energy).
   * A reading less than 3 dB above the noise is flagged: only an upper limit can be given for it.
   */
  function removeDeviceNoise(db, noiseDb) {
    if (noiseDb === null || noiseDb === undefined || !Number.isFinite(noiseDb)) return { db, indistinct: false };
    const margin = db - noiseDb;
    const indistinct = margin < DISTINCT_MARGIN_DB;
    const cut = noiseShare(indistinct ? DISTINCT_MARGIN_DB : margin);
    return { db: Math.max(DB_MIN, db - cut), indistinct };
  }

  /** Saved choices; the device noise is stored relative to the calibration offset. */
  function loadAccurateSettings(storage) {
    try {
      const noise = parseNumber(storage.getItem(DEVICE_NOISE_KEY));
      return { accurate: storage.getItem(ACCURATE_KEY) === '1', deviceNoise: noise };
    } catch (_) {
      return { accurate: false, deviceNoise: null };
    }
  }

  function rememberAccurateMode(storage, accurate) {
    try {
      if (accurate) storage.setItem(ACCURATE_KEY, '1');
      else storage.removeItem(ACCURATE_KEY);
    } catch (_) {
      // not saved; the choice still applies to this visit
    }
  }

  function rememberDeviceNoise(storage, level) {
    try {
      storage.setItem(DEVICE_NOISE_KEY, String(level));
    } catch (_) {
      // not saved; the value still applies to this visit
    }
  }

  function forgetDeviceNoise(storage) {
    try {
      storage.removeItem(DEVICE_NOISE_KEY);
    } catch (_) {
      // nothing to remove
    }
  }

  // ---------------------------------------------------------------- chart data

  const HISTORY_LENGTH = 300; // one point per reading: roughly 13 s at 48 kHz

  /** Levels for the history chart: a fixed-length window that starts out as a flat line at 0. */
  function createHistory() {
    const values = new Array(HISTORY_LENGTH).fill(0);
    return {
      values,
      get hasData() {
        return values.some((v) => v > 0);
      },
      push(db) {
        values.push(db);
        if (values.length > HISTORY_LENGTH) values.shift();
      },
    };
  }

  /** Averages equal slices of the analyser's byte spectrum (0–255) into `count` bars. */
  function spectrumBars(bins, count) {
    const slice = Math.floor(bins.length / count);
    const bars = [];
    for (let bar = 0; bar < count; bar++) {
      let sum = 0;
      for (let j = 0; j < slice; j++) sum += bins[bar * slice + j];
      bars.push(sum / slice);
    }
    return bars;
  }

  return {
    DEFAULT_OFFSET_DB,
    HISTORY_LENGTH,
    createHistory,
    spectrumBars,
    createLevelEstimator,
    createRunningStats,
    levelBand,
    exposureBand,
    alertTier,
    barPercent,
    reportSummary,
    calculatorLevel,
    safeExposureMinutes,
    describeDuration,
    calculatorNote,
    shownLevel,
    canSaveCalibration,
    planCalibration,
    offsetDeltaLabel,
    resolveStartOffset,
    rememberOffset,
    forgetOffset,
    savedOffsetText,
    DEVICE_NOISE_READINGS,
    microphoneRequest,
    deviceNoiseLevel,
    removeDeviceNoise,
    loadAccurateSettings,
    rememberAccurateMode,
    rememberDeviceNoise,
    forgetDeviceNoise,
  };
});
