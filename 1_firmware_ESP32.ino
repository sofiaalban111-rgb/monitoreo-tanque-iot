// =====================================================================
//  MONITOR DE TANQUE - ESP32 clásica + MCP23017 + DHT11
//  SOLO LEE, FILTRA Y ENVÍA a Google Sheets. Los cálculos (nivel, volumen, % de batería,
//  coherencia de sensores, alarmas e indicador de fuga) los hace el script de la hoja.
//
//  Librerías: "Adafruit MCP23017 Arduino Library" y "DHT sensor library" (Adafruit)
//  Placa: "ESP32 Dev Module" · Monitor serie: 115200
//
//  ENVÍA cada 30 s, o al confirmarse un cambio de sensor durante 10 s: clave, tanque,
//  sensor1..5 (1 = agua, 0 = seco, ya filtrados), bateria_v (voltios), temperatura,
//  humedad, ingreso_l (acumulado de pulsos en litros) y ventilador (1 = encendido).
//  Si el MCP23017 no responde por I2C, agrega "mcp":0 (la hoja lo marca como falla de sensor).
// =====================================================================
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Preferences.h>
#include <Adafruit_MCP23X17.h>
#include <DHT.h>
 
// ======================= CONFIGURACIÓN =======================
const char* TANQUE_ID = "T1";                    // igual que en TANQUES de la Parte 1
 
const char* ssid     = "********";
const char* password = "********";
 
const char* URL_SHEETS   = "https://script.google.com/macros/s/********/exec";
const char* CLAVE_SHEETS = "********";          // la MISMA de CONFIG.CLAVE en la Parte 1
 
const float MINUTOS_ENVIO    = 0.5;   // 0.5 = cada 30 segundos
const int   SEG_CAMBIO_ENVIO = 10;    // si los sensores cambian y se mantiene 10 s, envía de una vez
 
const int   PIN_SENSOR[5]    = { 2, 3, 4, 5, 6 };   // GPA de cada sensor, de ABAJO hacia ARRIBA
const float FACTOR_BATERIA   = 5.27;  // calibrado con el multímetro (nuevo = actual x multímetro / monitor)
const float LITROS_POR_PULSO = 1000.0;// 1 pulso = 1 m3
 
const float VENT_ENCENDER = 36.0;     // ventilador: se prende desde 36 °C
const float VENT_APAGAR   = 34.0;     // y se apaga bajo 34 °C
// =============================================================
 
#define PIN_PULSOS     25
#define PIN_DHT        4
#define PIN_VOLTAJE    34
#define PIN_VENTILADOR 26
#define DHTTYPE        DHT11
 
Adafruit_MCP23X17 mcp;
DHT dht(PIN_DHT, DHTTYPE);
Preferences memoria;
bool mcpOk = false;
bool ventilador = false;
unsigned long litrosTotal = 0;          // se guarda aunque se vaya la luz
 
// ---------------- Pulsos ----------------
volatile unsigned long pulsosNuevos = 0;
volatile unsigned long ultimoPulsoMs = 0;
void IRAM_ATTR contarPulso() {
  unsigned long t = millis();
  if (t - ultimoPulsoMs > 200) { pulsosNuevos++; ultimoPulsoMs = t; }   // antirrebote
}
 
// ---------------- Sensores ----------------
bool iniciarMCP() {
  if (!mcp.begin_I2C(0x20)) return false;
  for (int i = 0; i < 5; i++) mcp.pinMode(PIN_SENSOR[i], INPUT_PULLUP);
  return true;
}
 
// Una sola lectura, sin filtro (bit en 1 = agua)
uint8_t leerCrudo() {
  uint8_t gpa = mcp.readGPIOA(), r = 0;
  for (int i = 0; i < 5; i++) if (((gpa >> PIN_SENSOR[i]) & 1) == 0) r |= (1 << i);   // LOW = agua
  return r;
}
 
// FILTRO: 3 grupos de 20 muestras; cada sensor queda como diga la mayoría (2 de 3 grupos)
uint8_t leerFiltrado() {
  int votos[5] = {0};
  for (int g = 0; g < 3; g++) {
    int conAgua[5] = {0};
    for (int k = 0; k < 20; k++) {
      uint8_t c = leerCrudo();
      for (int i = 0; i < 5; i++) if (c & (1 << i)) conAgua[i]++;
      delay(40);
    }
    for (int i = 0; i < 5; i++) if (conAgua[i] > 10) votos[i]++;
    if (g < 2) delay(300);
  }
  uint8_t r = 0;
  for (int i = 0; i < 5; i++) if (votos[i] >= 2) r |= (1 << i);
  return r;
}
 
String bits(uint8_t b) { String s = ""; for (int i = 0; i < 5; i++) s += (b & (1 << i)) ? "1" : "0"; return s; }
 
// ---------------- WiFi y envío ----------------
bool probarDNS() {
  IPAddress ip;
  bool ok = WiFi.hostByName("script.google.com", ip);
  Serial.printf("DNS Google: %s\n", ok ? ip.toString().c_str() : "FALLA");
  return ok;
}
 
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                // sin ahorro de energía del WiFi (con él los envíos fallan)
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);
  Serial.print("Conectando a WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  if (WiFi.status() != WL_CONNECTED) { Serial.println(" NO conectó"); return; }
  Serial.printf(" OK (IP %s, señal %d dBm)\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  if (!probarDNS()) {                  // el DNS del computador no responde: usar el de Google
    WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1));
    delay(500);
    probarDNS();
  }
}
 
void reconectarWiFi() {
  Serial.println("Envío falló: reconectando el WiFi...");
  WiFi.disconnect(true);
  delay(1000);
  conectarWiFi();
}
 
