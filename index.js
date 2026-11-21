'use strict';
/*
 * radio_topic_skip - Plugin para Volumio 3.x
 * Mientras suena una emisora de la lista, analiza lo que se dice (Vosk, offline)
 * y si durante un tiempo configurable predomina la tematica (p. ej. futbol),
 * salta a la siguiente emisora de la lista, de forma ciclica.
 *
 * Autor: Sergio Rodriguez Ballester, Ingeniero Tecnico Topografo
 */

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var spawn = require('child_process').spawn;
var readline = require('readline');

var MY_WEB_RADIO = '/data/favourites/my-web-radio';
var PLAYLIST_DIR = '/data/playlist';
var POLL_MS = 3000;
var RESTART_DELAY_MS = 30000;

/*
 * Niveles de sensibilidad (pensados para una Pi 3; con una Pi 4 tambien sirven).
 *   chunk  = segundos de audio por bloque
 *   detect = ventana de deteccion (s de reloj)
 *   ratio  = % de la ventana que debe ser tematico
 *   hits   = puntuacion minima por bloque
 */
var PRESETS = {
  baja:     { label: '1 · Baja (solo partidos claros)',   chunk: 15, detect: 180, ratio: 70, hits: 3 },
  media:    { label: '2 · Media (recomendada)',           chunk: 10, detect: 90,  ratio: 50, hits: 2.5 },
  alta:     { label: '3 · Alta',                          chunk: 10, detect: 60,  ratio: 40, hits: 2 },
  muy_alta: { label: '4 · Muy alta (salta con poco)',     chunk: 10, detect: 30,  ratio: 30, hits: 1.5 },
  custom:   { label: 'Personalizada' }
};

module.exports = RadioTopicSkip;
module.exports.PRESETS = PRESETS;

function RadioTopicSkip(context) {
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;
  this.configManager = this.context.configManager;

  this.worker = null;          // proceso Python
  this.workerUri = null;       // emisora que analiza el worker
  this.window = [];            // [{ts, secs, topic}]
  this.pollTimer = null;
  this.restartTimer = null;
  this.switching = false;
  this.playlistDir = PLAYLIST_DIR;
  this.myWebRadio = MY_WEB_RADIO;
}

/* ---------------------------------------------------------------- ciclo de vida */

RadioTopicSkip.prototype.onVolumioStart = function () {
  var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  return libQ.resolve();
};

RadioTopicSkip.prototype.onStart = function () {
  var self = this;
  self.log('info', 'Arrancando');
  self.pollTimer = setInterval(function () { self.tick(); }, POLL_MS);
  return libQ.resolve();
};

RadioTopicSkip.prototype.onStop = function () {
  if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  this.stopWorker();
  return libQ.resolve();
};

RadioTopicSkip.prototype.onRestart = function () {};

RadioTopicSkip.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

/* ---------------------------------------------------------------- utilidades */

RadioTopicSkip.prototype.log = function (level, msg) {
  this.logger[level]('[radio_topic_skip] ' + msg);
};

RadioTopicSkip.prototype.cfg = function (key, def) {
  var v = this.config.get(key);
  return (v === undefined || v === null || v === '') ? def : v;
};

function normUri(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

/* Parametros efectivos segun el nivel de sensibilidad (o los manuales si es 'custom') */
RadioTopicSkip.prototype.params = function () {
  var lvl = this.cfg('sensitivity', 'media');
  var pr = PRESETS[lvl];
  if (pr && lvl !== 'custom') {
    return { chunk: pr.chunk, detect: pr.detect, ratio: pr.ratio, hits: pr.hits };
  }
  return {
    chunk: Number(this.cfg('chunk_secs', 10)),
    detect: Number(this.cfg('detect_secs', 90)),
    ratio: Number(this.cfg('topic_ratio', 50)),
    hits: Number(this.cfg('min_hits', 2.5))
  };
};

/* Playlists disponibles en Volumio: [{value, label}] con el n.o de radios web */
RadioTopicSkip.prototype.listPlaylists = function () {
  var self = this;
  var names = [];
  try {
    names = fs.readdirSync(self.playlistDir).filter(function (n) {
      try { return fs.statSync(path.join(self.playlistDir, n)).isFile(); } catch (e) { return false; }
    });
  } catch (e) {
    self.log('warn', 'No se pudo leer ' + self.playlistDir + ': ' + e.message);
  }
  names.sort(function (a, b) { return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }); });
  return names.map(function (n) {
    var radios = 0;
    try {
      radios = fs.readJsonSync(path.join(self.playlistDir, n)).filter(function (r) {
        return r && r.uri && (!r.service || r.service === 'webradio');
      }).length;
    } catch (e) { /* playlist ilegible: se muestra con 0 */ }
    return { value: n, label: n + ' (' + radios + (radios === 1 ? ' radio' : ' radios') + ')' };
  });
};

