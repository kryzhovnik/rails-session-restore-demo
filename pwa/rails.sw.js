// Service worker for the in-browser restore demo (scenario A).
//
// It runs a small Rails 8.1 app with the unchanged generated authentication
// code on ruby.wasm, and keeps the SQLite database in sqlite-wasm on the JS
// side.
//
// Emulated browsers: requests under /~alice/, /~bob/ and /~carol/ are passed
// to Rails with SCRIPT_NAME set to that prefix. Each prefix has its own
// cookie jar here in the worker. All share one client IP: REMOTE_ADDR is not
// set, because request.remote_ip fails on the wasmify IPAddr shim. The real browser cookie store
// is not used, so the iframes do not share cookies.
//
// Before the backup, Carol signs in through the normal login form (an
// automated GET /session/new + POST /session from this worker). Her session
// row is in the backup; the seed does not insert sessions.
//
// Backup: sqlite3_serialize of the whole database. Restore: stop Rails,
// close the live database, open a fresh one, load the backup bytes into it
// (sqlite3_deserialize), boot Rails again. No row is copied, no id is
// assigned, no sequence is reset by hand. secret_key_base is random per
// worker and the same before and after the restore.
//
// Proof: before each restore the worker records Alice's cookie and who Rails
// said she was. The result counts only if a later response from Rails to
// Alice's unchanged cookie names a different user, after the last restore.
//
// Reset: start over from an empty database (schema, seed, Carol's sign-in,
// new backup) and clear all cookie jars.

import { initRailsVM, registerSQLiteWasmInterface } from "wasmify-rails";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import setCookieParser from "set-cookie-parser";

const BROWSERS = ["alice", "bob", "carol"];

const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const SECRET_KEY_BASE = randomHex(64);

let sqlite3 = null;
let db = null;
let wasmModule = null;
let vm = null;
let callRails = null;
let backup = null;
let lastError = null;
let restores = 0;
let status = "starting";
let beforeRestore = null; // Alice's cookie and identity before the last restore
let proof = null;
const bootId = randomHex(8);
const jars = Object.fromEntries(BROWSERS.map((name) => [name, new Map()]));
const whoami = Object.fromEntries(BROWSERS.map((name) => [name, null]));
const events = [];

const log = (message) => {
  events.push({ at: new Date().toISOString(), message });
  console.log("[demo]", message);
};

const fail = (what, e) => {
  status = "error";
  lastError = `${what} failed: ${e.message}`;
  log(lastError);
  throw e;
};

// Rails handles one request at a time.
let chain = Promise.resolve();
const serialize = (fn) => {
  const result = chain.then(fn, fn);
  chain = result.catch(() => {});
  return result;
};

const RACK_CALL = `
  proc do
    req = JS.global[:__demoRequest]
    opts = JSON.parse(req[:headers].to_s)
    opts[:method] = req[:method].to_s
    opts[:input] = req[:input].to_s
    env = Rack::MockRequest.env_for(req[:url].to_s, opts)

    status, headers, body = Rails.application.call(env)
    out = +""
    body.each { |part| out << part }
    body.close if body.respond_to?(:close)

    headers = headers.to_h
    cookies = Array(headers.delete("set-cookie")).flat_map { |c| c.split("\\n") }
    plain = headers.transform_values { |v| Array(v).join(", ") }

    JSON.generate(status: status, headers: plain, cookies: cookies, body: [out].pack("m0"))
  end
`;

// Qualify with main: schema load leaves an empty temp.sqlite_sequence (from
// Active Record's temporary copy tables), and an unqualified name finds that
// one first.
const sessionSequence = () =>
  db.selectValue("SELECT seq FROM main.sqlite_sequence WHERE name = 'sessions'") ?? null;

const sessionIds = () => db.selectValues("SELECT id FROM sessions ORDER BY id");

const openDatabase = (bytes = null) => {
  const fresh = new sqlite3.oo1.DB(":memory:", "ct");
  if (bytes) {
    const { capi, wasm } = sqlite3;
    const ptr = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(
      fresh.pointer,
      "main",
      ptr,
      bytes.byteLength,
      bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc) throw new Error(`sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`);
  }
  db = fresh;
  registerSQLiteWasmInterface(self, db);
};

const stopRails = () => {
  vm = null;
  callRails = null;
};