bool enviarSheets(const String& json) {
  WiFiClientSecure cliente;
  cliente.setInsecure();
  HTTPClient http;
  http.begin(cliente, URL_SHEETS);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(20000);
  int code = http.POST(json);
  http.end();
  bool ok = (code == 200 || code == 302);   // 302 = Google ya guardó el dato
  Serial.printf("-> Google Sheets: %d %s\n", code, ok ? "(guardado)" : "(falló)");
  return ok;
}
 
// ---------------- Medir y enviar ----------------
uint8_t ultimoFiltrado = 0xFF;          // lo último que se envió (0xFF = nada todavía)
 
void medirYEnviar() {
  Serial.println("\n----------------------------------------");
 
  // Pulsos
  noInterrupts(); unsigned long p = pulsosNuevos; pulsosNuevos = 0; interrupts();
  if (p > 0) { litrosTotal += p * LITROS_POR_PULSO; memoria.begin("tanque", false); memoria.putULong("litros", litrosTotal); memoria.end(); }
 
  // Sensores
  if (!mcpOk) mcpOk = iniciarMCP();
  uint8_t crudo = mcpOk ? leerCrudo() : 0;
  uint8_t filtrado = mcpOk ? leerFiltrado() : 0;
  ultimoFiltrado = filtrado;
 
  // Batería (voltios)
  long suma = 0;
  for (int i = 0; i < 32; i++) { suma += analogRead(PIN_VOLTAJE); delay(2); }
  float voltaje = (suma / 32.0 / 4095.0) * 3.3 * FACTOR_BATERIA;
 
  // Temperatura y humedad
  float temperatura = NAN, humedad = NAN;
  for (int i = 0; i < 3 && isnan(temperatura); i++) {
    temperatura = dht.readTemperature();
    humedad = dht.readHumidity();
    if (isnan(temperatura)) delay(1200);
  }
 
  // Ventilador (si no hay lectura de temperatura, se prende por seguridad)
  if (isnan(temperatura) || temperatura >= VENT_ENCENDER) ventilador = true;
  else if (temperatura <= VENT_APAGAR) ventilador = false;
  digitalWrite(PIN_VENTILADOR, ventilador ? HIGH : LOW);
 
  // Monitor serie
  Serial.printf("MCP: %s\n", mcpOk ? "OK" : "NO responde");
  for (int i = 4; i >= 0; i--) Serial.printf("Sensor %d (GPA%d): %s\n", i + 1, PIN_SENSOR[i], (filtrado & (1 << i)) ? "con agua" : "sin agua");
  Serial.printf("Sensores sin filtro: %s\n", bits(crudo).c_str());
  Serial.printf("Voltaje bateria: %.2f V\n", voltaje);
  Serial.printf("Temperatura caja: %.1f C\n", temperatura);
  Serial.printf("Humedad caja: %.0f %%\n", humedad);
  Serial.printf("Ventilador: %s\n", ventilador ? "encendido" : "apagado");
  Serial.printf("Agua que ha entrado: %lu L\n", litrosTotal);
 
  // Mensaje
  String j = "{\"clave\":\"" + String(CLAVE_SHEETS) + "\",\"tanque\":\"" + String(TANQUE_ID) + "\"";
  for (int i = 0; i < 5; i++) j += ",\"sensor" + String(i + 1) + "\":" + String((filtrado >> i) & 1);
  j += ",\"bateria_v\":" + String(voltaje, 2);
  if (!isnan(temperatura)) j += ",\"temperatura\":" + String(temperatura, 1);
  if (!isnan(humedad))     j += ",\"humedad\":" + String(humedad, 0);
  j += ",\"ingreso_l\":" + String(litrosTotal) + ",\"ventilador\":" + String(ventilador ? 1 : 0);
  if (!mcpOk) j += ",\"mcp\":0";
  j += "}";
 
  conectarWiFi();
  if (WiFi.status() == WL_CONNECTED && !enviarSheets(j)) {   // falló: reconecta y reintenta una vez
    reconectarWiFi();
    if (WiFi.status() == WL_CONNECTED) enviarSheets(j);
  }
}
 
// ---------------- Programa principal ----------------
unsigned long ultimoEnvio = 0, ultimoCrudo = 0, desdeCambio = 0;
 
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("\n=== MONITOREO DE TANQUE %s ===\n", TANQUE_ID);
  pinMode(PIN_VENTILADOR, OUTPUT);
  digitalWrite(PIN_VENTILADOR, LOW);
  pinMode(PIN_PULSOS, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_PULSOS), contarPulso, FALLING);
  memoria.begin("tanque", true); litrosTotal = memoria.getULong("litros", 0); memoria.end();
  Wire.begin(21, 22);
  Wire.setClock(100000);
  mcpOk = iniciarMCP();
  dht.begin();
  conectarWiFi();
  delay(1500);                        // el DHT11 necesita ~2 s al encender
  medirYEnviar();
  ultimoEnvio = millis();
}
 
void loop() {
  // Cada segundo revisa los sensores: si cambiaron y se mantiene, envía de una vez
  if (mcpOk && millis() - ultimoCrudo >= 1000) {
    ultimoCrudo = millis();
    if (leerCrudo() != ultimoFiltrado) { if (!desdeCambio) desdeCambio = millis(); }
    else desdeCambio = 0;
  }
  if (desdeCambio && millis() - desdeCambio >= SEG_CAMBIO_ENVIO * 1000UL && millis() - ultimoEnvio >= 15000UL) {
    Serial.println("\nCambio en los sensores: enviando de una vez");
    desdeCambio = 0;
    ultimoEnvio = millis();
    medirYEnviar();
  }
  if (millis() - ultimoEnvio >= (unsigned long)(MINUTOS_ENVIO * 60000.0)) {
    ultimoEnvio = millis();
    medirYEnviar();
  }
  delay(20);
}
