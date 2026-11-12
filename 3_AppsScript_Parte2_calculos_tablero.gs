/* =====================================================================================
 *  MONITOREO DEL TANQUE 1 – PARTE 2: CÁLCULOS Y DATOS PARA EL TABLERO
 * =====================================================================================
 *  LO QUE HACE:
 *    - completarLectura(): con cada mensaje del ESP32 calcula el nivel, el volumen,
 *      el % de batería, la coherencia de los sensores, las alarmas y el indicador
 *      experimental de posible fuga.
 *    - datosTablero(): la última lectura, que pide el tablero web (Tablero.html) cada 60 s.
 *
 *  ALARMAS (se envían por correo en la Parte 3):
 *    - Nivel bajo: S3 (10.600 L) deja de detectar agua; la hoja muestra 7.000 L (39 %).
 *    - Falla de sensor: combinación de sensores no coherente (un sensor con agua por
 *      encima de uno seco) o el MCP23017 no responde por I²C.
 *    - Pérdida de comunicación: la revisa la Parte 3 cada 10 min.
 *  El indicador de posible fuga solo se muestra en la hoja y en el tablero; no genera
 *  alarma ni correo, porque no fue posible validarlo.
 * ===================================================================================== */

const FILAS_HISTORIAL = 50000;      // con un envío cada 30 s son unos 17 días

/** Lee las últimas lecturas: [{t, nivel, vol, bat, batv, temp, hum, s:[5], fuga, alarma, ent, mal, vent}] */
function leerLecturas() {
  const h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_LECT);
  if (!h || h.getLastRow() < 2) return [];
  const n = Math.min(FILAS_HISTORIAL, h.getLastRow() - 1);
  return h.getRange(h.getLastRow() - n + 1, 1, n, COLUMNAS.length).getValues()
    .filter(f => f[0] instanceof Date)
    .map(lecturaDeFila)
    .sort((a, b) => a.t - b.t);
}

/** Convierte una fila de "Lecturas" en un objeto. */
function lecturaDeFila(f) {
  const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
  return {
    t: f[0].getTime(), nivel: num(f[C.NIVEL - 1]), vol: num(f[C.VOL - 1]), bat: num(f[C.BAT - 1]),
    batv: num(f[C.BATV - 1]), temp: num(f[C.TEMP - 1]), hum: num(f[C.HUM - 1]),
    s: [0, 1, 2, 3, 4].map(i => num(f[C.S1 - 1 + i])),
    fuga: num(f[C.FUGA - 1]), alarma: num(f[C.ALARMA - 1]), ent: num(f[C.ENTRADA - 1]),
    mal: String(f[C.MAL - 1] || ''), vent: num(f[C.VENT - 1]),
  };
}

/* ---------------------------------------------------------------------------------------
 *  CÁLCULOS. Recibe el mensaje "d" y le agrega: volumen, nivel, bateria, fuga, alarma
 *  y alarmas_activas (qué está mal).
 * --------------------------------------------------------------------------------------- */
function completarLectura(d, fecha, ls) {
  const s = [1, 2, 3, 4, 5].map(i => (Number(d['sensor' + i]) === 1 ? 1 : 0));
  // Volumen: el del sensor más alto con agua, contando desde abajo
  let mojados = 0; while (mojados < 5 && s[mojados] === 1) mojados++;
  const coherente = s.slice(mojados).every(x => x === 0);   // ningún sensor con agua encima de uno seco

  const mcpFalla = Number(d.mcp) === 0;
  if (!mcpFalla) {                                          // sin MCP no hay nivel (se deja vacío)
    d.volumen = mojados ? TANQUE.sensores[mojados - 1] : 0;
    d.nivel = Math.round(d.volumen / TANQUE.capacidad * 100);
  }
  if (d.bateria_v !== undefined) d.bateria = porcentajeBateria(Number(d.bateria_v));

  const mal = [];
  if (mcpFalla || !coherente) mal.push('Falla de sensor');
  else if (s[SENSOR_NIVEL_BAJO - 1] === 0) mal.push('Nivel bajo');      // S3 sin agua

  d.fuga = mcpFalla ? 1 : revisarFuga(ls, fecha.getTime(), Number(d.ingreso_l) || 0, d.volumen);
  d.alarma = mal.length ? 0 : 1;
  d.alarmas_activas = mal.join(', ') || 'Ninguna';
  return d;
}

