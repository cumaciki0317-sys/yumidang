// Production TSX hooks and the actual browser session adapter; synthetic browser/network only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
const appRoot = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(appRoot, 'package.json'))('typescript');
const uid = '11111111-1111-4111-8111-111111111111';
const verified = (status = 'ready') => ({
  userId: uid,
  accessToken: 'synthetic-token',
  status,
  returnTo: '/post?eventId=fixture'
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return {
    promise,
    resolve,
    reject
  };
};
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const words = value => Array.isArray(value) ? value.map(words).join('') : typeof value === 'string' ? value : value && typeof value === 'object' ? words(value.props?.children) : '';
function harness({
  platform = 'web',
  configured = true,
  mode = 'service'
} = {}) {
  const modules = new Map(),
    components = [],
    routes = [];
  let current,
    dirty = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    // Auth screens import the form module; this suite never mounts its UX providers.
    createContext(value) { return { current: value, Provider: "ContextProvider" }; },
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...props,
          children
        }
      };
    },
    useRef(initial) {
      const i = current.cursor++;
      return current.slots[i] ??= {
        current: initial
      };
    },
    useState(initial) {
      const c = current,
        i = c.cursor++;
      if (!(i in c.slots)) c.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [c.slots[i], next => {
        const v = typeof next === 'function' ? next(c.slots[i]) : next;
        if (!Object.is(c.slots[i], v)) {
          c.slots[i] = v;
          dirty = true;
        }
      }];
    },
    useEffect(create, deps) {
      const c = current,
        i = c.cursor++,
        prev = c.slots[i];
      if (!prev || !same(prev.deps, deps)) c.pending.push(() => {
        prev?.cleanup?.();
        const v = {
          create,
          deps
        };
        c.slots[i] = v;
        v.cleanup = create();
      });
    },
    useCallback(fn, deps) {
      const i = current.cursor++,
        prev = current.slots[i];
      if (!prev || !same(prev.deps, deps)) current.slots[i] = {
        fn,
        deps
      };
      return current.slots[i].fn;
    },
    useSyncExternalStore(subscribe, get) {
      if (!current) return get();
      React.useEffect(() => subscribe(() => dirty = true), [subscribe]);
      return get();
    }
  };
  const storage = new Map();
  const browser = {
    location: {
      origin: 'https://app.example.test',
      href: 'https://app.example.test/auth-callback?state=' + 'a'.repeat(64) + '&code=fixture',
      assign() {}
    },
    history: {
      replaceState(_a, _b, url) {
        browser.location.href = browser.location.origin + url;
      }
    },
    sessionStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: k => storage.delete(k)
    },
    crypto: webcrypto
  };
  const env = {
    EXPO_PUBLIC_DATA_MODE: mode,
    ...(configured ? {
      EXPO_PUBLIC_SERVICE_API_URL: 'https://project.example.test/functions/v1/service-api'
    } : {})
  };
  const context = {
    console,
    URL,
    Date,
    Intl,
    AbortController,
    DOMException,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Response,
    Headers,
    Request,
    fetch,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    atob,
    btoa,
    window: browser,
    process: {
      env
    }
  };
  const visual = new Set(['./state', '../state', './ui', '../ui', './screens/RemoteScreens', './screens/CommunityScreens', './RemoteScreens', './CommunityScreens']);
  const ui = new Proxy({
    colors: {},
    art: {}
  }, {
    get: (t, k) => t[k] ?? String(k)
  });
  function load(file) {
    file = path.resolve(file);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const found = ['.ts', '.tsx'].map(s => file + s).find(p => existsSync(p));
      if (!found) {
        const e = new Error('Missing ' + file);
        e.code = 'ENOENT';
        throw e;
      }
      file = found;
    }
    if (modules.has(file)) return modules.get(file).exports;
    const module = {
      exports: {}
    };
    modules.set(file, module);
    let source = readFileSync(file, 'utf8');
    if (process.env.AUTH_CONNECTION_BASELINE === '1') {
      try {
        source = execFileSync('git', ['show', '522be4ee:' + path.relative(path.resolve(appRoot, '../..'), file)], {
          cwd: appRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {}
    }
    source += file.endsWith('AuthAiScreens.tsx') ? '\nexport { RemoteLoginScreen };' : file.endsWith('/app/_layout.tsx') && !source.includes('export function MemberConnection') ? '\nexport { MemberConnection };' : '';
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true
      }
    }).outputText;
    vm.runInNewContext(compiled, {
      ...context,
      module,
      exports: module.exports,
      require(id) {
        if (id === 'react') return React;
        if (id === 'react-native') return {
          Platform: {
            OS: platform
          },
          Image: 'Image',
          Modal: 'Modal',
          Pressable: 'Pressable',
          Text: 'Text',
          View: 'View'
        };
        if (id === 'expo-router') return {
          router: {
            replace: v => routes.push(v),
            push: v => routes.push(v)
          },
          useLocalSearchParams: () => ({
            returnPath: '/post?eventId=fixture'
          }),
          usePathname: () => '/auth-callback',
          Stack: 'Stack',
          useFocusEffect: () => {}
        };
        if (id === 'expo-status-bar') return {
          StatusBar: 'StatusBar'
        };
        if (id === 'react-native-safe-area-context') return {
          SafeAreaProvider: 'SafeAreaProvider',
          SafeAreaView: 'SafeAreaView'
        };
        if (id === 'expo-crypto') return {
          randomUUID: () => uid
        };
        if (id === 'expo-image-picker') return {};
        if (visual.has(id)) return id.includes('state') ? {
          useApp: () => ({}),
          AppProvider: 'AppProvider'
        } : ui;
        if (id.startsWith('.')) {
          const candidate = path.resolve(path.dirname(file), id);
          for (const suffix of ['', '.ts', '.tsx']) try {
            return load(candidate + suffix);
          } catch (e) {
            if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e;
          }
        }
        throw new Error('Unmocked import ' + id + ' from ' + file);
      }
    }, {
      filename: file
    });
    return module.exports;
  }
  const remote = load(path.join(appRoot, 'src/remote.tsx')),
    config = load(path.join(appRoot, 'src/web-member-connection.ts'));
  const layout = load(path.join(appRoot, 'src/app/_layout.tsx')),
    auth = load(path.join(appRoot, 'src/screens/AuthAiScreens.tsx'));
  function render(c) {
    if (!c.mounted) return;
    current = c;
    c.cursor = 0;
    c.value = c.fn();
    c.pending.splice(0).forEach(f => f());
    current = null;
  }
  function mount(fn) {
    const c = {
      fn,
      slots: [],
      pending: [],
      cursor: 0,
      mounted: true
    };
    components.push(c);
    render(c);
    return c;
  }
  function replay(c) {
    for (const s of c.slots) if (s?.create) {
      if (s.cleanup && typeof s.cleanup !== 'function') throw new Error('bad cleanup ' + String(s.cleanup) + ' create ' + String(s.create));
      s.cleanup?.();
      s.cleanup = undefined;
    }
    for (const s of c.slots) if (s?.create) s.cleanup = s.create();
  }
  function unmount(c) {
    c.mounted = false;
    for (const s of c.slots) s?.cleanup?.();
  }
  async function flush() {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setImmediate(r));
      if (!dirty) return;
      dirty = false;
      components.forEach(render);
    }
    throw new Error('Did not settle');
  }
  const read = c => ({
    text: words(c.value),
    button: nodes(c.value).find(n => n.type === 'Button')
  });
  return {
    remote,
    config,
    layout,
    auth,
    load,
    mount,
    replay,
    unmount,
    flush,
    render,
    read,
    routes,
    browser,
    storage,
    options(fetcher = async () => {
      throw new Error('Unexpected network');
    }) {
      return {
        signupUrl: 'https://project.example.test/functions/v1/signup',
        supabaseUrl: 'https://project.example.test',
        publicApiKey: 'sb_publishable_fixture',
        callbackUrl: 'https://app.example.test/auth-callback',
        browser,
        fetcher,
        now: () => Date.parse('2026-10-21T00:00:00Z')
      };
    }
  };
}
function port(overrides = {}) {
  return {
    login: async () => null,
    restore: async () => null,
    logout: async () => {},
    signupState: async () => null,
    complete: async () => null,
    ...overrides
  };
}
function pending(h) {
  h.storage.set('yumidang.naver.pending', JSON.stringify({
    state: 'a'.repeat(64),
    verifier: 'fixture-verifier',
    expiresAt: '2026-10-21T00:05:00Z'
  }));
}
const callbackResponse = status => new Response(JSON.stringify({
  data: {
    status,
    returnTo: '/post?eventId=fixture',
    userId: uid,
    session: {
      accessToken: 'synthetic-token',
      refreshToken: 'synthetic-refresh',
      expiresIn: 3600,
      tokenType: 'bearer'
    }
  },
  error: null
}), {
  status: 200,
  headers: {
    'Content-Type': 'application/json'
  }
});

