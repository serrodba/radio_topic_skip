// Prueba de la logica sin Volumio: mock de commandRouter (con cola) y worker simulado.
// Ejecutar: node test/test_logic.js
var assert = require('assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var EventEmitter = require('events');
var cp = require('child_process');

cp.spawn = function () {             // worker falso (no lanza Python)
  var e = new EventEmitter();
  e.stdout = new (require('stream').PassThrough)();
  e.stderr = new EventEmitter();
  e.kill = function () {};
  return e;
};
var Plugin = require('../index.js');
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); };

var played = [], toasts = [], queue = [], queueClears = 0;
var state = { status: 'play', service: 'webradio', uri: 'http://a.example/stream' };
var cfgFile = path.join(os.tmpdir(), 'rts_cfg_tmp.json');
fs.writeFileSync(cfgFile, '{}');
var ctx = {
  logger: { info: function () {}, warn: function () {}, error: function () {} },
  configManager: {},
  coreCommand: {
    pluginManager: { getConfigurationFile: function () { return cfgFile; } },
    volumioGetState: function () { return state; },
    volumioGetQueue: function () { return queue; },
    volumioPlay: function (i) {
      played.push(queue[i].uri);
      state = { status: 'play', service: 'webradio', uri: queue[i].uri, title: queue[i].title, position: i };
      return Promise.resolve();
    },
    volumioClearQueue: function () { queueClears++; queue = []; return Promise.resolve(); },
    addQueueItems: function (items) { queue = queue.concat(items); return Promise.resolve(); },
    pushToastMessage: function (t, a, b) { toasts.push(b); }
  }
};