const bootRails = async () => {
  status = "booting";
  log("Rails: booting");
  // Revalidate: a stale cached app.wasm would not match this worker's code.
  if (!wasmModule) {
    wasmModule = await WebAssembly.compileStreaming(fetch("/app.wasm", { cache: "no-cache" }));
  }
  vm = await initRailsVM(wasmModule, {
    database: { adapter: "sqlite3_wasm" },
    env: [`SECRET_KEY_BASE=${SECRET_KEY_BASE}`],
    outputCallback: (line) => log(`rails: ${line}`),
  });
  vm.eval("ActiveRecord::Tasks::DatabaseTasks.prepare_all");
  callRails = vm.eval(RACK_CALL);
  status = "ready";
  log(`Rails: ready (${vm.eval("Rails::VERSION::STRING").toString()})`);
};

const takeBackup = () => {
  const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer);
  backup = { bytes, at: new Date().toISOString(), sessionIds: sessionIds(), sequence: sessionSequence() };
  log(
    `backup: ${bytes.byteLength} bytes, sessions [${backup.sessionIds.join(", ")}], ` +
      `sqlite_sequence(sessions) = ${backup.sequence}`,
  );
};

const seedAndBackup = async () => {
  openDatabase();
  await bootRails();
  // db:prepare (in bootRails) loads the schema and runs the seed on a new database.
  log(`seed: ${vm.eval("User.count").toString()} users, ${vm.eval("Note.count").toString()} notes`);
  signIn("carol", "carol@example.test", "5678");
  takeBackup();
};

const firstBoot = async () => {
  sqlite3 = await sqlite3InitModule();
  log(`SQLite ${sqlite3.version.libVersion}`);
  await seedAndBackup();
};

let booted = null;
const ensureBooted = () => (booted ||= serialize(firstBoot).catch((e) => fail("boot", e)));

const restoreBackup = () =>
  serialize(async () => {
    if (!backup) throw new Error("no backup");
    status = "restoring";
    lastError = null;
    try {
      // Record Alice's cookie and who Rails last said she was, if that answer
      // was for this same cookie and named Alice.
      const cookie = jars.alice.get("session_id");
      const seen = whoami.alice;
      beforeRestore =
        cookie && seen && seen.cookie === cookie && seen.email === "alice@example.test"
          ? { restore: restores + 1, cookie, email: seen.email, sessionId: seen.session_id }
          : null;
      proof = null;

      log("restore: stop Rails, replace database with the backup");
      stopRails();
      db.close();
      openDatabase(backup.bytes.slice());
      log(`restore: sessions [${sessionIds().join(", ")}], sqlite_sequence(sessions) = ${sessionSequence()}`);
      await bootRails();
      restores += 1;
    } catch (e) {
      fail("restore", e);
    }
  });

const resetAll = () =>
  serialize(async () => {
    status = "resetting";
    lastError = null;
    log("reset: stop Rails, start from an empty database");
    stopRails();
    // Load app.wasm again, so a rebuilt app takes effect without a new worker.
    wasmModule = null;
    db?.close();
    for (const name of BROWSERS) {
      jars[name].clear();
      whoami[name] = null;
    }
    restores = 0;
    beforeRestore = null;
    proof = null;
    try {
      sqlite3 ||= await sqlite3InitModule();
      await seedAndBackup();
      booted = Promise.resolve();
    } catch (e) {
      fail("reset", e);
    }
  });

const decodeBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const updateJar = (jar, setCookies) => {
  for (const c of setCookieParser.parse(setCookies, { decodeValues: false })) {
    const expired =
      (c.expires && c.expires.getTime() <= Date.now()) || c.maxAge === 0 || c.value === "";
    if (expired) jar.delete(c.name);
    else jar.set(c.name, c.value);
  }
};

// The whoami page (GET /) renders JSON inside <pre>. Returns null for any
// other response, for example the redirect to the sign-in form.
const parseWhoami = (res) => {
  if (res.status !== 200) return null;
  const html = new TextDecoder().decode(decodeBase64(res.body));
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1];
  if (!pre) return null;
  const text = pre
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Alice's answer from Rails after the last restore decides the proof.
const updateProof = (sentCookie, answer) => {
  const valid =
    beforeRestore &&
    beforeRestore.restore === restores &&
    sentCookie === beforeRestore.cookie &&
    answer &&
    answer.email !== beforeRestore.email;
  proof = valid
    ? {
        restore: restores,
        before: { email: beforeRestore.email, sessionId: beforeRestore.sessionId },
        after: { email: answer.email, sessionId: answer.session_id },
      }
    : null;
};

