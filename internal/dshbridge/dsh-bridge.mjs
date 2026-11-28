// Embedded Scheme A DeepSeek Harness (DSH) compatibility sidecar for handraw-client.
// Pure Node.js >= 20 ESM, zero external npm dependencies.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const BRIDGE_SECRET = process.env.HANDRAW_BRIDGE_SECRET || '';
const HOST_URL = (process.env.HANDRAW_HOST_URL || '').replace(/\/+$/, '');
const HOST_TOKEN = process.env.HANDRAW_HOST_TOKEN || '';

if (!BRIDGE_SECRET) {
  console.error('[dsh-bridge] missing HANDRAW_BRIDGE_SECRET');
  process.exit(1);
}

// Global runtime state
const loadedPlugins = new Map(); // id -> { id, spec, disposers: [], error: null, loadedAt }
const services = new Map(); // name -> service instance
const injectWaiters = []; // { deps: string[], fn: (ctx)=>void, ctx, called: boolean }
const exactRoutes = new Map(); // pathname -> { pluginId, path, methods, fetch }
const prefixRoutes = []; // { id, pluginId, path, kind: 'webServer'|'fetch', handler, fetch, methods }
let routeSeq = 0;
let cachedDefaultModel = 'site:auto';

function notifyWaiters() {
  for (let i = injectWaiters.length - 1; i >= 0; i--) {
    const w = injectWaiters[i];
    if (w.called) {
      injectWaiters.splice(i, 1);
      continue;
    }
    if (w.deps.every((d) => services.has(d))) {
      w.called = true;
      injectWaiters.splice(i, 1);
      try {
        w.fn(w.ctx);
      } catch (err) {
        console.error('[dsh-bridge] inject callback error:', err?.message || err);
      }
    }
  }
}

async function hostFetch(path, opts = {}) {
  if (!HOST_URL) throw new Error('HANDRAW_HOST_URL 未配置');
  const headers = new Headers(opts.headers || {});
  if (HOST_TOKEN) headers.set('X-Handraw-Token', HOST_TOKEN);
  const res = await fetch(HOST_URL + path, { ...opts, headers });
  return res;
}

async function hostJSON(method, path, body, signal) {
  const headers = {};
  const init = { method, headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await hostFetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `宿主接口调用失败 (${res.status})`), {
      status: res.status,
      code: data?.code,
    });
  }
  return data;
}

