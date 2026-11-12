/* =====================================================================================
 *  MONITOREO DEL TANQUE 1 – PARTE 1: AJUSTES, RECEPCIÓN DE DATOS Y HOJA DE LECTURAS
 * =====================================================================================
 *  ¿CÓMO FUNCIONA?
 *    El ESP32 envía cada 30 s, o al confirmarse un cambio de sensor, el estado filtrado
 *    de los 5 sensores, el voltaje de la batería, la temperatura, la humedad, el
 *    acumulado de pulsos (en litros) y el estado del ventilador.
 *    doPost() revisa la clave, agrega la fecha y la hora, calcula el nivel, el volumen,
 *    el % de batería, la coherencia de los sensores, las alarmas y el indicador de
 *    posible fuga (Parte 2), guarda una fila en "Lecturas" y revisa las alarmas (Parte 3).
 *
 *  HOJAS:
 *    "Lecturas" – una fila por cada mensaje del ESP32.
 *    "Alarmas"  – cada alarma registrada (y enviada por correo, Parte 3).
 *
 *  SE EJECUTA A MANO: configurar() (la primera vez).
 *
 *  Columnas "Fuga" y "Alarma": 1 = bien, 0 = se detecta un problema.
 *  Sensores: 1 = con agua, 0 = sin agua.
 * ===================================================================================== */

const CONFIG = {
  CLAVE: 'ESCRIBIR_LA_CLAVE',   // la MISMA clave que va en el firmware (CLAVE_SHEETS). No publicarla.
  LUGAR: '',                    // nombre del sitio que muestra el tablero (opcional)

  // Colores del tablero y de la hoja (no son alarmas). ROJO = malo, AMARILLO = aviso.
  NIVEL_AVISO: 70,              // nivel %: amarillo por debajo de este valor
  BATERIA_MALA: 40, BATERIA_AVISO: 50,   // batería %
  TEMP_MALA: 40,    TEMP_AVISO: 36,      // caja °C

  // Correos de alarma, separados por coma. Si se deja vacío, llegan al dueño de la hoja.
  CORREOS: '',

  MINUTOS_SIN_REPORTE: 10,      // pérdida de comunicación: sin datos en este tiempo
  ZONA_HORARIA: 'America/Bogota',

  // Indicador experimental de posible fuga (no validado; no genera alarma ni correo):
  // consumo de las últimas 2 h contra las mismas horas de los 7 días anteriores.
  FUGA: { MARGEN: 30, VENTANA_H: 2, DIAS: 7, MIN_L: 3600, CONFIRMAR: 2 },
};

// Tanque 1. capacidad = 100 % · sensores = litros que marca cada sensor, de abajo hacia arriba
const TANQUE = { id: 'T1', nombre: 'Tanque 1', capacidad: 18000, sensores: [3400, 7000, 10600, 14000, 18000] };
const SENSOR_NIVEL_BAJO = 3;    // la alarma de nivel bajo se activa cuando S3 deja de detectar agua

const HOJA_LECT = 'Lecturas';
const HOJA_ALAR = 'Alarmas';
const COLUMNAS = ['Fecha', 'Tanque', 'Nivel %', 'Volumen L', 'Batería %', 'Batería V', 'Temperatura °C', 'Humedad %',
  'Sensor 1', 'Sensor 2', 'Sensor 3', 'Sensor 4', 'Sensor 5',
  'Fuga', 'Alarma', 'Entrada total L', 'Qué está mal', 'Ventilador'];
// Número de columna de cada dato (A = 1)
const C = { FECHA: 1, TANQUE: 2, NIVEL: 3, VOL: 4, BAT: 5, BATV: 6, TEMP: 7, HUM: 8, S1: 9,
  FUGA: 14, ALARMA: 15, ENTRADA: 16, MAL: 17, VENT: 18 };


/** Recibe los datos del ESP32 y los escribe en "Lecturas". */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const d = JSON.parse(e.postData.contents);
    if (String(d.clave) !== CONFIG.CLAVE) return respuesta('clave incorrecta');
    if (String(d.tanque || TANQUE.id).trim().toUpperCase() !== TANQUE.id) return respuesta('tanque desconocido: ' + d.tanque);

    const fecha = new Date();
    const ls = leerLecturas();                     // historial, para el indicador de fuga
    completarLectura(d, fecha, ls);                // Parte 2
    const h = hojaLecturas();
    h.appendRow(filaLectura(d, fecha));

    try { revisarAlarmas(d); } catch (err) { console.error('Alarmas: ' + err.message); }   // Parte 3
    return respuesta('ok');
  } catch (err) {
    return respuesta('error: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

/** Arma la fila de "Lecturas". */
function filaLectura(d, fecha) {
  const num = v => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? '' : Number(v));
  const fila = [fecha, TANQUE.id, num(d.nivel), num(d.volumen), num(d.bateria), num(d.bateria_v),
    num(d.temperatura), num(d.humedad)];
  for (let i = 1; i <= 5; i++) fila.push(num(d['sensor' + i]));
  fila.push(num(d.fuga), num(d.alarma), num(d.ingreso_l), String(d.alarmas_activas || 'Ninguna'), num(d.ventilador));
  return fila;
}

function respuesta(texto) {
  return ContentService.createTextOutput(texto).setMimeType(ContentService.MimeType.TEXT);
}

/** Entrega el tablero web (se abre con el enlace de la aplicación web). */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Tablero')
    .setTitle('Monitoreo del tanque')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Devuelve la hoja "Lecturas" (la crea si no existe). */
function hojaLecturas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName(HOJA_LECT);
  if (!h) {
    h = ss.insertSheet(HOJA_LECT, 0);
    h.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]);
    h.setFrozenRows(1);
  }
  return h;
}


