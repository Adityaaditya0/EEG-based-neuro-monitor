// =============================================================================
//  NeuroWatch EEG — ESP32-S3 Firmware
//  ADS1299 SPI EEG Reader + WebSocket Streamer
//
//  Hardware:
//    ESP32-S3 DevKit + ADS1299 EEG AFE
//    8 channels: FP1, FP2, F7, F8, O1, O2, Ear-L, Ear-R
//    Reference: FPz   |   Bias: Mastoid
//
//  Protocol:
//    WebSocket client → connects to Node.js relay server on your laptop
//    Sends JSON: {"ts":ms,"ch":[v1..v8],"seq":N}   (µV float values)
//    Path: /esp32   (server uses this to identify the hardware sender)
//
//  Dependencies (install via Arduino Library Manager):
//    - ArduinoWebsockets  by Gil Maimon
//    - ArduinoJson        by Benoit Blanchon
//
//  Board: ESP32S3 Dev Module
//  Partition: Default 4MB with spiffs
// =============================================================================

#include <WiFi.h>
#include <SPI.h>
#include <ArduinoWebsockets.h>
#include <ArduinoJson.h>

using namespace websockets;

// ---------------------------------------------------------------------------
//  CONFIG — Edit these
// ---------------------------------------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* WS_SERVER_IP  = "192.168.1.100";   // IP of your laptop running server.js
const int   WS_PORT       = 8080;
const char* WS_PATH       = "/esp32";           // Server identifies ESP32 by this path

// ---------------------------------------------------------------------------
//  PIN DEFINITIONS — ESP32-S3 SPI to ADS1299
// ---------------------------------------------------------------------------
//  VSPI bus (default SPI on ESP32-S3)
#define PIN_MOSI    11   // MOSI → ADS1299 DIN
#define PIN_MISO    13   // MISO → ADS1299 DOUT
#define PIN_SCK     12   // SCK  → ADS1299 SCLK
#define PIN_CS       10   // CS   → ADS1299 CS (active LOW)
#define PIN_DRDY     9    // DRDY → ADS1299 DRDY (active LOW, data ready interrupt)
#define PIN_RESET    8    // RST  → ADS1299 RESET (active LOW)
#define PIN_START    7    // STA  → ADS1299 START (HIGH = start conversions)
#define PIN_PWDN     6    // PWR  → ADS1299 PWDN  (HIGH = normal, LOW = power down)

// ---------------------------------------------------------------------------
//  ADS1299 REGISTER MAP
// ---------------------------------------------------------------------------
#define ADS_ID          0x00
#define ADS_CONFIG1     0x01
#define ADS_CONFIG2     0x02
#define ADS_CONFIG3     0x03
#define ADS_LOFF        0x04
#define ADS_CH1SET      0x05   // Channel 1 settings
#define ADS_CH2SET      0x06
#define ADS_CH3SET      0x07
#define ADS_CH4SET      0x08
#define ADS_CH5SET      0x09
#define ADS_CH6SET      0x0A
#define ADS_CH7SET      0x0B
#define ADS_CH8SET      0x0C
#define ADS_BIAS_SENSP  0x0D
#define ADS_BIAS_SENSN  0x0E
#define ADS_LOFF_SENSP  0x0F
#define ADS_LOFF_SENSN  0x10
#define ADS_GPIO        0x14
#define ADS_MISC1       0x15
#define ADS_MISC2       0x16
#define ADS_CONFIG4     0x17

// SPI Commands
#define ADS_CMD_WAKEUP  0x02
#define ADS_CMD_STANDBY 0x04
#define ADS_CMD_RESET   0x06
#define ADS_CMD_START   0x08
#define ADS_CMD_STOP    0x0A
#define ADS_CMD_RDATAC  0x10   // Read Data Continuous mode
#define ADS_CMD_SDATAC  0x11   // Stop Read Data Continuous
#define ADS_CMD_RDATA   0x12   // Read single sample
#define ADS_CMD_RREG    0x20   // Read register (OR with address)
#define ADS_CMD_WREG    0x40   // Write register (OR with address)