(async function () {
  var p = new Plugin(ctx);
  p.onVolumioStart();
  p.config.set('enabled', true);
  p.config.set('station_source', 'list');
  p.config.set('stations_list', 'A|http://a.example/stream ; B|http://b.example/stream/ ; C|http://c.example/x');
  p.config.set('sensitivity', 'custom');
  p.config.set('detect_secs', 120);
  p.config.set('topic_ratio', 70);

  // 1) Lista y busqueda (barra final y mayusculas ignoradas)
  var st = p.getStations();
  assert.strictEqual(st.length, 3);
  assert.strictEqual(p.indexOfStation(st, 'HTTP://B.example/stream'), 1);

  // 2) Ventana: 7 bloques de 15 s (105 s < 108 s = 90 %) no salta; el 8.o si
  p.window = [];
  for (var i = 0; i < 7; i++) assert.strictEqual(p.evaluate({ secs: 15, topic: true }), false);
  assert.strictEqual(p.evaluate({ secs: 15, topic: true }), true);

  // 3) Mezcla 50 % -> no salta
  p.window = []; var r = false;
  for (i = 0; i < 20; i++) r = p.evaluate({ secs: 15, topic: i % 2 === 0 });
  assert.strictEqual(r, false);

  // 4) 2 min de musica y luego futbol: salta al llegar al 75 % (6/8)
  p.window = [];
  for (i = 0; i < 8; i++) p.evaluate({ secs: 15, topic: false });
  var n = 0; r = false;
  while (!r && n < 20) { r = p.evaluate({ secs: 15, topic: true }); n++; }
  assert.strictEqual(n, 6);

  // 4b) Bloques de tiempo real largos (Pi 3: ~35 s): 4 bloques llenan 120 s
  p.window = []; n = 0; r = false;
  while (!r && n < 10) { r = p.evaluate({ secs: 35, topic: true }); n++; }
  assert.strictEqual(n, 4);

  // 5) Cola vacia: en el primer salto se carga la lista completa; despues se avanza por indice
  p.config.set('detect_secs', 60);
  function feedTopic(k) { for (var j = 0; j < k; j++) p.onWorkerMessage({ type: 'chunk', secs: 15, is_topic: true }, p.workerUri); }
  p.tick(); assert.strictEqual(p.workerUri, 'http://a.example/stream');
  feedTopic(4); await wait();
  assert.deepStrictEqual(played, ['http://b.example/stream/']);
  assert.strictEqual(queue.length, 3, 'cola cargada con la lista');
  p.switching = false; p.tick(); assert.strictEqual(p.workerUri, 'http://b.example/stream/');
  feedTopic(4); await wait(); p.switching = false; p.tick();
  feedTopic(4); await wait();
  assert.deepStrictEqual(played, ['http://b.example/stream/', 'http://c.example/x', 'http://a.example/stream']);
  assert.strictEqual(queueClears, 1, 'la cola solo se carga una vez');

  // 5b) Niveles de sensibilidad: cada nivel usa sus valores e ignora los manuales
  var PRESETS = Plugin.PRESETS;
  ['baja', 'media', 'alta', 'muy_alta'].forEach(function (lvl) {
    p.config.set('sensitivity', lvl);
    var prm = p.params();
    assert.strictEqual(prm.detect, PRESETS[lvl].detect, lvl);
    assert.strictEqual(prm.hits, PRESETS[lvl].hits, lvl);
  });
  // muy_alta: ventana 30 s, umbral 30 % -> 3 bloques de 10 s, basta 1 tematico
  p.config.set('sensitivity', 'muy_alta'); p.window = [];
  assert.strictEqual(p.evaluate({ secs: 10, topic: false }), false);
  assert.strictEqual(p.evaluate({ secs: 10, topic: false }), false);
  assert.strictEqual(p.evaluate({ secs: 10, topic: true }), true);
  // baja: con 90 s de futbol no basta (ventana 180 s)
  p.config.set('sensitivity', 'baja'); p.window = []; r = false;
  for (i = 0; i < 6; i++) r = p.evaluate({ secs: 15, topic: true });
  assert.strictEqual(r, false);
  p.config.set('sensitivity', 'custom');

  // 6) Fuera de lista o pausa: no analiza
  state = { status: 'play', service: 'webradio', uri: 'http://otra/x' }; p.switching = false; p.tick();
  assert.strictEqual(p.workerUri, null);
  state = { status: 'pause', service: 'webradio', uri: 'http://a.example/stream' }; p.tick();
  assert.strictEqual(p.workerUri, null);

  // 7) saveSettings acota valores
  p.saveSettings({ enabled: true, station_source: { value: 'myradios' }, detect_secs: 5, topic_ratio: 500, chunk_secs: 'x', min_hits: 2, pause_secs: -3 });
  assert.strictEqual(p.config.get('detect_secs'), 30);
  assert.strictEqual(p.config.get('topic_ratio'), 100);
  assert.strictEqual(p.config.get('chunk_secs'), 10);
  assert.strictEqual(p.config.get('pause_secs'), 0);
  assert.strictEqual(p.config.get('sensitivity'), 'media', 'sin nivel -> media');
  p.saveSettings({ enabled: true, sensitivity: { value: 'inventado' } });
  assert.strictEqual(p.config.get('sensitivity'), 'media', 'nivel desconocido -> media');
  p.saveSettings({ enabled: true, sensitivity: { value: 'alta' } });
  assert.strictEqual(p.config.get('sensitivity'), 'alta');
  p.config.set('sensitivity', 'custom');

  // 8) Fuente playlist (formato real) + respaldo por nombre; la emisora no esta en la cola
  var tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'pl'));
  fs.writeFileSync(path.join(tmpd, 'Radio1'), JSON.stringify([
   
    { service: 'mpd', title: 'Cancion local', uri: 'music-library/USB/a.mp3' },
 
  ]));
  p.playlistDir = tmpd;
  p.config.set('station_source', 'playlist');
  p.config.set('playlist_name', '../Radio1');   // se sanea
  st = p.getStations();
  assert.strictEqual(st.length, 2);
  p.config.set('detect_secs', 120);
  p.switching = false; played = [];
 
  p.tick(); assert.strictEqual(p.workerUri, st[0].uri);
  feedTopic(8); await wait();
  assert.deepStrictEqual(played, [st[1].uri]);

  // 9) Cola = playlist Radio1 (+ elemento extra): NO se borra, se avanza por indice
  queue = [
    { service: 'webradio', title: 'SER Valencia', uri: st[0].uri },
    { service: 'webradio', title: 'Rock FM', uri: st[1].uri },
    { service: 'mpd', title: 'Otra', uri: 'music-library/x.mp3' }
  ];
  queueClears = 0; played = [];
 
  p.switching = false; p.tick();
  feedTopic(8); await wait();
  assert.deepStrictEqual(played, [st[1].uri]);
  assert.strictEqual(queueClears, 0, 'la cola no se borra');
  assert.strictEqual(queue.length, 3);
  assert.strictEqual(state.position, 1);

  // 10) Desplegable de playlists: orden natural, n.o de radios, guardado desde objeto
  fs.writeFileSync(path.join(tmpd, '55'), '[]');
  fs.writeFileSync(path.join(tmpd, '44'), JSON.stringify([{ service: 'webradio', title: 'X', uri: 'http://x' }]));
  fs.writeFileSync(path.join(tmpd, 'Atica'), 'no es json');
  var pls = p.listPlaylists();
  assert.deepStrictEqual(pls.map(function (o) { return o.value; }), ['44', '55', 'Atica', 'Radio1']);
  assert.strictEqual(pls[0].label, '44 (1 radio)');
  assert.strictEqual(pls[3].label, 'Radio1 (2 radios)');
  assert.strictEqual(pls[2].label, 'Atica (0 radios)');
  p.saveSettings({ enabled: true, station_source: { value: 'playlist' }, playlist_name: { value: '44', label: '44 (1 radio)' } });
  assert.strictEqual(p.config.get('playlist_name'), '44');
  // getUIConfig rellena las opciones (mock de i18nJson y sharedVars)
  ctx.coreCommand.sharedVars = { get: function () { return 'es'; } };
  ctx.coreCommand.i18nJson = function (a, b, ui) {
    var libQ = require('kew'); var d = libQ.defer();
    d.resolve(JSON.parse(fs.readFileSync(ui, 'utf8'))); return d.promise;
  };
  var ui = await new Promise(function (res, rej) { p.getUIConfig().then(res).fail(rej); });
  var el = ui.sections[0].content.filter(function (e) { return e.id === 'playlist_name'; })[0];
  assert.strictEqual(el.element, 'select');
  assert.strictEqual(el.options.length, 4);
  assert.strictEqual(el.value.value, '44');

  fs.rmSync(tmpd, { recursive: true }); fs.unlinkSync(cfgFile);
  console.log('OK - todas las pruebas pasan. Toasts:', toasts.join(' | '));
  process.exit(0);
})().catch(function (e) { console.error(e); process.exit(1); });