/* Lista de emisoras: [{name, uri}] */
RadioTopicSkip.prototype.getStations = function () {
  var source = this.cfg('station_source', 'myradios');
  var list = [];
  if (source === 'myradios' || source === 'playlist') {
    var file = this.myWebRadio;
    if (source === 'playlist') {
      var pl = String(this.cfg('playlist_name', 'Radio1')).replace(/[\/\\]/g, '').replace(/^\.+/, '');
      file = path.join(this.playlistDir, pl);
    }
    try {
      var data = fs.readJsonSync(file);
      data.forEach(function (r) {
        if (r && r.uri && (!r.service || r.service === 'webradio')) {
          list.push({ name: r.title || r.name || r.uri, uri: r.uri });
        }
      });
    } catch (e) {
      this.log('warn', 'No se pudo leer ' + file + ': ' + e.message);
    }
  } else {
    // Formato: Nombre|URL ; Nombre|URL ; ...
    String(this.cfg('stations_list', '')).split(';').forEach(function (item) {
      var parts = item.split('|');
      if (parts.length >= 2 && parts[1].trim()) {
        list.push({ name: parts[0].trim(), uri: parts.slice(1).join('|').trim() });
      }
    });
  }
  return list;
};

RadioTopicSkip.prototype.indexOfStation = function (list, uri) {
  var n = normUri(uri);
  for (var i = 0; i < list.length; i++) {
    if (normUri(list[i].uri) === n) return i;
  }
  return -1;
};

RadioTopicSkip.prototype.indexOfStationByName = function (list, state) {
  var cands = [state.title, state.artist, state.album, state.name].map(function (x) {
    return String(x || '').trim().toLowerCase();
  }).filter(Boolean);
  for (var i = 0; i < list.length; i++) {
    if (cands.indexOf(String(list[i].name).trim().toLowerCase()) >= 0) return i;
  }
  return -1;
};

/* ---------------------------------------------------------------- bucle principal */

RadioTopicSkip.prototype.tick = function () {
  var self = this;
  if (!self.cfg('enabled', false) || self.switching) {
    if (!self.cfg('enabled', false)) self.stopWorker();
    return;
  }
  var state;
  try {
    state = self.commandRouter.volumioGetState();
  } catch (e) {
    return;
  }
  var playing = state && state.status === 'play' && state.service === 'webradio';
  var stations = self.getStations();
  var idx = playing ? self.indexOfStation(stations, state.uri) : -1;
  if (playing && idx < 0) {
    // Respaldo: Volumio puede mostrar otra URI (p. ej. la .pls ya resuelta).
    idx = self.indexOfStationByName(stations, state);
    if (idx < 0 && self.cfg('debug', false) && state.uri !== self.lastUnknownUri) {
      self.lastUnknownUri = state.uri;
      self.log('info', 'Emisora no encontrada en la lista. uri=' + state.uri + ' title=' + state.title + ' artist=' + state.artist);
    }
  }

  if (idx < 0) {
    // No suena una emisora de la lista: no hacemos nada
    self.stopWorker();
    return;
  }
  if (normUri(stations[idx].uri) !== normUri(self.workerUri)) {
    self.startWorker(stations[idx].uri);
  }
};

/* ---------------------------------------------------------------- worker Python */

RadioTopicSkip.prototype.startWorker = function (uri) {
  var self = this;
  self.stopWorker();
  self.window = [];
  self.workerUri = uri;

  var script = path.join(__dirname, 'worker', 'topic_worker.py');
  var args = [
    script,
    '--url', uri,
    '--model', path.join(__dirname, 'model'),
    '--keywords', self.cfg('keywords_file', path.join(__dirname, 'worker', 'keywords_futbol.txt')),
    '--chunk', String(self.params().chunk),
    '--min-hits', String(self.params().hits),
    '--pause', String(self.cfg('pause_secs', 0))
  ];
  self.log('info', 'Analizando ' + uri);
  var proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  self.worker = proc;

  readline.createInterface({ input: proc.stdout }).on('line', function (line) {
    var msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    self.onWorkerMessage(msg, uri);
  });
  proc.stderr.on('data', function (d) {
    self.log('warn', 'worker: ' + String(d).trim().slice(0, 300));
  });
  proc.on('exit', function (code) {
    if (self.worker !== proc) return;   // ya se paro a proposito
    self.worker = null;
    self.workerUri = null;
    self.log('warn', 'Worker terminado (codigo ' + code + '). Reintento en ' + RESTART_DELAY_MS / 1000 + ' s');
    // Bloquea el reinicio inmediato desde tick() durante el retardo
    self.switching = true;
    self.restartTimer = setTimeout(function () { self.switching = false; }, RESTART_DELAY_MS);
  });
};