// Gain settings (CHnSET register bits [6:4])
#define ADS_GAIN_1   0x10   // Gain = 1
#define ADS_GAIN_2   0x20   // Gain = 2
#define ADS_GAIN_4   0x30   // Gain = 4
#define ADS_GAIN_6   0x40   // Gain = 6
#define ADS_GAIN_8   0x50   // Gain = 8
#define ADS_GAIN_12  0x60   // Gain = 12
#define ADS_GAIN_24  0x70   // Gain = 24  ← use this for EEG

// ---------------------------------------------------------------------------
//  SAMPLING RATE CONFIG
// ---------------------------------------------------------------------------
// ADS1299 CONFIG1 register DR[2:0] bits for output data rate:
//   0b110 = 250 SPS  ← use this for 8-channel EEG
//   0b101 = 500 SPS
//   0b100 = 1000 SPS
#define ADS_DR_250SPS   0x96   // CONFIG1: daisy-chain disabled, 250 SPS

// ---------------------------------------------------------------------------
//  CALIBRATION CONSTANT
//  Vref = 4.5V (internal), Gain = 24, 24-bit ADC
//  µV/bit = Vref / (Gain × 2^23) × 1,000,000
// ---------------------------------------------------------------------------
const float UV_PER_BIT = (4.5f / (24.0f * 8388608.0f)) * 1000000.0f;
// = 0.02235 µV per LSB

// ---------------------------------------------------------------------------
//  GLOBALS
// ---------------------------------------------------------------------------
WebsocketsClient wsClient;
SPIClass vspi(VSPI);

volatile bool dataReady = false;
uint32_t sampleCount    = 0;
uint32_t lastReconnect  = 0;
bool     wifiConnected  = false;
bool     wsConnected    = false;

// Raw 3-byte values from ADS1299 per channel (big-endian, 2's complement, 24-bit)
uint8_t  rawBuf[27];  // 3 status bytes + 8 channels × 3 bytes = 27 bytes
float    channelUV[8];

// Channel labels for debug
const char* CH_LABELS[] = {"FP1","FP2","F7","F8","O1","O2","EarL","EarR"};

// ---------------------------------------------------------------------------
//  DRDY INTERRUPT — fires every time ADS1299 has a new sample ready
// ---------------------------------------------------------------------------
void IRAM_ATTR onDRDY() {
  dataReady = true;
}

// ---------------------------------------------------------------------------
//  SPI HELPERS
// ---------------------------------------------------------------------------
void spiBeginTransaction() {
  vspi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE1));
  // ADS1299 uses SPI Mode 1 (CPOL=0, CPHA=1)
  digitalWrite(PIN_CS, LOW);
}

void spiEndTransaction() {
  digitalWrite(PIN_CS, HIGH);
  vspi.endTransaction();
}

void sendCommand(uint8_t cmd) {
  spiBeginTransaction();
  vspi.transfer(cmd);
  spiEndTransaction();
  delayMicroseconds(4);
}

void writeRegister(uint8_t reg, uint8_t val) {
  spiBeginTransaction();
  vspi.transfer(ADS_CMD_WREG | reg);  // WREG | address
  vspi.transfer(0x00);                // Write 1 register (n-1 = 0)
  vspi.transfer(val);
  spiEndTransaction();
  delayMicroseconds(4);
}

uint8_t readRegister(uint8_t reg) {
  spiBeginTransaction();
  vspi.transfer(ADS_CMD_RREG | reg);
  vspi.transfer(0x00);
  uint8_t val = vspi.transfer(0x00);
  spiEndTransaction();
  return val;
}

