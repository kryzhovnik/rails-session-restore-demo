// Demo page: three emulated browsers (iframes served by the service worker),
// a step-by-step guide, and a live view of the server state. The result is
// decided by the worker (state.proof), not by reading the iframes.

const BROWSERS = ["alice", "bob", "carol"];
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ask = (type) =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    navigator.serviceWorker.controller.postMessage({ type }, [channel.port2]);
  });

// Signed cookie value (Rails 8.1): base64(JSON)--digest, where
// JSON is {"_rails":{"message": base64(JSON value), "exp", "pur"}}.
// Show the signed value next to it. Display only; nothing is verified here.
const decodeSigned = (raw) => {
  try {
    const envelope = JSON.parse(atob(decodeURIComponent(raw).split("--")[0]));
    return atob(envelope._rails.message);
  } catch {
    return "?";
  }
};

// The current step follows the server state, so the guide stays correct
// if the user does things in a different order.
const currentStep = (state) => {
  if (state.proof) return 5;
  if (!state.jars.alice.session_id) return 1;
  if (state.restores === 0) return 2;
  if (!state.jars.bob.session_id) return 3;
  return 4;
};

const renderGuide = (state) => {
  const step = currentStep(state);
  for (const li of document.querySelectorAll("#steps li")) {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < step);
    li.classList.toggle("active", n === step);
  }

  // Session ids in the step texts come from the backup.
  const seq = state.backup?.sequence ?? 0;
  const values = {
    "carol-id": state.backup?.sessionIds.join(", ") || "none",
    "backup-seq": seq,
    "next-id": seq + 1,
  };
  for (const el of document.querySelectorAll("[data-value]")) {
    el.textContent = values[el.dataset.value];
  }

  const proof = state.proof;
  $("result").hidden = !proof;
  if (proof) {
    $("result").innerHTML =
      `Instead, Rails signs Alice's unchanged cookie in as <b>${escapeHtml(proof.after.email)}</b> ` +
      `(session ${proof.after.sessionId}) and shows that user's private note. Before the restore, ` +
      `the same cookie was ${escapeHtml(proof.before.email)} (session ${proof.before.sessionId}). ` +
      `Carol's session was in the backup and is not affected: reload her browser to check.`;
  }
};

let firstBootId = null;

const render = (state) => {
  const ready = state.status === "ready";
  $("status").textContent = state.lastError
    ? `Rails: ${state.status}: ${state.lastError}. Click Reset demo to start over.`
    : `Rails: ${state.status}`;

  firstBootId ||= state.bootId;
  const restarted = state.bootId !== firstBootId;
  $("notice").hidden = !restarted;
  $("notice").textContent = restarted
    ? "The service worker restarted, so the demo state was lost. Click Reset demo."
    : "";

  $("restore").disabled = !ready || !state.backup;
  $("reset").disabled = !ready && state.status !== "error";
  $("backup").textContent = state.backup
    ? `Backup taken at ${state.backup.at.slice(11, 19)} UTC. Sessions in backup: ` +
      `[${state.backup.sessionIds.join(", ")}]. Restores: ${state.restores}.`
    : "No backup yet.";

  const inBackup = new Set(state.backup?.sessionIds || []);
  $("sessions").innerHTML =
    (state.sessions || [])
      .map(
        (s) =>
          `<tr><td>${s.id}</td><td>${s.user_id}</td><td>${escapeHtml(s.email)}</td>` +
          `<td>${inBackup.has(s.id) ? "yes" : ""}</td></tr>`,
      )
      .join("") || `<tr><td colspan="4">(empty)</td></tr>`;

  for (const name of BROWSERS) {
    const value = state.jars[name].session_id;
    let text = value
      ? `cookie session_id = ${value}  → signed value: ${decodeSigned(value)}`
      : "cookie session_id: none";
    if (name === "alice" && state.beforeRestore) {
      text += `\nunchanged since before restore ${state.beforeRestore.restore}: ` +
        (state.beforeRestore.cookieUnchanged ? "yes" : "no");
    }
    $(`cookie-${name}`).textContent = text;
  }

  $("events").textContent = state.events.map((e) => `${e.at.slice(11, 19)} ${e.message}`).join("\n");
  renderGuide(state);
};

const showAddress = (name) => {
  try {
    const loc = $(`frame-${name}`).contentWindow.location;
    $(`address-${name}`).textContent = loc.pathname + loc.search;
  } catch {
    $(`address-${name}`).textContent = "";
  }
};

const poll = async () => {
  const reply = await ask("state");
  if (reply.state) render(reply.state);
  if (!reply.ok && reply.error) $("status").textContent = `Error: ${reply.error}`;
  return reply.state;
};

const openFrames = () => {
  for (const name of BROWSERS) $(`frame-${name}`).src = `/~${name}/`;
};

const start = async () => {
  const workerUrl = import.meta.env.PROD ? "/rails.sw.js" : "/dev-sw.js?dev-sw";
  await navigator.serviceWorker.register(workerUrl, { scope: "/", type: "module" });
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
    );
  }

  let state = await poll();
  while (state?.status !== "ready" && state?.status !== "error") {
    await new Promise((r) => setTimeout(r, 500));
    state = await poll();
  }

  for (const name of BROWSERS) {
    $(`frame-${name}`).addEventListener("load", () => {
      showAddress(name);
      poll();
    });
  }
  openFrames();

  // Polling also keeps the service worker alive.
  setInterval(poll, 1000);
};

document.addEventListener("click", async (event) => {
  const reload = event.target.dataset?.reload;
  if (reload) $(`frame-${reload}`).contentWindow.location.reload();

  const action = event.target.id;
  if (action === "restore" || action === "reset") {
    $("restore").disabled = $("reset").disabled = true;
    const reply = await ask(action);
    if (reply.state) render(reply.state);
    if (!reply.ok) $("status").textContent = `Error: ${reply.error}. Click Reset demo to start over.`;
    if (action === "reset") {
      firstBootId = reply.state?.bootId ?? firstBootId;
      openFrames();
    }
  }
});

start().catch((e) => ($("status").textContent = `Error: ${e.message}`));