test('the authoritative session installer revokes an unmounted signup draft on ready, logout and port replacement', () => {
  const h = harness();
  const store = h.load(path.join(appRoot, 'src/signup-draft.ts')).signupDraftStore;
  const firstPort = port();
  h.remote.installMemberSessionPort(firstPort);
  const prepare = () => {
    h.remote.installMemberSessionDetails(verified('photo_required'));
    const scope = { userId: uid, epoch: h.remote.serviceSessionEpoch(), session: firstPort };
    store.edit(scope, 'mbti', 'INFJ');
    assert.equal(store.read(scope)?.mbti, 'INFJ');
    return scope;
  };
  let scope = prepare();
  h.remote.installMemberSessionDetails(verified('ready'));
  assert.equal(store.read(scope), null);
  scope = prepare();
  h.remote.installMemberSessionDetails(null);
  assert.equal(store.read(scope), null);
  scope = prepare();
  h.remote.installMemberSessionPort(port());
  assert.equal(store.read(scope), null);
  assert.equal(store.edit(scope, 'mbti', 'INTJ'), null);
});
test('configuration subscriber can unsubscribe without leaving duplicates', () => {
  const h = harness();
  let calls = 0;
  const unsubscribe = h.config.subscribeWebMemberConfiguration(() => calls++);
  h.config.configureWebMemberConnection(null);
  unsubscribe();
  h.config.configureWebMemberConnection(null);
  assert.equal(calls, 1);
});
for (const [name, settings] of [['missing service URL', {
  configured: false
}], ['native platform', {
  platform: 'android'
}], ['preview mode', {
  mode: 'preview'
}]]) test(name + ' never installs a browser port', async () => {
  const h = harness(settings);
  h.config.configureWebMemberConnection(h.options());
  h.mount(h.layout.MemberConnection);
  await h.flush();
  assert.equal(h.remote.useMemberPorts().session, null);
});
test('invalid configuration clears ports and cannot fabricate a successful connection', async () => {
  const h = harness();
  h.config.configureWebMemberConnection({
    ...h.options(),
    callbackUrl: 'http://unsafe.example/auth-callback'
  });
  h.mount(h.layout.MemberConnection);
  await h.flush();
  assert.equal(h.remote.useMemberPorts().session, null);
});
test('login port replacement releases the previous busy/error display', async () => {
  const h = harness(),
    wait = deferred();
  h.remote.installMemberSessionPort(port({
    login: () => wait.promise
  }));
  const c = h.mount(h.auth.RemoteLoginScreen);
  void h.read(c).button.props.onPress();
  await h.flush();
  assert.equal(h.read(c).button.props.loading, true);
  h.remote.installMemberSessionPort(port());
  await h.flush();
  assert.equal(h.read(c).button.props.loading, false);
  wait.reject(new Error('old'));
  await h.flush();
  assert.ok(!h.read(c).text.includes('입력을 유지'));
});
test('StrictMode callback replay dispatches one exchange', async () => {
  const h = harness();
  let calls = 0;
  h.remote.installMemberSessionPort(port({
    callback: async () => {
      calls++;
      return verified();
    }
  }));
  const c = h.mount(h.auth.RemoteNaverCallback);
  h.replay(c);
  await h.flush();
  assert.equal(calls, 1);
  assert.deepEqual(h.routes, ['/post?eventId=fixture']);
});
test('callback departure in the same tick sends no exchange', async () => {
  const h = harness();
  let calls = 0;
  h.remote.installMemberSessionPort(port({
    callback: async () => {
      calls++;
      return verified();
    }
  }));
  const c = h.mount(h.auth.RemoteNaverCallback);
  h.unmount(c);
  await h.flush();
  assert.equal(calls, 0);
  assert.equal(h.routes.length, 0);
});
test('empty initial restore cannot invalidate a concurrent callback epoch', async () => {
  const h = harness(),
    e = h.remote.serviceSessionEpoch();
  h.remote.installRestoredMemberSessionDetails(null, e);
  assert.equal(h.remote.serviceSessionEpoch(), e);
});
test('restore null revokes an existing member, and stale restore cannot change a newer member', async () => {
  const h = harness();
  h.remote.installMemberSessionDetails(verified());
  const old = h.remote.serviceSessionEpoch();
  h.remote.installRestoredMemberSessionDetails(null, old);
  assert.equal(await h.remote.serviceAccessToken(), null);
  h.remote.installMemberSessionDetails(verified());
  const current = h.remote.serviceSessionEpoch();
  h.remote.installRestoredMemberSessionDetails(null, old);
  assert.equal(h.remote.serviceSessionEpoch(), current);
  assert.equal(await h.remote.serviceAccessToken(), 'synthetic-token');
});
test('actual callback departure aborts the pending exchange and ignores a late result', async () => {
  const h = harness(),
    wait = deferred();
  let signal;
  h.remote.installMemberSessionPort(port({
    callback: (_url, s) => {
      signal = s;
      return wait.promise;
    }
  }));
  const c = h.mount(h.auth.RemoteNaverCallback);
  await h.flush();
  h.unmount(c);
  await h.flush();
  assert.equal(signal.aborted, true);
  wait.resolve(verified());
  await h.flush();
  assert.equal(h.routes.length, 0);
});
test('replacement port can complete after the first callback was abandoned', async () => {
  const h = harness(),
    old = deferred();
  h.remote.installMemberSessionPort(port({
    callback: () => old.promise
  }));
  h.mount(h.auth.RemoteNaverCallback);
  await h.flush();
  h.remote.installMemberSessionPort(port({
    callback: async () => verified()
  }));
  await h.flush();
  old.resolve(verified());
  await h.flush();
  assert.equal(h.routes.length, 1);
});
test('late callback error after session replacement is not displayed', async () => {
  const h = harness(),
    old = deferred();
  h.remote.installMemberSessionPort(port({
    callback: () => old.promise
  }));
  const c = h.mount(h.auth.RemoteNaverCallback);
  await h.flush();
  h.remote.installServiceSession('new');
  old.reject(new Error('old'));
  await h.flush();
  assert.ok(!h.read(c).text.includes('입력을 유지'));
});
test('invalid callback DTO shows an error without installing member authority', async () => {
  const h = harness();
  h.remote.installMemberSessionPort(port({
    callback: async () => ({
      status: 'ready'
    })
  }));
  const c = h.mount(h.auth.RemoteNaverCallback);
  await h.flush();
  assert.equal(h.routes.length, 0);
  assert.equal(await h.remote.serviceAccessToken(), null);
  assert.ok(h.read(c).text.includes('입력을 유지'));
});
for (const [status, destination] of [['ready', '/post?eventId=fixture'], ['photo_required', '/signup'], ['completion_required', '/signup'], ['information_required', '/login'], ['ineligible', '/login']]) test('verified ' + status + ' callback routes to ' + destination, async () => {
  const h = harness();
  h.remote.installMemberSessionPort(port({
    callback: async () => verified(status)
  }));
  h.mount(h.auth.RemoteNaverCallback);
  await h.flush();
  assert.deepEqual(h.routes, [destination]);
});
test('real root + real web port preserve pending verifier through StrictMode and initial restore', async () => {
  const h = harness();
  let calls = 0;
  pending(h);
  h.config.configureWebMemberConnection(h.options(async () => {
    calls++;
    return callbackResponse('ready');
  }));
  const root = h.mount(h.layout.MemberConnection);
  h.replay(root);
  await h.flush();
  assert.ok(h.storage.has('yumidang.naver.pending'));
  h.mount(h.auth.RemoteNaverCallback);
  await h.flush();
  assert.equal(calls, 1);
  assert.deepEqual(h.routes, ['/post?eventId=fixture']);
  assert.equal(await h.remote.serviceAccessToken(), 'synthetic-token');
});
test('real root departure disposes the browser verifier and all installed ports', async () => {
  const h = harness();
  h.config.configureWebMemberConnection(h.options());
  const root = h.mount(h.layout.MemberConnection);
  await h.flush();
  pending(h);
  h.unmount(root);
  await h.flush();
  assert.equal(h.storage.size, 0);
  assert.equal(h.remote.useMemberPorts().session, null);
  assert.equal(h.remote.useMemberPorts().photo, null);
});
test('configuration replacement immediately discards the old web port without reusing it', async () => {
  const h = harness();
  h.config.configureWebMemberConnection(h.options());
  const root = h.mount(h.layout.MemberConnection);
  await h.flush();
  const first = h.remote.useMemberPorts().session;
  pending(h);
  h.config.configureWebMemberConnection(h.options());
  h.render(root);
  assert.equal(h.storage.size, 0);
  assert.notEqual(h.remote.useMemberPorts().session, first);
  await h.flush();
});
test('native login explicitly explains the absent app adapter', () => {
  const h = harness({
      platform: 'android'
    }),
    c = h.mount(h.auth.RemoteLoginScreen);
  assert.ok(h.read(c).text.includes('앱의 네이버 로그인 연결'));
  assert.equal(h.read(c).button.props.disabled, true);
});
test('real root restore and callback can overlap across StrictMode without losing verifier or result', async () => {
  const h = harness(),
    reply = deferred();
  let calls = 0;
  pending(h);
  h.config.configureWebMemberConnection(h.options(() => {
    calls++;
    return reply.promise;
  }));
  const root = h.mount(h.layout.MemberConnection);
  h.replay(root);
  const callback = h.mount(h.auth.RemoteNaverCallback);
  h.replay(callback);
  await h.flush();
  assert.equal(calls, 1);
  reply.resolve(callbackResponse('ready'));
  await h.flush();
  assert.deepEqual(h.routes, ['/post?eventId=fixture']);
  assert.equal(await h.remote.serviceAccessToken(), 'synthetic-token');
});
test('missing browser authentication configuration has a distinct explanation', () => {
  const h = harness();
  const login = h.mount(h.auth.RemoteLoginScreen);
  assert.ok(h.read(login).text.includes('연결 설정이 아직 제공되지 않았어요'));
  assert.ok(!h.read(login).text.includes('올바르지 않아요'));
});
test('actual root invalid installation publishes a distinct configuration failure to login', async () => {
  const h = harness();
  const login = h.mount(h.auth.RemoteLoginScreen);
  h.config.configureWebMemberConnection({
    ...h.options(),
    callbackUrl: 'http://unsafe.example/auth-callback'
  });
  h.mount(h.layout.MemberConnection);
  await h.flush();
  assert.equal(h.config.webMemberConnectionStatus(), 'invalid');
  assert.ok(h.read(login).text.includes('연결 설정이 올바르지 않아요'));
  assert.ok(!h.read(login).text.includes('설정이 아직 제공되지 않았어요'));
  assert.equal(h.read(login).button.props.disabled, true);
  assert.equal(await h.remote.serviceAccessToken(), null);
});
test('correcting an invalid installation removes its failure without claiming authenticated membership', async () => {
  const h = harness();
  h.config.configureWebMemberConnection({
    ...h.options(),
    callbackUrl: 'http://unsafe.example/auth-callback'
  });
  h.mount(h.layout.MemberConnection);
  const login = h.mount(h.auth.RemoteLoginScreen);
  await h.flush();
  assert.equal(h.config.webMemberConnectionStatus(), 'invalid');
  h.config.configureWebMemberConnection(h.options());
  await h.flush();
  assert.equal(h.config.webMemberConnectionStatus(), 'installed');
  assert.ok(!h.read(login).text.includes('올바르지 않아요'));
  assert.equal(h.read(login).button.props.disabled, false);
  assert.equal(await h.remote.serviceAccessToken(), null);
});
test('removing invalid configuration returns the UI to the missing-configuration state', async () => {
  const h = harness();
  h.config.configureWebMemberConnection({
    ...h.options(),
    callbackUrl: 'http://unsafe.example/auth-callback'
  });
  h.mount(h.layout.MemberConnection);
  const login = h.mount(h.auth.RemoteLoginScreen);
  await h.flush();
  h.config.configureWebMemberConnection(null);
  await h.flush();
  assert.equal(h.config.webMemberConnectionStatus(), 'unconfigured');
  assert.ok(h.read(login).text.includes('설정이 아직 제공되지 않았어요'));
  assert.equal(h.read(login).button.props.disabled, true);
});


test('reapplying the same trusted options does not leave an installed connection pending', async () => {
  const h = harness();
  const options = h.options();
  h.config.configureWebMemberConnection(options);
  const root = h.mount(h.layout.MemberConnection);
  await h.flush();
  assert.equal(h.config.webMemberConnectionStatus(), 'installed');
  h.config.configureWebMemberConnection(options);
  h.render(root);
  await h.flush();
  assert.equal(h.config.webMemberConnectionStatus(), 'installed');
});
