/* store.js — IndexedDB 缓存：按 文件名+大小+方案 缓存波形金字塔 */
(function (global) {
  'use strict';

  var DB_NAME = 'waveform-cache';
  var STORE = 'pyramids';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(req && req.result); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  global.Store = {
    key: function (file, scheme) { return file.name + ':' + file.size + ':' + scheme; },
    get: function (key) { return tx('readonly', function (s) { return s.get(key); }); },
    set: function (key, val) { return tx('readwrite', function (s) { return s.put(val, key); }); },
    clear: function () { return tx('readwrite', function (s) { return s.clear(); }); }
  };
})(typeof self !== 'undefined' ? self : this);