RadioTopicSkip.prototype.stopWorker = function () {
  if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; this.switching = false; }
  if (this.worker) {
    var p = this.worker;
    this.worker = null;
    try { p.kill('SIGTERM'); } catch (e) { /* nada */ }
  }
  this.workerUri = null;
  this.window = [];
};

RadioTopicSkip.prototype.onWorkerMessage = function (msg, uri) {
  if (msg.type === 'error') { this.log('error', 'worker: ' + msg.msg); return; }
  if (msg.type !== 'chunk' || normUri(uri) !== normUri(this.workerUri)) return;

  if (this.cfg('debug', false)) {
    this.log('info', 'bloque ' + Math.round(msg.secs) + ' s (audio ' + msg.audio_secs + ' s, proceso ' + msg.proc_secs + ' s), puntos=' + msg.hits +
      ' tematico=' + msg.is_topic + ' [' + (msg.matched || []).join(', ') + ']');
  }
  var decision = this.evaluate({ ts: Date.now(), secs: msg.secs, topic: !!msg.is_topic });
  if (decision) this.skipToNext(uri);
};

/*
 * Ventana deslizante: se guardan los bloques de los ultimos `detect_secs`.
 * Se salta cuando la ventana esta llena (>= 90 % del tiempo cubierto)
 * y el porcentaje de tiempo tematico >= topic_ratio.
 * Funcion pura respecto a la ventana: facil de probar.
 */
RadioTopicSkip.prototype.evaluate = function (block) {
  var prm = this.params();
  var detect = prm.detect;
  var ratio = prm.ratio / 100;
  this.window.push(block);

  // Recorta por la cola hasta que la suma de segundos no exceda la ventana
  var total = this.window.reduce(function (a, b) { return a + b.secs; }, 0);
  while (this.window.length > 1 && total - this.window[0].secs >= detect) {
    total -= this.window.shift().secs;
  }
  var topicSecs = this.window.reduce(function (a, b) { return a + (b.topic ? b.secs : 0); }, 0);
  this.lastStats = { covered: total, topicSecs: topicSecs };
  return total >= detect * 0.9 && total > 0 && topicSecs / total >= ratio;
};

/* ---------------------------------------------------------------- cambio de emisora */

RadioTopicSkip.prototype.skipToNext = function (currentUri) {
  var self = this;
  var stations = self.getStations();
  var idx = self.indexOfStation(stations, currentUri);
  if (stations.length < 2 || idx < 0) {
    self.log('warn', 'Tematica detectada pero no hay otra emisora a la que saltar');
    self.window = [];
    return;
  }
  var next = stations[(idx + 1) % stations.length];
  self.log('info', 'Tematica detectada en ' + stations[idx].name + ' -> ' + next.name);
  self.commandRouter.pushToastMessage('info', 'Cambio de emisora',
    stations[idx].name + ' → ' + next.name);

  self.switching = true;
  self.stopWorker();
  self.switching = true;   // stopWorker lo pone a false; lo mantenemos durante el cambio
  self.playStation(next, stations).fin(function () {
    // Damos unos segundos a que el estado de Volumio se actualice
    setTimeout(function () { self.switching = false; }, 5000);
  });
};

function toQueueItem(station) {
  return {
    service: 'webradio',
    type: 'webradio',
    title: station.name,
    name: station.name,
    uri: station.uri,
    albumart: '/albumart?sourceicon=music_service/webradio/icon.png'
  };
}

/*
 * Avanza a `station` SIN borrar la cola:
 *  1) Si la emisora ya esta en la cola (p. ej. se lanzo la playlist Radio1),
 *     se reproduce esa posicion de la cola.
 *  2) Si no esta, se carga en la cola la lista completa de emisoras
 *     (en su orden) y se reproduce la posicion de la siguiente.
 */