// ---------------------------------------------------------------------------
//  ADS1299 INIT SEQUENCE
// ---------------------------------------------------------------------------
void initADS1299() {
  Serial.println("[ADS] Initializing ADS1299...");

  // Power-on sequence
  digitalWrite(PIN_PWDN,  HIGH);   // Power on
  digitalWrite(PIN_RESET, HIGH);   // Hold reset HIGH
  delay(1000);                     // Wait for oscillator startup

  // Reset pulse (min 2 CLK cycles, use 10ms)
  digitalWrite(PIN_RESET, LOW);
  delay(10);
  digitalWrite(PIN_RESET, HIGH);
  delay(10);

  // Stop any continuous read that might be running from reset state
  sendCommand(ADS_CMD_SDATAC);
  delay(1);

  // Verify device ID  (should be 0x3E for ADS1299-8)
  uint8_t id = readRegister(ADS_ID);
  Serial.printf("[ADS] Device ID: 0x%02X (expected 0x3E)\n", id);
  if (id != 0x3E) {
    Serial.println("[ADS] WARNING: Unexpected ID — check wiring!");
  }

  // CONFIG1: 250 SPS, daisy-chain disabled
  writeRegister(ADS_CONFIG1, ADS_DR_250SPS);

  // CONFIG2: Internal test signal disabled, internal reference buffer disabled
  writeRegister(ADS_CONFIG2, 0xD0);

  // CONFIG3: Enable internal reference (PD_REFBUF=1), BIAS enabled, buffer on
  //   Bit7=1 (not powerdown), Bit6=1 (ref buf), Bit3=1 (bias buf)
  writeRegister(ADS_CONFIG3, 0xEC);
  delay(150);  // Wait for reference buffer to settle (min 150ms)

  // Channel settings: Gain=24, Normal electrode input, no SRB1
  //   CHnSET: [7]=PD(0=on), [6:4]=GAIN(110=24), [3]=SRB2(0), [2:0]=MUX(000=normal)
  uint8_t chSet = 0x00 | ADS_GAIN_24 | 0x00;  // = 0x60
  for (uint8_t ch = ADS_CH1SET; ch <= ADS_CH8SET; ch++) {
    writeRegister(ch, chSet);
  }

  // BIAS_SENSP / SENSN: route all channels to bias
  writeRegister(ADS_BIAS_SENSP, 0xFF);
  writeRegister(ADS_BIAS_SENSN, 0xFF);

  // CONFIG4: Single-shot mode disabled (continuous), lead-off comparators off
  writeRegister(ADS_CONFIG4, 0x00);

  Serial.println("[ADS] Configuration complete.");

  // Print register verification
  Serial.printf("[ADS] CONFIG1=0x%02X CONFIG2=0x%02X CONFIG3=0x%02X\n",
    readRegister(ADS_CONFIG1),
    readRegister(ADS_CONFIG2),
    readRegister(ADS_CONFIG3));
}

// ---------------------------------------------------------------------------
//  START ADS1299 CONTINUOUS ACQUISITION
// ---------------------------------------------------------------------------
void startAcquisition() {
  sendCommand(ADS_CMD_START);   // Begin conversions
  delayMicroseconds(4);
  sendCommand(ADS_CMD_RDATAC);  // Enter Read Data Continuous mode
  Serial.println("[ADS] Acquisition started — RDATAC mode.");
}

// ---------------------------------------------------------------------------
//  READ ONE SAMPLE (27 bytes: 3 status + 8×3 channel bytes)
//  Called only when DRDY goes LOW (dataReady flag set by ISR)
// ---------------------------------------------------------------------------
void readSample() {
  spiBeginTransaction();
  // In RDATAC mode, clock out 27 bytes on next DRDY falling edge
  for (int i = 0; i < 27; i++) {
    rawBuf[i] = vspi.transfer(0x00);
  }
  spiEndTransaction();

  // Convert 3 status bytes (rawBuf[0..2]) — not used here but available:
  // uint32_t status = ((uint32_t)rawBuf[0]<<16)|((uint32_t)rawBuf[1]<<8)|rawBuf[2];

  // Convert each channel: 3 bytes big-endian → signed 24-bit → float µV
  for (int i = 0; i < 8; i++) {
    int base = 3 + i * 3;
    // Assemble 24-bit signed value
    int32_t raw = ((int32_t)rawBuf[base]   << 16)
                | ((int32_t)rawBuf[base+1] << 8)
                |  (int32_t)rawBuf[base+2];
    // Sign-extend from 24-bit to 32-bit
    if (raw & 0x800000) raw |= 0xFF000000;
    channelUV[i] = (float)raw * UV_PER_BIT;
  }
}

