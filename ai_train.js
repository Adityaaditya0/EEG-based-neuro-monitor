/**
 * NeuroWatch AI Training Engine
 * 
 * Analyzes the Bonn University EEG Dataset to extract feature statistics
 * and generate a risk prediction model (ai_model.json).
 * 
 * The model uses clinically-validated EEG biomarkers:
 *   - Hjorth Parameters (Activity, Mobility, Complexity)
 *   - Spectral Entropy
 *   - Band Power Ratios (Delta/Beta, Theta/Alpha)
 *   - Line Length
 *   - Zero-Crossing Rate
 *   - Peak-to-Peak Amplitude
 *   - Kurtosis & Skewness
 * 
 * Training data classes (Bonn Dataset):
 *   Set A (Z*.txt): Normal, eyes open         → Risk: 0-15%
 *   Set B (O*.txt): Normal, eyes closed        → Risk: 5-20%
 *   Set C (N*.txt): Hippocampal (epilepsy)     → Risk: 25-45%
 *   Set D (F*.txt): Epileptogenic zone         → Risk: 45-70%
 *   Set E (S*.txt): Active seizure             → Risk: 75-100%
 */

const fs = require('fs');
const path = require('path');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const SR = 250;              // Sample rate (Hz)
const WINDOW_SIZE = 512;     // Samples per analysis window (~2 seconds)
const WINDOW_STEP = 128;     // Step between windows (75% overlap)

// ─── FEATURE EXTRACTION ────────────────────────────────────────────────────

function mean(arr) {
  let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function variance(arr, mu) {
  if (mu === undefined) mu = mean(arr);
  let s = 0; for (let i = 0; i < arr.length; i++) s += (arr[i] - mu) ** 2;
  return s / arr.length;
}

function std(arr, mu) {
  return Math.sqrt(variance(arr, mu));
}

function skewness(arr) {
  const mu = mean(arr);
  const sd = std(arr, mu);
  if (sd === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += ((arr[i] - mu) / sd) ** 3;
  return s / arr.length;
}

function kurtosis(arr) {
  const mu = mean(arr);
  const sd = std(arr, mu);
  if (sd === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += ((arr[i] - mu) / sd) ** 4;
  return (s / arr.length) - 3; // Excess kurtosis
}

function zeroCrossingRate(arr) {
  let count = 0;
  const mu = mean(arr);
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i] - mu) * (arr[i - 1] - mu) < 0) count++;
  }
  return count / (arr.length - 1);
}

function lineLength(arr) {
  let ll = 0;
  for (let i = 1; i < arr.length; i++) ll += Math.abs(arr[i] - arr[i - 1]);
  return ll / (arr.length - 1);
}

function peakToPeak(arr) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < mn) mn = arr[i];
    if (arr[i] > mx) mx = arr[i];
  }
  return mx - mn;
}

// Hjorth Parameters
function hjorthActivity(arr) {
  return variance(arr);
}

function hjorthMobility(arr) {
  // First derivative
  const d1 = new Array(arr.length - 1);
  for (let i = 0; i < d1.length; i++) d1[i] = arr[i + 1] - arr[i];
  const varX = variance(arr);
  const varD1 = variance(d1);
  return varX > 0 ? Math.sqrt(varD1 / varX) : 0;
}

function hjorthComplexity(arr) {
  const d1 = new Array(arr.length - 1);
  for (let i = 0; i < d1.length; i++) d1[i] = arr[i + 1] - arr[i];
  const mobX = hjorthMobility(arr);
  const mobD1 = hjorthMobility(d1);
  return mobX > 0 ? mobD1 / mobX : 0;
}

// ─── FFT (Radix-2 Cooley-Tukey) ────────────────────────────────────────────

function hann(n, N) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
}

function fftRadix2(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

function computePowerSpectrum(signal, sr) {
  // Pad to next power of 2
  let N = 1;
  while (N < signal.length) N <<= 1;
  
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) {
    re[i] = signal[i] * hann(i, signal.length);
  }
  
  fftRadix2(re, im);
  
  const df = sr / N;
  const ny = N / 2;
  const power = new Float64Array(ny + 1);
  const freqs = new Float64Array(ny + 1);
  
  for (let k = 0; k <= ny; k++) {
    power[k] = re[k] * re[k] + im[k] * im[k];
    freqs[k] = k * df;
  }
  
  return { power, freqs, df, ny };
}