async function refreshHostDefaults() {
  try {
    const m = await hostJSON('GET', '/api/host/models?purpose=text');
    if (m?.defaultTextModel) cachedDefaultModel = m.defaultTextModel;
  } catch {
    // Host may still be starting; keep fallback.
  }
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function createCoreServices() {
  // 1. connection service
  services.set('connection', {
    admit() {
      // Go host already enforces session token / cookie authentication before proxying.
      return true;
    },
    requestRejection() {
      return null;
    },
    fetch: {
      register(spec) {
        if (!spec || !spec.path || typeof spec.fetch !== 'function') {
          throw new Error('connection.fetch.register requires { path, fetch }');
        }
        const path = spec.path.startsWith('/') ? spec.path : '/' + spec.path;
        const methods = Array.isArray(spec.methods) && spec.methods.length
          ? spec.methods.map((m) => String(m).toUpperCase())
          : null;
        const entry = {
          id: ++routeSeq,
          pluginId: spec._pluginId || '',
          path,
          methods,
          fetch: spec.fetch,
          kind: 'fetch',
        };
        if (path.endsWith('/*') || path.endsWith('/')) {
          const cleanPrefix = path.replace(/\/\*$/, '').replace(/\/+$/, '');
          entry.path = cleanPrefix || '/';
          prefixRoutes.push(entry);
          prefixRoutes.sort((a, b) => b.path.length - a.path.length);
          return () => {
            const idx = prefixRoutes.findIndex((r) => r.id === entry.id);
            if (idx >= 0) prefixRoutes.splice(idx, 1);
          };
        }
        exactRoutes.set(path, entry);
        return () => {
          if (exactRoutes.get(path)?.id === entry.id) exactRoutes.delete(path);
        };
      },
    },
  });

  // 2. webServer service (for prefix handlers such as dsh-media-desk)
  services.set('webServer', {
    register(spec) {
      if (!spec || !spec.path || typeof spec.handler !== 'function') {
        throw new Error('webServer.register requires { path, handler }');
      }
      const cleanPrefix = (spec.path.startsWith('/') ? spec.path : '/' + spec.path).replace(/\/+$/, '') || '/';
      const entry = {
        id: ++routeSeq,
        pluginId: spec._pluginId || '',
        path: cleanPrefix,
        kind: 'webServer',
        handler: spec.handler,
      };
      prefixRoutes.push(entry);
      prefixRoutes.sort((a, b) => b.path.length - a.path.length);
      return () => {
        const idx = prefixRoutes.findIndex((r) => r.id === entry.id);
        if (idx >= 0) prefixRoutes.splice(idx, 1);
      };
    },
  });

  // 3. agentDefaultModel & llm services backed by Handraw Host Model Gateway
  services.set('agentDefaultModel', {
    currentSelection() {
      return { provider: 'handraw', model: cachedDefaultModel || 'site:auto' };
    },
  });

  services.set('llm', {
    async listModels() {
      const m = await hostJSON('GET', '/api/host/models?purpose=text');
      const items = (m?.text || []).map((x) => ({
        provider: 'handraw',
        id: x.ref,
        model: x.ref,
        label: x.label || x.name || x.ref,
      }));
      return items;
    },
    async prepareCall(opts = {}, prepSignal) {
      const requestedModel = opts?.model && opts.model !== 'default' ? opts.model : cachedDefaultModel;
      return {
        config: { provider: opts?.provider || 'handraw', model: requestedModel, maxTokens: opts?.maxTokens },
        async *stream(callOpts = {}) {
          const signal = callOpts.signal || prepSignal;
          const msgs = [];
          if (typeof callOpts.system === 'string' && callOpts.system.trim()) {
            msgs.push({ role: 'system', content: callOpts.system });
          }
          for (const m of callOpts.messages || []) {
            const text = flattenContent(m?.content);
            if (text) msgs.push({ role: m.role || 'user', content: text });
          }
          try {
            const res = await hostJSON(
              'POST',
              '/api/host/models/chat',
              {
                modelRef: requestedModel || '',
                capability: 'text',
                messages: msgs,
              },
              signal,
            );
            const content = typeof res?.content === 'string' ? res.content : '';
            if (content) {
              yield { type: 'text-delta', text: content };
            }
            yield { type: 'finish', reason: { kind: 'stop' } };
          } catch (err) {
            if (signal?.aborted) {
              yield { type: 'finish', reason: { kind: 'aborted' } };
              return;
            }
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { code: err?.code || 'HOST_ERROR', message: err?.message || String(err) } },
            };
          }
        },
      };
    },
  });

  // 4. directoryPicker service backed by Go/Wails native folder picker
  services.set('directoryPicker', {
    capability() {
      return {
        kind: 'native',
        async pick(signal) {
          const res = await hostJSON('POST', '/api/host/pick-directory', {}, signal);
          return res?.path || null;
        },
      };
    },
  });
}

function createHandrawService(pluginId, pluginDir) {
  return {
    pluginId,
    galleries: {
      async list() {
        const res = await hostJSON('GET', '/api/galleries');
        return res?.galleries || [];
      },
      async items(kind, query = {}) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query || {})) {
          if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
        }
        const suffix = qs.toString() ? '?' + qs.toString() : '';
        return hostJSON('GET', `/api/galleries/${encodeURIComponent(kind)}/items${suffix}`);
      },
      async item(kind, id) {
        const res = await hostJSON('GET', `/api/galleries/${encodeURIComponent(kind)}/items/${encodeURIComponent(id)}`);
        return res?.item || null;
      },
      async imageBytes(kind, id, opts = {}) {
        const qs = new URLSearchParams();
        if (opts && opts.variant) qs.set('variant', String(opts.variant));
        if (opts && opts.size) qs.set('size', String(opts.size));
        const suffix = qs.toString() ? '?' + qs.toString() : '';
        const res = await hostFetch(`/api/galleries/${encodeURIComponent(kind)}/items/${encodeURIComponent(id)}/image${suffix}`);
        if (!res.ok) throw new Error(`读取画廊图片失败 (${res.status})`);
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') || 'application/octet-stream',
        };
      },
      async image(kind, id, opts = {}) {
        return this.imageBytes(kind, id, opts);
      },
      async materialize(kind, id, variant = '') {
        return hostJSON(
          'POST',
          `/api/galleries/${encodeURIComponent(kind)}/items/${encodeURIComponent(id)}/materialize`,
          variant ? { variant: String(variant) } : {}
        );
      },
      async register(reg) {
        return hostJSON('POST', '/api/host/galleries/register', {
          ...reg,
          owner: pluginId,
          imageRoot: reg?.imageRoot || pluginDir,
        });
      },
      async unregister(kind) {
        return hostJSON('DELETE', `/api/host/galleries/${encodeURIComponent(kind)}?owner=${encodeURIComponent(pluginId)}`);
      },
    },
    models: {
      list(purpose = '') {
        const q = purpose ? '?purpose=' + encodeURIComponent(purpose) : '';
        return hostJSON('GET', `/api/host/models${q}`);
      },
      chat(req) {
        return hostJSON('POST', '/api/host/models/chat', req || {});
      },
      quote(req) {
        return hostJSON('POST', '/api/quote', req || {});
      },
      generate(req) {
        return hostJSON('POST', '/api/generate', { mode: 'plugin', ...(req || {}) });
      },
    },
  };
}