// One Rack request through the Rails VM. The caller must hold the queue.
const callRack = ({ browser, path, method = "GET", headers = {}, input = "" }) => {
  const env = { ...headers };
  const jar = browser ? jars[browser] : null;
  const sentCookie = jar?.get("session_id") ?? null;
  if (browser) {
    env.SCRIPT_NAME = `/~${browser}`;
    env.HTTP_COOKIE = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  self.__demoRequest = {
    url: `${self.location.origin}${path}`,
    method,
    headers: JSON.stringify(env),
    input,
  };
  const res = JSON.parse(callRails.call("call").toString());

  if (jar) updateJar(jar, res.cookies);
  if (browser && method === "GET" && path.split("?")[0] === "/") {
    const answer = parseWhoami(res);
    whoami[browser] = answer && { ...answer, cookie: sentCookie };
    if (browser === "alice") updateProof(sentCookie, answer);
  }
  if (browser && !path.startsWith("/assets/")) {
    log(`${browser}: ${method} ${path.split("?")[0]} -> ${res.status}`);
  }
  return res;
};

// Normal sign-in over the login form: GET the form for the CSRF token,
// then POST /session with the email and password.
const signIn = (browser, email, password) => {
  const form = new TextDecoder().decode(decodeBase64(callRack({ browser, path: "/session/new" }).body));
  const token = form.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (!token) throw new Error("no CSRF token in the login form");
  const res = callRack({
    browser,
    path: "/session",
    method: "POST",
    headers: { CONTENT_TYPE: "application/x-www-form-urlencoded" },
    input: new URLSearchParams({ authenticity_token: token, email_address: email, password }).toString(),
  });
  if (res.status !== 302 || !jars[browser].has("session_id")) {
    throw new Error(`sign-in for ${browser} failed (${res.status})`);
  }
};

const handle = async (request, browser, path) => {
  await ensureBooted();
  const url = new URL(request.url);
  const method = request.method;
  const input = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await request.text() : "";

  return serialize(async () => {
    if (!callRails) throw new Error(`Rails is not running (${status})`);
    const headers = {};
    for (const [key, value] of request.headers.entries()) {
      headers[`HTTP_${key.toUpperCase().replaceAll("-", "_")}`] = value;
    }
    delete headers.HTTP_COOKIE;
    const contentType = request.headers.get("content-type");
    if (contentType) headers.CONTENT_TYPE = contentType;

    const res = callRack({ browser, path: path + url.search, method, headers, input });

    const nullBody = [101, 204, 205, 304].includes(res.status);
    return new Response(nullBody ? null : decodeBase64(res.body), {
      status: res.status,
      headers: res.headers,
    });
  }).catch((e) => {
    log(`error: ${e.message}`);
    return new Response(`Application Error: ${e.message}`, { status: 500 });
  });
};

const state = () => {
  const ready = status === "ready" && db;
  const aliceCookie = jars.alice.get("session_id");
  return {
    bootId,
    status,
    lastError,
    restores,
    backup: backup && {
      at: backup.at,
      sessionIds: backup.sessionIds,
      sequence: backup.sequence,
      size: backup.bytes.byteLength,
    },
    sessions: ready
      ? db.exec(
          `SELECT s.id, s.user_id, u.email_address AS email
             FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.id`,
          { returnValue: "resultRows", rowMode: "object" },
        )
      : null,
    jars: Object.fromEntries(BROWSERS.map((name) => [name, Object.fromEntries(jars[name])])),
    whoami: Object.fromEntries(
      BROWSERS.map((name) => [name, whoami[name] && { email: whoami[name].email, sessionId: whoami[name].session_id }]),
    ),
    beforeRestore: beforeRestore && {
      restore: beforeRestore.restore,
      email: beforeRestore.email,
      sessionId: beforeRestore.sessionId,
      cookieUnchanged: aliceCookie === beforeRestore.cookie,
    },
    proof,
    events: events.slice(-60),
  };
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
  ensureBooted().catch(() => {});
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const match = url.pathname.match(/^\/~(alice|bob|carol)(\/.*)?$/);
  if (match) {
    event.respondWith(handle(event.request, match[1], match[2] || "/"));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(handle(event.request, null, url.pathname));
  }
  // Everything else (the demo page, Vite files, app.wasm) goes to the network.
});

self.addEventListener("message", (event) => {
  const port = event.ports[0];
  const reply = (payload) => port?.postMessage(payload);
  const { type } = event.data || {};

  (async () => {
    switch (type) {
      case "state":
        if (status === "starting") ensureBooted().catch(() => {});
        return reply({ ok: true, state: state() });
      case "restore":
        await restoreBackup();
        return reply({ ok: true, state: state() });
      case "reset":
        await resetAll();
        return reply({ ok: true, state: state() });
      default:
        return reply({ ok: false, error: `unknown message ${type}` });
    }
  })().catch((e) => reply({ ok: false, error: e.message, state: state() }));
});
