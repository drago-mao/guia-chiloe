// Almacenamiento en memoria con la misma interfaz que blobKV (solo para pruebas).
export function memoryKV() {
  const stores = {};
  return (name) => {
    const m = (stores[name] = stores[name] || new Map());
    let n = 0;
    return {
      async getJSON(key) { const r = m.get(key); return r && r.json !== undefined ? { data: JSON.parse(r.json), etag: r.etag } : null; },
      async setJSON(key, val, opts = {}) {
        const cur = m.get(key);
        if (opts.onlyIfNew && cur) return { modified: false };
        if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
        const etag = '"' + Math.random().toString(36).slice(2) + (++n) + '"';
        m.set(key, { json: JSON.stringify(val), etag });
        return { modified: true, etag };
      },
      async del(key) { m.delete(key); },
      async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
      async getBin(key) { const r = m.get(key); return r && r.buf ? { buf: r.buf, type: r.type } : null; },
      async setBin(key, buf, type) { m.set(key, { buf: Buffer.from(buf), type }); }
    };
  };
}