function createPluginCtx(pluginId, pluginDir, disposers) {
  const handrawSvc = createHandrawService(pluginId, pluginDir);

  const registerDisposer = (d) => {
    if (typeof d === 'function') disposers.push(d);
    else if (d && typeof d.then === 'function') {
      d.then((fn) => {
        if (typeof fn === 'function') disposers.push(fn);
      }).catch(() => {});
    }
  };

  // Wrap connection & webServer so routes record pluginId and auto-dispose cleanly.
  const baseConn = services.get('connection');
  const scopedConn = {
    admit: baseConn.admit,
    requestRejection: baseConn.requestRejection,
    fetch: {
      register(spec) {
        const off = baseConn.fetch.register({ ...spec, _pluginId: pluginId });
        registerDisposer(off);
        return off;
      },
    },
  };
  const baseWeb = services.get('webServer');
  const scopedWeb = {
    register(spec) {
      const off = baseWeb.register({ ...spec, _pluginId: pluginId });
      registerDisposer(off);
      return off;
    },
  };

  const getService = (name) => {
    if (name === 'connection') return scopedConn;
    if (name === 'webServer') return scopedWeb;
    if (name === 'handraw') return handrawSvc;
    return services.get(name);
  };

  const reflect = {
    get: getService,
    provide(name, value) {
      services.set(name, value);
      registerDisposer(() => {
        if (services.get(name) === value) services.delete(name);
      });
      notifyWaiters();
    },
  };

  const makeLogger = (tag) => {
    const pfx = `[dsh:${tag || pluginId}]`;
    return {
      info: (...a) => console.error(pfx, ...a),
      warn: (...a) => console.error(pfx, 'WARN', ...a),
      error: (...a) => console.error(pfx, 'ERROR', ...a),
      debug: (...a) => console.error(pfx, 'DEBUG', ...a),
      log: (...a) => console.error(pfx, ...a),
    };
  };

  const raw = {
    name: pluginId,
    reflect,
    get: getService,
    logger: makeLogger,
    effect(fn) {
      if (typeof fn !== 'function') return () => {};
      const res = fn();
      registerDisposer(res);
      return typeof res === 'function' ? res : () => {};
    },
    on() {
      return () => {};
    },
    plugin(target, cfg = {}) {
      if (!target) return;
      if (typeof target === 'function') {
        // Class constructor (e.g., Service subclass) vs plain apply function.
        if (target.prototype && Object.getOwnPropertyNames(target.prototype).length > 1) {
          return new target(proxy, cfg);
        }
        return target(proxy, cfg);
      }
      if (typeof target === 'object' && typeof target.apply === 'function') {
        return target.apply(proxy, cfg);
      }
    },
    inject(deps, fn) {
      if (typeof fn !== 'function') return;
      const list = Array.isArray(deps) ? deps : Object.keys(deps || {});
      const ready = list.every((d) => getService(d) !== undefined);
      if (ready) {
        fn(proxy);
      } else {
        injectWaiters.push({ deps: list, fn, ctx: proxy, called: false });
      }
    },
  };

  const proxy = new Proxy(raw, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'string') {
        const svc = getService(prop);
        if (svc !== undefined) return svc;
      }
      return undefined;
    },
  });
  return proxy;
}

async function unloadPlugin(id) {
  const entry = loadedPlugins.get(id);
  if (!entry) return;
  loadedPlugins.delete(id);
  for (let i = entry.disposers.length - 1; i >= 0; i--) {
    try {
      await entry.disposers[i]();
    } catch (err) {
      console.error(`[dsh-bridge] dispose ${id} error:`, err?.message || err);
    }
  }
  // Remove any leftover routes tagged with this pluginId.
  for (const [k, r] of exactRoutes.entries()) {
    if (r.pluginId === id) exactRoutes.delete(k);
  }
  for (let i = prefixRoutes.length - 1; i >= 0; i--) {
    if (prefixRoutes[i].pluginId === id) prefixRoutes.splice(i, 1);
  }
}