/* ---------------------------------------------------------------------------------------
 *  configurar() – SE EJECUTA A MANO la primera vez.
 *    Da formato a "Lecturas", crea "Alarmas" y programa el reloj que revisa cada 10 min
 *    si el equipo dejó de reportar (alarma de pérdida de comunicación).
 * --------------------------------------------------------------------------------------- */
function configurar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.ZONA_HORARIA);

  // 1. Lecturas: encabezado, formatos de número y colores
  const h = hojaLecturas();
  const filas = h.getMaxRows() - 1;
  h.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS])
    .setFontWeight('bold').setBackground('#005830').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  h.setRowHeight(1, 36);
  h.setFrozenRows(1);
  h.getRange(2, 1, filas, COLUMNAS.length).setHorizontalAlignment('center').setFontFamily('Arial').setFontSize(10);
  h.getRange(2, C.FECHA, filas, 1).setNumberFormat('dd/MM/yyyy h:mm am/pm');
  h.getRange(2, C.NIVEL, filas, 1).setNumberFormat('0');
  h.getRange(2, C.VOL, filas, 1).setNumberFormat('#,##0');
  h.getRange(2, C.BAT, filas, 1).setNumberFormat('0');
  h.getRange(2, C.BATV, filas, 1).setNumberFormat('0.00');
  h.getRange(2, C.TEMP, filas, 1).setNumberFormat('0.0');
  h.getRange(2, C.HUM, filas, 1).setNumberFormat('0');
  h.getRange(2, C.ENTRADA, filas, 1).setNumberFormat('#,##0');
  h.getRange(2, C.MAL, filas, 1).setHorizontalAlignment('left');
  h.setColumnWidth(C.FECHA, 160); h.setColumnWidth(C.MAL, 260);
  [C.TANQUE, C.NIVEL, C.BAT, C.HUM, C.FUGA, C.ALARMA, C.VENT].forEach(c => h.setColumnWidth(c, 80));
  for (let i = 0; i < 5; i++) h.setColumnWidth(C.S1 + i, 75);

  // Colores: VERDE = bien, AMARILLO = aviso, ROJO = malo (iguales a los del tablero)
  const verde = '#c8e6c9', amarillo = '#fff3b0', rojo = '#ffcdd2';
  const rango = (c1, n) => h.getRange(2, c1, filas, n);
  const letra = c => String.fromCharCode(64 + c);
  const regla = (c, n, formula, color) => SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISNUMBER(' + letra(c) + '2),' + formula.split('x').join(letra(c) + '2') + ')')
    .setBackground(color).setRanges([rango(c, n)]).build();
  const volBajo = TANQUE.sensores[SENSOR_NIVEL_BAJO - 1];             // 10.600 L
  const nivelBajo = Math.round(volBajo / TANQUE.capacidad * 100);      // 59 %
  h.setConditionalFormatRules([
    regla(C.S1, 5, 'x=1', verde), regla(C.S1, 5, 'x=0', rojo),
    regla(C.FUGA, 2, 'x=1', verde), regla(C.FUGA, 2, 'x=0', rojo),
    regla(C.NIVEL, 1, 'x<' + nivelBajo, rojo),
    regla(C.NIVEL, 1, 'x<' + CONFIG.NIVEL_AVISO, amarillo),
    regla(C.NIVEL, 1, 'x>=' + CONFIG.NIVEL_AVISO, verde),
    regla(C.VOL, 1, 'x<' + volBajo, rojo),
    regla(C.VOL, 1, 'x<' + Math.round(TANQUE.capacidad * CONFIG.NIVEL_AVISO / 100), amarillo),
    regla(C.VOL, 1, 'x>=' + Math.round(TANQUE.capacidad * CONFIG.NIVEL_AVISO / 100), verde),
    regla(C.BAT, 1, 'x<' + CONFIG.BATERIA_MALA, rojo),
    regla(C.BAT, 1, 'x<' + CONFIG.BATERIA_AVISO, amarillo),
    regla(C.BAT, 1, 'x>=' + CONFIG.BATERIA_AVISO, verde),
    regla(C.TEMP, 1, 'x>' + CONFIG.TEMP_MALA, rojo),
    regla(C.TEMP, 1, 'x>' + CONFIG.TEMP_AVISO, amarillo),
    regla(C.TEMP, 1, 'x<=' + CONFIG.TEMP_AVISO, verde),
    regla(C.VENT, 1, 'x=1', amarillo),
  ]);

  // 2. Alarmas
  hojaAlarmas();

  // 3. Reloj: revisar cada 10 min si el equipo dejó de reportar
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'revisarSinReporte')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('revisarSinReporte').timeBased().everyMinutes(10).create();

  ss.toast('Listo: hojas, formato y revisión de comunicación cada 10 min.', 'Monitoreo del tanque', 8);
}
// ===== FIN PARTE 1 =====