// ---------------------------------------------------------------------------
//  WIFI CONNECTION
// ---------------------------------------------------------------------------
void connectWiFi() {
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] FAILED — running offline");
  }
}

// ---------------------------------------------------------------------------
//  WEBSOCKET CONNECTION
// ---------------------------------------------------------------------------
void connectWebSocket() {
  if (!wifiConnected) return;
  Serial.printf("[WS] Connecting to ws://%s:%d%s\n", WS_SERVER_IP, WS_PORT, WS_PATH);

  wsClient.onMessage([](WebsocketsMessage msg) {
    // Handle server → ESP32 messages (future: config, commands)
    Serial.printf("[WS] Server: %s\n", msg.data().c_str());
  });
  wsClient.onEvent([](WebsocketsEvent event, String data) {
    if (event == WebsocketsEvent::ConnectionOpened) {
      wsConnected = true;
      Serial.println("[WS] Connected to server.");
    } else if (event == WebsocketsEvent::ConnectionClosed) {
      wsConnected = false;
      Serial.println("[WS] Disconnected from server.");
    } else if (event == WebsocketsEvent::GotPing) {
      wsClient.pong();
    }
  });

  String url = String("ws://") + WS_SERVER_IP + ":" + WS_PORT + WS_PATH;
  wsClient.connect(url);
}

// ---------------------------------------------------------------------------
//  BUILD AND SEND JSON PACKET
//  Format: {"ts":1234567,"seq":42,"ch":[v1,v2,...,v8]}
//  Size: ~120 bytes per packet at 250 SPS = ~30 KB/s
// ---------------------------------------------------------------------------
void sendPacket() {
  // Use StaticJsonDocument — no heap allocation, stack-safe on ESP32
  StaticJsonDocument<256> doc;
  doc["ts"]  = (uint32_t)millis();
  doc["seq"] = sampleCount;

  JsonArray ch = doc.createNestedArray("ch");
  for (int i = 0; i < 8; i++) {
    // Round to 3 decimal places to keep packet size tight
    ch.add(roundf(channelUV[i] * 1000.0f) / 1000.0f);
  }

  char buf[256];
  size_t len = serializeJson(doc, buf, sizeof(buf));
  wsClient.send(buf, len);
}

// ---------------------------------------------------------------------------
//  OPTIONAL: TEST SIGNAL MODE
//  Injects internal ADS1299 square wave — useful to verify chain without electrodes
// ---------------------------------------------------------------------------
void enableTestSignal() {
  sendCommand(ADS_CMD_SDATAC);
  // CONFIG2: enable internal test signal, 1 Hz, amplitude = ±(VREF/2.4mV)
  writeRegister(ADS_CONFIG2, 0xD5);
  // Set all channels to test signal input (MUX = 101)
  for (uint8_t ch = ADS_CH1SET; ch <= ADS_CH8SET; ch++) {
    writeRegister(ch, ADS_GAIN_1 | 0x05);  // Gain=1, MUX=101 (test signal)
  }
  sendCommand(ADS_CMD_RDATAC);
  Serial.println("[ADS] TEST SIGNAL MODE — not real EEG data!");
}