function bandPower(power, freqs, fLow, fHigh) {
  let sum = 0;
  for (let k = 0; k < freqs.length; k++) {
    if (freqs[k] >= fLow && freqs[k] < fHigh) sum += power[k];
  }
  return sum;
}

function spectralEntropy(power, freqs, fLow, fHigh) {
  // Normalized Shannon entropy of the power spectrum
  let total = 0;
  const inBand = [];
  for (let k = 0; k < freqs.length; k++) {
    if (freqs[k] >= fLow && freqs[k] < fHigh) {
      inBand.push(power[k]);
      total += power[k];
    }
  }
  if (total === 0 || inBand.length === 0) return 0;
  
  let entropy = 0;
  for (const p of inBand) {
    const pn = p / total;
    if (pn > 0) entropy -= pn * Math.log2(pn);
  }
  return entropy / Math.log2(inBand.length); // Normalize to [0, 1]
}

function spectralEdgeFrequency(power, freqs, percentile = 0.95) {
  let total = 0;
  for (let k = 0; k < power.length; k++) total += power[k];
  
  let cumulative = 0;
  for (let k = 0; k < power.length; k++) {
    cumulative += power[k];
    if (cumulative / total >= percentile) return freqs[k];
  }
  return freqs[freqs.length - 1];
}

// ─── EXTRACT ALL FEATURES FROM A WINDOW ─────────────────────────────────────

function extractFeatures(window, sr) {
  const { power, freqs } = computePowerSpectrum(window, sr);
  
  // Band powers
  const delta = bandPower(power, freqs, 0.5, 4);
  const theta = bandPower(power, freqs, 4, 8);
  const alpha = bandPower(power, freqs, 8, 13);
  const beta  = bandPower(power, freqs, 13, 30);
  const gamma = bandPower(power, freqs, 30, 45);
  const totalPower = delta + theta + alpha + beta + gamma;
  
  const safeDivide = (a, b) => b > 0 ? a / b : 0;
  
  return {
    // Time-domain
    mean: mean(window),
    std: std(window),
    skewness: skewness(window),
    kurtosis: kurtosis(window),
    zeroCrossingRate: zeroCrossingRate(window),
    lineLength: lineLength(window),
    peakToPeak: peakToPeak(window),
    
    // Hjorth
    hjorthActivity: hjorthActivity(window),
    hjorthMobility: hjorthMobility(window),
    hjorthComplexity: hjorthComplexity(window),
    
    // Frequency-domain (relative powers)
    deltaPct: safeDivide(delta, totalPower),
    thetaPct: safeDivide(theta, totalPower),
    alphaPct: safeDivide(alpha, totalPower),
    betaPct: safeDivide(beta, totalPower),
    gammaPct: safeDivide(gamma, totalPower),
    
    // Ratios
    deltaOverBeta: safeDivide(delta, beta),
    thetaOverAlpha: safeDivide(theta, alpha),
    
    // Spectral features
    spectralEntropy: spectralEntropy(power, freqs, 0.5, 45),
    spectralEdgeFreq: spectralEdgeFrequency(power, freqs, 0.95),
    
    // Total power
    totalPower: totalPower,
  };
}

// ─── ANALYZE THE BONN DATASET ───────────────────────────────────────────────

