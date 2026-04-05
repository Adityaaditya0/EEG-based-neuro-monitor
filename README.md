# NeuroWatch EEG System — Setup Guide

## What Are We Doing?
NeuroWatch EEG System is a comprehensive clinical dashboard for real-time electroencephalogram (EEG) monitoring and post-session analysis. The system consists of:
- **Hardware Integration**: Streams real-time 8-channel EEG data from an ADS1299 chip via an ESP32 microcontroller over WebSockets.
- **Node.js Relay Server**: Bridges the hardware data stream to multiple browser clients concurrently, securely storing patient credentials and session data in MongoDB Atlas.
- **Clinical Dashboard**: A beautifully designed, medical-grade web interface to register patients, view live multichannel brainwaves (using HTML5 Canvas), and manage recorded sessions.
- **Post-Session AI Analysis**: Provides an advanced analysis pipeline where recorded `.csv` data is structured, generating power spectral density (PSD) charts, Brain AI abnormality predictions, and clinical timeline risk assessments.

## Files
```
eeg_streamer/
├── eeg_streamer.ino   ← ESP32-S3 Arduino firmware
├── server.js          ← Node.js WebSocket relay server
├── dashboard.html     ← Browser real-time EEG dashboard
├── package.json       ← Node.js dependencies
└── README.md          ← This file
```

---

## Step 1 — Node.js Server Setup (your laptop)

```bash
npm install
npm start
```

On Windows, `npm start` will also open the dashboard automatically in your default browser.

Server starts on port 8080. Find your laptop's LAN IP:
- Windows: `ipconfig` → IPv4 Address
- macOS/Linux: `ifconfig` → inet (en0 or wlan0)

Example: `192.168.1.100`

Open browser: `http://192.168.1.100:8080`

Tip: Opening `dashboard.html` directly (file://) also works, but the recommended path is via the server URL above so the WebSocket host matches automatically.

---

## Step 2 — Arduino Libraries (install via Library Manager)

Search and install:
1. **ArduinoWebsockets** by Gil Maimon (v0.5.4+)
2. **ArduinoJson** by Benoit Blanchon (v6.x)

Board: **ESP32S3 Dev Module**

---

## Step 3 — ESP32 Firmware Config

Edit these 3 lines in `eeg_streamer.ino`:

```cpp
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* WS_SERVER_IP  = "192.168.1.100";  // Your laptop IP
```

Flash via Arduino IDE → Upload.

Open Serial Monitor (115200 baud) — you should see:
```
=== NeuroWatch ESP32-S3 EEG Streamer ===
[ADS] Device ID: 0x3E (expected 0x3E)
[WiFi] Connected! IP: 192.168.1.101
[WS] Connected to server.
[ADS] Acquisition started — RDATAC mode.
[EEG] #250 | FP1=12.34 FP2=-8.21 ...
```

---

## Step 4 — ADS1299 Wiring

| ESP32-S3 GPIO | ADS1299 Pin | Function         |
|:---:|:---:|:---|
| GPIO 11 | DIN   | MOSI (SPI data to ADS) |
| GPIO 13 | DOUT  | MISO (SPI data from ADS) |
| GPIO 12 | SCLK  | SPI clock |
| GPIO 10 | CS    | Chip select (active LOW) |
| GPIO  9 | DRDY  | Data ready (active LOW) |
| GPIO  8 | RESET | Reset (active LOW) |
| GPIO  7 | START | Start conversions (HIGH) |
| GPIO  6 | PWDN  | Power down (HIGH = normal) |
| 3.3V    | DVDD  | Digital supply |
| 3.3V    | AVDD  | Analog supply (use separate LDO!) |
| GND     | DGND + AGND | Star ground |

### Critical Power Notes
- **AVDD must be a separate, clean 3.3V LDO** (e.g. AMS1117-3.3, MCP1700)
  - Never power AVDD from ESP32's onboard 3.3V rail (noise will ruin EEG)
- Place 100nF + 10µF decoupling caps on AVDD, as close to ADS1299 as possible
- Shield electrode cables → connect shield to AGND (not DGND)
- Bias electrode → BIASOUT pin of ADS1299
- Reference electrode (FPz) → SRB2 pin

---

## Step 5 — Bench Testing Without Electrodes

To verify your entire pipeline is working before attaching electrodes, uncomment this line in `setup()`:

```cpp
// enableTestSignal();
```

This injects ADS1299's internal square wave into all channels.
You should see square waves in the dashboard — confirms SPI, WiFi, WebSocket, and browser all work.

Comment it out again before using real electrodes.

---

## Data Flow

```
ADS1299
  │  SPI @ 1MHz, 250 SPS
  ▼
ESP32-S3   → builds JSON: {"ts":12345,"seq":1,"ch":[v1..v8]}
  │  WebSocket ws://SERVER:8080/esp32
  ▼
server.js  → validates, enriches (adds "srv" timestamp), broadcasts
  │  WebSocket ws://SERVER:8080  (to all browser tabs)
  ▼
dashboard.html → ring buffer → canvas scrolling traces → µV readout
```

---

## JSON Packet Format

ESP32 → Server:
```json
{"ts": 12345678, "seq": 1042, "ch": [12.34, -8.21, 5.67, -2.10, 18.90, -14.55, 3.22, -1.08]}
```

Server → Browser (enriched):
```json
{"ts": 12345678, "seq": 1042, "ch": [...], "srv": 1711890000234}
```

Status message (Server → Browser, every 2s):
```json
{"type":"status","esp32":true,"browsers":2,"packets":15423,"sampleRate":250,"uptime":62}
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Device ID: 0x00` | Check SPI wiring. Try lowering SPI speed to 500kHz |
| `Device ID: 0xFF` | CS pin issue — check GPIO 10 |
| All channels = 0 | START pin not HIGH, or RDATAC not sent |
| Huge noise, 200µV+ | AVDD shared with ESP32, fix power supply |
| WebSocket won't connect | Check laptop firewall allows port 8080 |
| Browser shows 0 Hz | ESP32 disconnected from server |
| No data after electrodes | Check impedance < 10kΩ, apply conductive gel |

---

## Next Phase — AI Detection (Phase 2)

Replace `estimateBandPower()` in dashboard.html with a real FFT:
1. Collect 256 samples from ring buffer
2. Apply Hann window
3. Run FFT (use `fft.js` library)
4. Sum energy in band bins → delta, theta, alpha, beta, gamma
5. Feed band powers into seizure/stress classifier

---

## Electrode Layout

```
        FP1    FP2
       (Frontal lobe)

  F7               F8
  (Left temporal)  (Right temporal)

         [head]

  O1               O2
  (Left occipital) (Right occipital)

 EarL              EarR
 (Left ear)        (Right ear)

Reference: FPz (forehead center)
Bias:      Mastoid (behind ear)
```