async function loadPlugin(spec) {
  const disposers = [];
  const rec = { id: spec.id, spec, disposers, error: null, loadedAt: Date.now() };
  loadedPlugins.set(spec.id, rec);
  if (!spec.hostEntry) {
    return rec;
  }
  try {
    const entryAbs = pathResolve(spec.dir, spec.hostEntry);
    const mod = await import(pathToFileURL(entryAbs).href + `?v=${Date.now()}`);
    const ctx = createPluginCtx(spec.id, spec.dir, disposers);
    const cfg = spec.config || {};
    if (typeof mod.apply === 'function') {
      await mod.apply(ctx, cfg);
    } else if (typeof mod.default === 'function') {
      ctx.plugin(mod.default, cfg);
    } else if (mod.default && typeof mod.default.apply === 'function') {
      await mod.default.apply(ctx, cfg);
    }
  } catch (err) {
    rec.error = err?.message || String(err);
    console.error(`[dsh-bridge] failed to load ${spec.id}:`, err);
  }
  return rec;
}

function currentSummary() {
  const plugins = [];
  for (const [, p] of loadedPlugins) {
    plugins.push({ id: p.id, loaded: !p.error, error: p.error || '' });
  }
  return {
    plugins,
    exactRoutes: Array.from(exactRoutes.keys()),
    prefixRoutes: prefixRoutes.map((r) => r.path),
  };
}

async function readNodeBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function matchPluginRoute(pathname) {
  const exact = exactRoutes.get(pathname);
  if (exact) return exact;
  for (const r of prefixRoutes) {
    if (pathname === r.path || pathname.startsWith(r.path + '/')) return r;
  }
  return null;
}

async function handleBridgeControl(req, res) {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__bridge/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...currentSummary() }));
    return;
  }
  if (url.pathname === '/__bridge/sync' && req.method === 'POST') {
    const raw = await readNodeBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    await refreshHostDefaults();
    const desired = Array.isArray(body.plugins) ? body.plugins : [];
    const desiredIds = new Set(desired.map((p) => p.id));

    // Unload removed/disabled plugins first.
    for (const id of Array.from(loadedPlugins.keys())) {
      if (!desiredIds.has(id)) {
        await unloadPlugin(id);
      }
    }
    // Load newly enabled plugins (or reload if path/entry changed).
    for (const spec of desired) {
      const cur = loadedPlugins.get(spec.id);
      if (cur && cur.spec.dir === spec.dir && cur.spec.hostEntry === spec.hostEntry && !cur.error) {
        continue;
      }
      if (cur) await unloadPlugin(spec.id);
      await loadPlugin(spec);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentSummary()));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unknown bridge endpoint' }));
}

async function handleProxiedRequest(req, res) {
  if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  delete req.headers['x-bridge-secret'];

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const route = matchPluginRoute(url.pathname);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'DSH plugin route not found: ' + url.pathname }));
    return;
  }

  if (route.kind === 'webServer') {
    try {
      await route.handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'plugin error' }));
      }
    }
    return;
  }

  if (route.methods && !route.methods.includes(req.method.toUpperCase())) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  try {
    const ac = new AbortController();
    // IncomingMessage "close" fires as soon as the body is consumed, while the
    // browser is still waiting. Abort only when the response connection drops early.
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else {
        headers.set(k, v);
      }
    }
    const body = await readNodeBody(req);
    const webReq = new Request(url.href, {
      method: req.method,
      headers,
      body,
      signal: ac.signal,
    });
    const webRes = await route.fetch(webReq);
    const outHeaders = {};
    webRes.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'transfer-encoding') return;
      outHeaders[k] = v;
    });
    res.writeHead(webRes.status || 200, outHeaders);
    if (!webRes.body) {
      res.end();
      return;
    }
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(err?.status || 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'plugin handler error' }));
    }
  }
}

createCoreServices();

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/__bridge/')) {
    void handleBridgeControl(req, res);
  } else {
    void handleProxiedRequest(req, res);
  }
});

async function shutdown(code = 0) {
  for (const id of Array.from(loadedPlugins.keys())) {
    await unloadPlugin(id);
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.stdin.resume();
process.stdin.on('end', () => void shutdown(0));

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`READY ${JSON.stringify({ port: addr.port })}\n`);
});