RadioTopicSkip.prototype.playStation = function (station, stations) {
  var self = this;
  var cr = self.commandRouter;
  return libQ.resolve()
    .then(function () { return cr.volumioGetQueue(); })
    .then(function (queue) {
      queue = queue || [];
      for (var i = 0; i < queue.length; i++) {
        if (queue[i] && normUri(queue[i].uri) === normUri(station.uri)) {
          self.log('info', 'Avanzando a la posicion ' + (i + 1) + ' de la cola');
          return cr.volumioPlay(i);
        }
      }
      stations = stations || [station];
      var idx = Math.max(0, self.indexOfStation(stations, station.uri));
      self.log('info', 'La emisora no esta en la cola: se carga la lista completa (' + stations.length + ')');
      return libQ.resolve()
        .then(function () { return cr.volumioClearQueue(); })
        .then(function () { return cr.addQueueItems(stations.map(toQueueItem)); })
        .then(function () { return cr.volumioPlay(idx); });
    })
    .fail(function (e) {
      self.log('error', 'No se pudo reproducir ' + station.uri + ': ' + (e && e.message));
    });
};

/* ---------------------------------------------------------------- interfaz de ajustes */

RadioTopicSkip.prototype.getUIConfig = function () {
  var self = this;
  var defer = libQ.defer();
  var lang = self.commandRouter.sharedVars.get('language_code');
  self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + lang + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then(function (uiconf) {
    var c = uiconf.sections[0].content;
    var set = function (id, val) {
      for (var i = 0; i < c.length; i++) if (c[i].id === id) c[i].value = val;
    };
    var src = self.cfg('station_source', 'myradios');
    set('enabled', !!self.cfg('enabled', false));
    var srcLabels = { myradios: 'Mis radios web', playlist: 'Playlist de Volumio', list: 'Lista manual' };
    set('station_source', { value: src, label: srcLabels[src] || src });
    set('stations_list', self.cfg('stations_list', ''));
    var lvl = self.cfg('sensitivity', 'media');
    set('sensitivity', { value: lvl, label: (PRESETS[lvl] || PRESETS.media).label });
    set('detect_secs', self.cfg('detect_secs', 90));
    set('topic_ratio', self.cfg('topic_ratio', 50));
    set('chunk_secs', self.cfg('chunk_secs', 10));
    set('min_hits', self.cfg('min_hits', 2.5));
    // Desplegable con las playlists existentes
    var pls = self.listPlaylists();
    var cur = self.cfg('playlist_name', 'Radio1');
    var curOpt = null;
    pls.forEach(function (o) { if (o.value === cur) curOpt = o; });
    if (!curOpt) {                         // la guardada ya no existe: se muestra igualmente
      curOpt = { value: cur, label: cur + ' (no encontrada)' };
      pls.unshift(curOpt);
    }
    for (var k = 0; k < c.length; k++) {
      if (c[k].id === 'playlist_name') { c[k].options = pls; c[k].value = curOpt; }
    }
    set('pause_secs', self.cfg('pause_secs', 0));
    set('keywords_file', self.cfg('keywords_file', path.join(__dirname, 'worker', 'keywords_futbol.txt')));
    set('debug', !!self.cfg('debug', false));
    defer.resolve(uiconf);
  }).fail(function (e) {
    self.log('error', 'getUIConfig: ' + e);
    defer.reject(new Error());
  });
  return defer.promise;
};

RadioTopicSkip.prototype.saveSettings = function (data) {
  var self = this;
  var num = function (v, def, min, max) {
    var n = Number(v);
    if (isNaN(n)) n = def;
    return Math.min(max, Math.max(min, n));
  };
  self.config.set('enabled', !!data.enabled);
  self.config.set('station_source', (data.station_source && data.station_source.value) || 'myradios');
  self.config.set('stations_list', String(data.stations_list || ''));
  var lvl = (data.sensitivity && data.sensitivity.value) || 'media';
  self.config.set('sensitivity', PRESETS[lvl] ? lvl : 'media');
  self.config.set('detect_secs', num(data.detect_secs, 90, 30, 3600));
  self.config.set('topic_ratio', num(data.topic_ratio, 50, 10, 100));
  self.config.set('chunk_secs', num(data.chunk_secs, 10, 5, 60));
  self.config.set('min_hits', num(data.min_hits, 2.5, 0.5, 50));
  var pl = data.playlist_name;
  if (pl && typeof pl === 'object') pl = pl.value;     // viene del desplegable
  self.config.set('playlist_name', String(pl || 'Radio1').trim());
  self.config.set('pause_secs', num(data.pause_secs, 0, 0, 300));
  self.config.set('keywords_file', String(data.keywords_file || ''));
  self.config.set('debug', !!data.debug);

  self.stopWorker();   // se relanza en el siguiente tick con los nuevos ajustes
  self.commandRouter.pushToastMessage('success', 'Salto por temática', 'Ajustes guardados');
  return libQ.resolve();
};