// ---------------------------------------------------------------------------
//  SETUP
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== NeuroWatch ESP32-S3 EEG Streamer ===");

  // GPIO init
  pinMode(PIN_CS,    OUTPUT); digitalWrite(PIN_CS,    HIGH);
  pinMode(PIN_RESET, OUTPUT); digitalWrite(PIN_RESET, HIGH);
  pinMode(PIN_START, OUTPUT); digitalWrite(PIN_START, HIGH);
  pinMode(PIN_PWDN,  OUTPUT); digitalWrite(PIN_PWDN,  HIGH);
  pinMode(PIN_DRDY,  INPUT);  // Active LOW, pulled up by ADS1299 internally

  // SPI init (1 MHz — ADS1299 max is 20 MHz but start slow to debug)
  vspi.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS);

  // ADS1299 init
  initADS1299();

  // ------------------------------------------------------------------
  //  UNCOMMENT the line below ONLY for bench testing without electrodes:
  // enableTestSignal();
  // ------------------------------------------------------------------

  // Attach DRDY interrupt (falling edge = new data ready)
  attachInterrupt(digitalPinToInterrupt(PIN_DRDY), onDRDY, FALLING);

  // Start continuous acquisition
  startAcquisition();

  // WiFi + WebSocket
  connectWiFi();
  connectWebSocket();

  Serial.println("[MAIN] Setup complete. Streaming...");
}

// ---------------------------------------------------------------------------
//  LOOP
// ---------------------------------------------------------------------------
void loop() {
  // Poll WebSocket client
  if (wsConnected) {
    wsClient.poll();
  }

  // Auto-reconnect WebSocket if dropped
  if (wifiConnected && !wsConnected) {
    uint32_t now = millis();
    if (now - lastReconnect > 5000) {  // retry every 5 seconds
      lastReconnect = now;
      Serial.println("[WS] Attempting reconnect...");
      connectWebSocket();
    }
  }

  // Process sample if ADS1299 DRDY fired
  if (dataReady) {
    dataReady = false;
    readSample();
    sampleCount++;

    // Send every sample (250 Hz × ~120 bytes = ~30 KB/s, well within WiFi)
    if (wsConnected) {
      sendPacket();
    }

    // Debug: print to Serial every 250 samples (once per second)
    if (sampleCount % 250 == 0) {
      Serial.printf("[EEG] #%u | FP1=%.2f FP2=%.2f F7=%.2f F8=%.2f O1=%.2f O2=%.2f EarL=%.2f EarR=%.2f µV\n",
        sampleCount,
        channelUV[0], channelUV[1], channelUV[2], channelUV[3],
        channelUV[4], channelUV[5], channelUV[6], channelUV[7]);
    }
  }
}

// =============================================================================
//  PIN WIRING SUMMARY
// =============================================================================
//
//  ESP32-S3        ADS1299
//  ─────────────────────────────────────────────
//  GPIO 11  MOSI → DIN     (SPI data to ADS)
//  GPIO 13  MISO → DOUT    (SPI data from ADS)
//  GPIO 12  SCK  → SCLK    (SPI clock)
//  GPIO 10  CS   → CS      (Chip select, active LOW)
//  GPIO  9  DRDY → DRDY    (Data ready, active LOW)
//  GPIO  8  RST  → RESET   (Reset, active LOW)
//  GPIO  7  START→ START   (Start conversions, HIGH)
//  GPIO  6  PWDN → PWDN    (Power down, HIGH=normal)
//  3.3V          → DVDD    (Digital supply)
//  3.3V          → AVDD    (Analog supply — use LDO!)
//  GND           → DGND + AGND (star ground at ADS)
//
//  NOTES:
//  - AVDD must be clean 3.3V from a separate LDO (e.g. AMS1117-3.3)
//    Sharing with ESP32 digital power causes noise in EEG signal.
//  - Add 100nF + 10µF decoupling caps on AVDD as close to ADS1299 as possible.
//  - Electrode cable shield → AGND (not DGND)
//  - Bias electrode → BIASOUT pin of ADS1299
//  - Reference electrode (FPz) → SRB2 pin (if SRB2 routing enabled) or REFN
//
// =============================================================================