function analyzeDataset() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    NeuroWatch AI — Training on Bonn EEG Dataset        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  // Load the dataset
  const dataPath = path.join(__dirname, 'eeg_data.json');
  if (!fs.existsSync(dataPath)) {
    console.error('Error: eeg_data.json not found. Run: node download_eeg.js');
    process.exit(1);
  }
  
  const dataset = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Dataset: ${dataset.source}`);
  console.log(`Channels: ${dataset.channels.length}`);
  console.log(`Samples/channel: ${dataset.data[0].length}`);
  console.log(`Sample rate: ${dataset.targetSampleRate} Hz\n`);
  
  // Classify channels by their risk category
  // The dataset has channels from different clinical categories
  const categories = {
    normal: [],      // Set A, B (Healthy)
    preictal: [],    // Set C (Hippocampal)
    epileptogenic: [],// Set D (Epileptogenic zone)
  };
  
  // Map channels to categories based on their labels
  for (let i = 0; i < dataset.channels.length; i++) {
    const label = dataset.channels[i].label.toLowerCase();
    const data = dataset.data[i];
    
    if (label.includes('healthy') || label.includes('eyesopen') || label.includes('eyesclosed')) {
      categories.normal.push(data);
    } else if (label.includes('hippocampal')) {
      categories.preictal.push(data);
    } else if (label.includes('epileptogenic')) {
      categories.epileptogenic.push(data);
    }
  }
  
  console.log(`Normal channels: ${categories.normal.length}`);
  console.log(`Pre-ictal channels: ${categories.preictal.length}`);
  console.log(`Epileptogenic channels: ${categories.epileptogenic.length}\n`);
  
  // Extract features from sliding windows for each category
  const categoryFeatures = {};
  
  for (const [catName, channels] of Object.entries(categories)) {
    console.log(`Extracting features from "${catName}"...`);
    const allFeatures = [];
    
    for (const channelData of channels) {
      for (let start = 0; start + WINDOW_SIZE <= channelData.length; start += WINDOW_STEP) {
        const window = channelData.slice(start, start + WINDOW_SIZE);
        const features = extractFeatures(window, SR);
        allFeatures.push(features);
      }
    }
    
    console.log(`  → ${allFeatures.length} windows extracted`);
    categoryFeatures[catName] = allFeatures;
  }
  
  // Compute statistics for each feature in each category
  const featureNames = Object.keys(categoryFeatures.normal[0]);
  const featureStats = {};
  
  console.log('\n─── Feature Statistics ──────────────────────────────────');
  console.log(`${'Feature'.padEnd(22)} ${'Normal'.padEnd(22)} ${'Pre-ictal'.padEnd(22)} ${'Epileptogenic'.padEnd(22)}`);
  console.log('─'.repeat(88));
  
  for (const fname of featureNames) {
    featureStats[fname] = {};
    const row = [fname.padEnd(22)];
    
    for (const catName of ['normal', 'preictal', 'epileptogenic']) {
      const values = categoryFeatures[catName].map(f => f[fname]).filter(v => isFinite(v));
      const mu = mean(values);
      const sd = std(values, mu);
      const sorted = [...values].sort((a, b) => a - b);
      const p5 = sorted[Math.floor(sorted.length * 0.05)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      
      featureStats[fname][catName] = { mean: mu, std: sd, p5, p95 };
      row.push(`${mu.toFixed(3)}±${sd.toFixed(3)}`.padEnd(22));
    }
    
    console.log(row.join(' '));
  }
  
  // ─── BUILD THE MODEL ────────────────────────────────────────────────────
  // 
  // The model uses a weighted scoring system:
  // For each feature, compute how far the current value deviates from
  // the "normal" range and toward the "epileptogenic" range.
  // 
  // Score = weighted sum of feature z-scores (relative to normal baseline)
  // Risk% = sigmoid(score) mapped to 0-100
  
  console.log('\n─── Building Risk Model ────────────────────────────────');
  
  // Calculate discriminative power of each feature
  // Using Cohen's d between normal and epileptogenic
  const featureWeights = {};
  let maxD = 0;
  
  for (const fname of featureNames) {
    const nrm = featureStats[fname].normal;
    const epi = featureStats[fname].epileptogenic;
    
    const pooledStd = Math.sqrt((nrm.std ** 2 + epi.std ** 2) / 2);
    const cohensD = pooledStd > 0 ? Math.abs(epi.mean - nrm.mean) / pooledStd : 0;
    
    featureWeights[fname] = cohensD;
    if (cohensD > maxD) maxD = cohensD;
  }
  
  // Normalize weights to sum to 1
  let totalWeight = 0;
  for (const fname of featureNames) {
    // Apply a minimum threshold — only use features with meaningful discrimination
    if (featureWeights[fname] < 0.1) featureWeights[fname] = 0;
    totalWeight += featureWeights[fname];
  }
  for (const fname of featureNames) {
    featureWeights[fname] = totalWeight > 0 ? featureWeights[fname] / totalWeight : 0;
  }
  
  // Print top features
  const sortedFeatures = featureNames
    .filter(f => featureWeights[f] > 0)
    .sort((a, b) => featureWeights[b] - featureWeights[a]);
  
  console.log('\nTop discriminative features:');
  for (const fname of sortedFeatures) {
    const bar = '█'.repeat(Math.round(featureWeights[fname] * 100));
    console.log(`  ${fname.padEnd(22)} ${(featureWeights[fname] * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
  
  // ─── VALIDATE THE MODEL ──────────────────────────────────────────────────
  
  console.log('\n─── Model Validation ──────────────────────────────────');
  
  function predictRisk(features) {
    let score = 0;
    for (const fname of featureNames) {
      if (featureWeights[fname] === 0) continue;
      
      const nrm = featureStats[fname].normal;
      const epi = featureStats[fname].epileptogenic;
      const val = features[fname];
      
      if (!isFinite(val)) continue;
      
      // How far from normal toward epileptogenic
      const direction = epi.mean > nrm.mean ? 1 : -1;
      const zNormal = nrm.std > 0 ? (val - nrm.mean) / nrm.std : 0;
      
      // Directed z-score (positive = toward risk)
      const directedZ = zNormal * direction;
      
      score += directedZ * featureWeights[fname];
    }
    
    // Sigmoid mapping to 0-100%
    // Calibrate so normal ≈ 5-15%, epileptogenic ≈ 60-80%
    const risk = 100 / (1 + Math.exp(-1.5 * (score - 0.5)));
    return Math.max(0, Math.min(100, risk));
  }
  
  // Test on each category
  for (const catName of ['normal', 'preictal', 'epileptogenic']) {
    const risks = categoryFeatures[catName].map(f => predictRisk(f));
    const avgRisk = mean(risks);
    const sdRisk = std(risks, avgRisk);
    const minRisk = Math.min(...risks);
    const maxRisk = Math.max(...risks);
    
    console.log(`  ${catName.padEnd(16)} Risk: ${avgRisk.toFixed(1)}% ± ${sdRisk.toFixed(1)}%  [${minRisk.toFixed(1)}% - ${maxRisk.toFixed(1)}%]`);
  }
  
  // ─── SAVE THE MODEL ──────────────────────────────────────────────────────
  
  const model = {
    version: '1.0.0',
    name: 'NeuroWatch AI Risk Predictor',
    description: 'EEG-based neurological risk assessment model trained on the Bonn University EEG Dataset',
    dataset: 'Bonn University EEG Dataset (Andrzejak et al., 2001)',
    trainingDate: new Date().toISOString(),
    config: {
      sampleRate: SR,
      windowSize: WINDOW_SIZE,
      featureCount: sortedFeatures.length,
    },
    featureNames: sortedFeatures,
    featureWeights: {},
    featureBaseline: {},  // Normal range
    featureDirection: {}, // +1 = higher = more risk, -1 = lower = more risk
    riskLevels: [
      { threshold: 0,  label: 'NORMAL',   color: '#37d7b5' },
      { threshold: 20, label: 'LOW RISK', color: '#b8d06e' },
      { threshold: 40, label: 'MODERATE', color: '#f5a623' },
      { threshold: 60, label: 'HIGH',     color: '#ff6b6b' },
      { threshold: 80, label: 'CRITICAL', color: '#e74c3c' },
    ],
    sigmoidParams: { scale: 1.5, offset: 0.5 },
  };
  
  for (const fname of sortedFeatures) {
    model.featureWeights[fname] = Math.round(featureWeights[fname] * 10000) / 10000;
    
    const nrm = featureStats[fname].normal;
    const epi = featureStats[fname].epileptogenic;
    
    model.featureBaseline[fname] = {
      mean: Math.round(nrm.mean * 10000) / 10000,
      std: Math.round(nrm.std * 10000) / 10000,
      p5: Math.round(nrm.p5 * 10000) / 10000,
      p95: Math.round(nrm.p95 * 10000) / 10000,
    };
    
    model.featureDirection[fname] = epi.mean > nrm.mean ? 1 : -1;
  }
  
  const modelPath = path.join(__dirname, 'ai_model.json');
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2));
  
  console.log(`\n✓ Model saved to ${modelPath}`);
  console.log(`  Features used: ${sortedFeatures.length}`);
  console.log(`  Model size: ${(fs.statSync(modelPath).size / 1024).toFixed(1)} KB\n`);
  
  return model;
}

// ─── RUN ────────────────────────────────────────────────────────────────────

analyzeDataset();
