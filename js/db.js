/* IndexedDB 缓存：按 文件指纹+方案 存储已生成的峰值金字塔 */
(function () {
  'use strict';

  const DB_NAME = 'waveform-thumb';
  const STORE = 'pyramids';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
    return dbPromise;
  }

  async function get(key) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('缓存读取失败', e);
      return null;
    }
  }

  async function set(key, value) {
    try {
      const db = await open();
      await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return true;
    } catch (e) {
      console.warn('缓存写入失败（可能是空间不足）', e);
      return false;
    }
  }

  async function clear() {
    try {
      const db = await open();
      await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  window.WaveDB = { get, set, clear };
})();
