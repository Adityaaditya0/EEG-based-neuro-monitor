/**
 * Download Bonn University EEG Dataset and convert to JSON for dashboard
 * Source: https://www.ukbonn.de/epileptologie/arbeitsgruppen/ag-lehnertz-neurophysik/downloads/
 * 
 * Downloads 5 sets (A-E), picks 8 different recordings for 8 channels,
 * resamples from 173.61 Hz to 250 Hz, and saves as eeg_data.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const TEMP_DIR = path.join(DATA_DIR, 'temp_eeg');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Bonn dataset ZIP URLs — each set has 100 text files with 4096 samples
const SETS = {
  A: 'https://www.ukbonn.de/site/assets/files/21874/z.zip',  // Healthy, eyes open
  B: 'https://www.ukbonn.de/site/assets/files/21872/o.zip',  // Healthy, eyes closed
  C: 'https://www.ukbonn.de/site/assets/files/21871/n.zip',  // Epilepsy, hippocampal
  D: 'https://www.ukbonn.de/site/assets/files/21870/f.zip',  // Epilepsy, epileptogenic zone
  E: 'https://www.ukbonn.de/site/assets/files/21875/s.zip',  // Seizure activity
};

// Map 8 channels to different dataset files for variety
// Using different sets and file indices for each channel
const CHANNEL_MAP = [
  { set: 'A', file: 'Z001.txt', label: 'FP1 (Healthy/EyesOpen)' },
  { set: 'A', file: 'Z023.txt', label: 'FP2 (Healthy/EyesOpen)' },
  { set: 'B', file: 'O005.txt', label: 'F7 (Healthy/EyesClosed)' },
  { set: 'B', file: 'O018.txt', label: 'F8 (Healthy/EyesClosed)' },
  { set: 'C', file: 'N012.txt', label: 'O1 (Hippocampal)' },
  { set: 'C', file: 'N034.txt', label: 'O2 (Hippocampal)' },
  { set: 'D', file: 'F007.txt', label: 'Ear-L (Epileptogenic)' },
  { set: 'D', file: 'F042.txt', label: 'Ear-R (Epileptogenic)' },
];

const ORIG_SR = 173.61;  // Original sample rate
const TARGET_SR = 250;   // Dashboard sample rate

function download(url) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function downloadAndExtract(setName, url) {
  const zipPath = path.join(TEMP_DIR, `${setName}.zip`);
  const extractDir = path.join(TEMP_DIR, setName);
  
  if (fs.existsSync(extractDir) && fs.readdirSync(extractDir).length > 0) {
    console.log(`  Set ${setName}: Already downloaded`);
    return extractDir;
  }

  console.log(`  Set ${setName}: Downloading from ${url}...`);
  const buffer = await download(url);
  fs.writeFileSync(zipPath, buffer);
  console.log(`  Set ${setName}: Downloaded ${(buffer.length / 1024).toFixed(0)} KB`);

  // Extract using PowerShell
  if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
  try {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'pipe' });
    console.log(`  Set ${setName}: Extracted`);
  } catch (e) {
    console.error(`  Set ${setName}: Extract failed: ${e.message}`);
  }
  
  return extractDir;
}

function findFile(dir, filename) {
  // Search recursively for the file
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

function readEEGFile(filepath) {
  const text = fs.readFileSync(filepath, 'utf-8');
  const values = text.trim().split(/\r?\n/).map(line => parseFloat(line.trim())).filter(v => !isNaN(v));
  return values;
}

function resample(data, fromRate, toRate) {
  const ratio = toRate / fromRate;
  const newLen = Math.floor(data.length * ratio);
  const result = new Array(newLen);
  
  for (let i = 0; i < newLen; i++) {
    const srcIdx = i / ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, data.length - 1);
    const frac = srcIdx - lo;
    result[i] = data[lo] * (1 - frac) + data[hi] * frac;
  }
  return result;
}

async function main() {
  console.log('\n=== Bonn EEG Dataset Downloader ===\n');
  console.log('Source: University of Bonn, Dept. of Epileptology');
  console.log('Ref: Andrzejak et al. (2001), Phys. Rev. E, 64, 061907\n');

  // Determine which sets we need
  const neededSets = new Set(CHANNEL_MAP.map(c => c.set));
  
  // Download needed sets
  console.log('Step 1: Downloading datasets...');
  const extractDirs = {};
  for (const setName of neededSets) {
    extractDirs[setName] = await downloadAndExtract(setName, SETS[setName]);
  }

  // Read and process each channel
  console.log('\nStep 2: Reading EEG files...');
  const channels = [];
  
  for (let i = 0; i < CHANNEL_MAP.length; i++) {
    const { set, file, label } = CHANNEL_MAP[i];
    const dir = extractDirs[set];
    
    // Find the file (may be in a subdirectory)
    const filepath = findFile(dir, file);
    if (!filepath) {
      // Try without leading letter — some files might be numbered differently
      const altFile = file.replace(/^[A-Z]/, '');
      const altPath = findFile(dir, altFile);
      if (!altPath) {
        console.error(`  ✗ Channel ${i} (${label}): File ${file} not found in ${dir}`);
        // Use first available file as fallback
        const allFiles = [];
        function listTxt(d) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) listTxt(path.join(d, e.name));
            else if (e.name.endsWith('.txt') || e.name.endsWith('.TXT')) allFiles.push(path.join(d, e.name));
          }
        }
        listTxt(dir);
        if (allFiles.length > i) {
          console.log(`  → Using fallback: ${path.basename(allFiles[i])}`);
          const data = readEEGFile(allFiles[i]);
          channels.push({ label, originalFile: path.basename(allFiles[i]), samples: data });
        } else {
          console.error(`  ✗ No fallback available`);
          channels.push({ label, originalFile: 'N/A', samples: new Array(4096).fill(0) });
        }
        continue;
      }
      const data = readEEGFile(altPath);
      console.log(`  ✓ Channel ${i} (${label}): ${data.length} samples from ${path.basename(altPath)}`);
      channels.push({ label, originalFile: path.basename(altPath), samples: data });
      continue;
    }
    
    const data = readEEGFile(filepath);
    console.log(`  ✓ Channel ${i} (${label}): ${data.length} samples from ${file}`);
    channels.push({ label, originalFile: file, samples: data });
  }

  // Resample from 173.61 Hz to 250 Hz
  console.log('\nStep 3: Resampling from 173.61 Hz to 250 Hz...');
  const resampledChannels = channels.map((ch, i) => {
    const resampled = resample(ch.samples, ORIG_SR, TARGET_SR);
    console.log(`  Channel ${i} (${ch.label}): ${ch.samples.length} → ${resampled.length} samples`);
    return {
      ...ch,
      samples: resampled.map(v => Math.round(v * 100) / 100), // Round to 2 decimal places
    };
  });

  // Save as JSON
  console.log('\nStep 4: Saving eeg_data.json...');
  const output = {
    source: 'Bonn University EEG Dataset',
    reference: 'Andrzejak RG, Lehnertz K, Rieke C, Mormann F, David P, Elger CE (2001), Phys. Rev. E, 64, 061907',
    url: 'https://www.ukbonn.de/epileptologie/arbeitsgruppen/ag-lehnertz-neurophysik/downloads/',
    originalSampleRate: ORIG_SR,
    targetSampleRate: TARGET_SR,
    channels: resampledChannels.map(ch => ({
      label: ch.label,
      originalFile: ch.originalFile,
      sampleCount: ch.samples.length,
    })),
    data: resampledChannels.map(ch => ch.samples),
  };

  const jsonPath = path.join(__dirname, 'eeg_data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(output));
  const sizeMB = (fs.statSync(jsonPath).size / 1024 / 1024).toFixed(2);
  console.log(`  ✓ Saved to ${jsonPath} (${sizeMB} MB)`);

  // Summary
  console.log('\n=== Done! ===');
  console.log(`Channels: ${resampledChannels.length}`);
  console.log(`Samples per channel: ${resampledChannels[0].samples.length}`);
  console.log(`Duration: ${(resampledChannels[0].samples.length / TARGET_SR).toFixed(1)} seconds`);
  console.log(`Sample rate: ${TARGET_SR} Hz\n`);

  // Cleanup
  console.log('Cleaning up temp files...');
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
  console.log('Done.\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
