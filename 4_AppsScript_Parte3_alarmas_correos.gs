/* =====================================================================================
 *  MONITOREO DEL TANQUE 1 – PARTE 3: ALARMAS Y CORREOS
 * =====================================================================================
 *  TRES ALARMAS:
 *    - Nivel bajo y falla de sensor: las calcula la Parte 2 con cada mensaje.
 *      revisarAlarmas() envía UN correo cuando aparece una alarma nueva y la anota en
 *      la hoja "Alarmas". Mientras siga activa no se repite el correo.
 *    - Pérdida de comunicación: revisarSinReporte() corre sola cada 10 min. Si no llega
 *      ningún dato en CONFIG.MINUTOS_SIN_REPORTE, envía UN correo por cada interrupción.
 *      Cuando el equipo vuelve a enviar datos, avisa que reporta de nuevo.
 *  La primera vez Google pide permiso para enviar correos: aceptar.
 * ===================================================================================== */

// Qué hacer con cada alarma (aparece en el correo)
const QUE_HACER = {
  'Nivel bajo': 'S3 está sin agua. Revisar la entrada de agua y, si es necesario, solicitar un carrotanque.',
  'Falla de sensor': 'La combinación de sensores no es coherente o el MCP23017 no responde: revisar cables y sensores.',
};

/** Devuelve la hoja "Alarmas" (la crea si no existe). */
function hojaAlarmas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ha = ss.getSheetByName(HOJA_ALAR);
  if (!ha) {
    ha = ss.insertSheet(HOJA_ALAR);
    ha.getRange(1, 1, 1, 3).setValues([['Fecha', 'Tipo', 'Detalle']])
      .setFontWeight('bold').setBackground('#005830').setFontColor('#ffffff');
    ha.setFrozenRows(1);
    ha.setColumnWidth(1, 160); ha.setColumnWidth(2, 160); ha.setColumnWidth(3, 420);
  }
  return ha;
}

function anotarAlarma(tipo, detalle) {
  const ha = hojaAlarmas();
  const fila = ha.getLastRow() + 1;
  ha.getRange(fila, 1, 1, 3).setValues([[new Date(), tipo, detalle]]);
  ha.getRange(fila, 1).setNumberFormat('dd/MM/yyyy h:mm am/pm');
  ha.getRange(fila, 1, 1, 3).setBackground(tipo === 'REPORTA DE NUEVO' ? '#c8e6c9' : '#ffcdd2');
}

/** La llama doPost() con cada mensaje del ESP32. */
function revisarAlarmas(d) {
  const p = PropertiesService.getScriptProperties();

  // Si estaba sin reportar, se anota y se avisa que volvió
  if (p.getProperty('SIN_REPORTE')) {
    p.deleteProperty('SIN_REPORTE');
    anotarAlarma('REPORTA DE NUEVO', TANQUE.nombre + ' volvió a enviar datos.');
    enviarCorreo('📡 ' + TANQUE.nombre + ': volvió a reportar',
      marcoCorreo('📡 ' + TANQUE.nombre + ' volvió a reportar', '<p style="margin:4px 0">El equipo volvió a enviar datos.</p>'),
      TANQUE.nombre + ' volvió a enviar datos.');
  }

  const lista = String(d.alarmas_activas || '').split(',').map(x => x.trim()).filter(x => x && x !== 'Ninguna');
  const antes = JSON.parse(p.getProperty('ALARMAS_AVISADAS') || '[]');
  const nuevas = lista.filter(x => antes.indexOf(x) < 0);
  if (nuevas.length) {
    correoAlarma(d, lista);
    anotarAlarma('ALARMA', lista.join(', '));
  }
  p.setProperty('ALARMAS_AVISADAS', JSON.stringify(lista));      // las que ya no están se olvidan
}

