# Monitoreo del nivel de agua potable en un tanque industrial (IoT)

Código del trabajo de grado **"Prototipo IoT para el monitoreo del nivel de agua potable y generación de alarmas en un tanque de almacenamiento industrial"** – Sofía Albán, 2026.

El sistema mide el nivel del tanque 1 con cinco sensores capacitivos XKC-Y25-V (S1 a S5), leídos por un ESP32 a través de optoacopladores PC817 y un expansor MCP23017. El ESP32 envía los datos por WiFi a una hoja de cálculo de Google (Apps Script), que guarda los registros, calcula nivel y volumen, genera las alarmas por correo y muestra el tablero web.

## Contenido

| Carpeta / archivo | Qué hace |
|---|---|
| `firmware/1_firmware_ESP32.ino` | Programa del ESP32 (Arduino IDE): lee los sensores, la temperatura y humedad (DHT11), la batería y los pulsos, y envía los datos a la hoja. |
| `apps-script/2_AppsScript_Parte1_ajustes.gs` | Configuración, recepción de datos (`doPost`: revisa la clave y guarda cada registro) y publicación del tablero (`doGet`). |
| `apps-script/3_AppsScript_Parte2_calculos_tablero.gs` | Cálculo de nivel, volumen y estado de las alarmas; datos que usa el tablero. |
| `apps-script/4_AppsScript_Parte3_alarmas_correos.gs` | Alarmas por correo: nivel bajo, falla de sensor y pérdida de comunicación. |
| `apps-script/5_Tablero.html` | Tablero web que muestra el estado del tanque. |

## Cómo usarlo

1. Crear una hoja de cálculo de Google y abrir **Extensiones > Apps Script**.
2. Crear un archivo por cada parte (`.gs`) y pegar su contenido; crear un archivo HTML llamado `Tablero` y pegar `5_Tablero.html`.
3. En la Parte 1 escribir una clave propia en `CONFIG.CLAVE` y, si se quiere, los correos en `CONFIG.CORREOS`.
4. Publicar como **aplicación web** (Implementar > Nueva implementación) y copiar la URL.
5. En el firmware escribir la red WiFi, la URL de la aplicación web y la misma clave (`ssid`, `password`, `URL_SHEETS`, `CLAVE_SHEETS`), y cargarlo al ESP32 con Arduino IDE.

Los valores marcados con `********` o `ESCRIBIR_LA_CLAVE` se dejaron vacíos a propósito: no se publican contraseñas, claves ni direcciones reales.