/** Indicador experimental de posible fuga (1 = sin fuga, 0 = posible fuga). No genera alarma. */
function revisarFuga(ls, ms, ent, vol) {
  const F = CONFIG.FUGA, V = F.VENTANA_H * 3600000;
  if (!ls.length) return 1;
  // Lectura más cercana a una hora (máximo 40 min de diferencia)
  const cerca = obj => {
    let lo = 0, hi = ls.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ls[mid].t < obj) lo = mid + 1; else hi = mid; }
    let mejor = ls[lo];
    if (lo > 0 && Math.abs(ls[lo - 1].t - obj) < Math.abs(mejor.t - obj)) mejor = ls[lo - 1];
    return Math.abs(mejor.t - obj) <= 40 * 60000 ? mejor : null;
  };
  // Consumo entre dos lecturas = agua que entró + lo que bajó el tanque
  const consumo = (a, b) => (a.vol === null || b.vol === null || a.vol === undefined || b.vol === undefined) ? null :
    Math.max(0, ((b.ent || 0) - (a.ent || 0)) + (a.vol - b.vol));

  const v = cerca(ms - V);
  if (!v || v.t >= ms) return 1;
  const horas = (ms - v.t) / 3600000;
  const reciente = consumo(v, { ent: ent, vol: vol });
  if (reciente === null) return 1;
  let base = -1;
  for (let dia = 1; dia <= F.DIAS; dia++) {
    const a = cerca(ms - dia * 86400000 - V), b = cerca(ms - dia * 86400000);
    if (!a || !b || b.t <= a.t || consumo(a, b) === null) continue;
    const c = consumo(a, b) / ((b.t - a.t) / 3600000) * horas;
    if (c > base) base = c;
  }
  if (base < 0) return 1;                                   // todavía no hay un día completo
  const limite = Math.max(F.MIN_L, base * (1 + F.MARGEN / 100));
  const p = PropertiesService.getScriptProperties();
  const sospechas = reciente > limite ? Number(p.getProperty('FUGA_SOSPECHAS') || 0) + 1 : 0;
  p.setProperty('FUGA_SOSPECHAS', String(sospechas));
  return sospechas >= F.CONFIRMAR ? 0 : 1;
}

/** Batería 3S de litio: voltios -> % (estimación con la curva de descarga). */
function porcentajeBateria(v) {
  if (isNaN(v)) return undefined;
  const V = [9.0, 9.9, 10.5, 10.8, 11.1, 11.4, 11.7, 12.0, 12.3, 12.6], P = [0, 2, 6, 12, 25, 45, 65, 80, 90, 100];
  if (v <= V[0]) return 0;
  if (v >= V[9]) return 100;
  let i = 0; while (v > V[i + 1]) i++;
  return Math.round(P[i] + (v - V[i]) / (V[i + 1] - V[i]) * (P[i + 1] - P[i]));
}

/** Límites para los colores del tablero. */
function limites() {
  const volBajo = TANQUE.sensores[SENSOR_NIVEL_BAJO - 1];
  return {
    nivel: Math.round(volBajo / TANQUE.capacidad * 100), nivelAviso: CONFIG.NIVEL_AVISO,
    volumen: volBajo, volumenAviso: Math.round(TANQUE.capacidad * CONFIG.NIVEL_AVISO / 100),
    bateria: CONFIG.BATERIA_MALA, bateriaAviso: CONFIG.BATERIA_AVISO,
    temp: CONFIG.TEMP_MALA, tempAviso: CONFIG.TEMP_AVISO,
  };
}

/** Datos del tablero: la última lectura del tanque. */
function datosTablero() {
  const ls = leerLecturas();
  return {
    lugar: CONFIG.LUGAR, nombre: TANQUE.nombre, capacidad: TANQUE.capacidad, limites: limites(),
    minutosSinReporte: CONFIG.MINUTOS_SIN_REPORTE, ahora: Date.now(),
    ultimo: ls.length ? ls[ls.length - 1] : null,
  };
}
// ===== FIN PARTE 2 =====