/** Corre sola cada 10 min: avisa si el equipo dejó de reportar. */
function revisarSinReporte() {
  const p = PropertiesService.getScriptProperties();
  const ls = leerLecturas();
  if (!ls.length || p.getProperty('SIN_REPORTE')) return;
  const ult = ls[ls.length - 1].t;
  const minutos = (Date.now() - ult) / 60000;
  if (minutos <= CONFIG.MINUTOS_SIN_REPORTE) return;
  const cuando = Utilities.formatDate(new Date(ult), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy h:mm a');
  const html = marcoCorreo('📡 ' + TANQUE.nombre + ' no está reportando',
    '<p style="margin:4px 0 10px">El último dato llegó el <b>' + cuando + '</b>, hace ' + Math.round(minutos) + ' minutos.</p>' +
    '<p style="margin:4px 0"><b>Revisar:</b></p><ol style="margin:4px 0;padding-left:20px">' +
    '<li>Que la caja tenga energía: batería y panel solar.</li>' +
    '<li>Que el punto de red esté encendido y con señal.</li>' +
    '<li>Si sigue igual, reiniciar el ESP32 con el botón EN.</li></ol>');
  enviarCorreo('📡 ' + TANQUE.nombre + ': no reporta desde ' + cuando, html,
    TANQUE.nombre + ' no reporta desde ' + cuando + '. Revisar energía, red y reiniciar el ESP32.');
  p.setProperty('SIN_REPORTE', '1');
  anotarAlarma('SIN REPORTE', 'Último dato: ' + cuando);
}

/* ---------------------------- Correos ---------------------------- */
function correoAlarma(d, lista) {
  const fila = (k, v, malo) => '<tr><td style="padding:6px 10px;color:#555555">' + k + '</td>' +
    '<td style="padding:6px 10px;font-weight:bold;color:' + (malo ? '#c62828' : '#222222') + '">' + v + '</td></tr>';
  const n = v => (v === undefined || v === null || v === '' ? '-' : v);
  const sensores = [1, 2, 3, 4, 5].map(i => (Number(d['sensor' + i]) === 1 ? 'Con agua' : 'Sin agua')).join(' · ');
  const acciones = lista.filter(x => QUE_HACER[x]).map(x => '<li><b>' + x + ':</b> ' + QUE_HACER[x] + '</li>').join('');
  const cuerpo =
    '<p style="margin:4px 0 8px;font-size:16px"><b style="color:#c62828">' + lista.join(', ') + '</b></p>' +
    '<table cellpadding="0" cellspacing="0" border="0" style="border:1px solid #eeeeee;border-radius:6px">' +
    fila('Nivel', n(d.nivel) + ' %', lista.indexOf('Nivel bajo') >= 0) +
    fila('Volumen', (d.volumen === undefined ? '-' : Number(d.volumen).toLocaleString('es-CO')) + ' L', lista.indexOf('Nivel bajo') >= 0) +
    fila('Batería', n(d.bateria) + ' %', false) +
    fila('Temperatura de la caja', n(d.temperatura) + ' °C', false) +
    fila('Sensores de abajo hacia arriba', sensores, lista.indexOf('Falla de sensor') >= 0) +
    '</table>' +
    (acciones ? '<p style="margin:12px 0 4px"><b>Qué hacer:</b></p><ul style="margin:4px 0;padding-left:20px">' + acciones + '</ul>' : '');
  const texto = 'ALARMA ' + TANQUE.nombre + ': ' + lista.join(', ') + '\nNivel ' + n(d.nivel) +
    ' % · Volumen ' + n(d.volumen) + ' L · Batería ' + n(d.bateria) + ' % · Temperatura ' + n(d.temperatura) + ' °C';
  return enviarCorreo('🔴 Alarma: ' + TANQUE.nombre + ' · ' + lista.join(', '),
    marcoCorreo('🔴 Alarma en ' + TANQUE.nombre, cuerpo), texto);
}

/** Diseño del correo. */
function marcoCorreo(titulo, cuerpo) {
  const enviado = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy h:mm a');
  return '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;font-family:Arial,sans-serif;color:#222222;font-size:14px">' +
    '<tr><td style="background:#005830;color:#ffffff;padding:14px 18px;border-radius:8px 8px 0 0;border-bottom:4px solid #f7e620">' +
    '<div style="font-size:13px;opacity:.85">Monitoreo del tanque' + (CONFIG.LUGAR ? ' · ' + CONFIG.LUGAR : '') + ' · ' + TANQUE.nombre + '</div>' +
    '<div style="font-size:20px;font-weight:bold;margin-top:2px">' + titulo + '</div></td></tr>' +
    '<tr><td style="border:1px solid #dddddd;border-top:0;padding:14px 18px;border-radius:0 0 8px 8px">' + cuerpo +
    '<div style="color:#999999;font-size:12px;margin-top:12px">Enviado: ' + enviado + '</div></td></tr></table>';
}

/** A quién le llegan: CONFIG.CORREOS o, si está vacío, el dueño de la hoja. */
function destinatarios() {
  const valido = x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
  const lista = String(CONFIG.CORREOS || '').split(/[\s,;]+/).filter(valido);
  if (lista.length) return lista.join(', ');
  try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; }
}

function enviarCorreo(asunto, html, texto) {
  const para = destinatarios();
  if (!para) { console.log('No hay a quién enviar el correo.'); return false; }
  try {
    MailApp.sendEmail({ to: para, subject: asunto, body: texto, htmlBody: html, name: 'Monitoreo del tanque' });
    return true;
  } catch (e) {
    console.error('No se pudo enviar el correo: ' + e.message);
    return false;
  }
}
// ===== FIN PARTE 3 =====
