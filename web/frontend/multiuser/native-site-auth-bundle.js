(() => {
  // frontend/multiuser/native-site-auth.mjs
  var USER = /^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function createNativeSiteAuth({ browser, fetchImpl = fetch } = {}) {
    let origin;
    try {
      origin = new URL(browser.location.href).origin;
    } catch {
      throw Error("Ongeldige RIG-pagina.");
    }
    if (!origin.startsWith("https://") || typeof fetchImpl !== "function") throw Error("Ongeldige RIG-pagina.");
    const listeners = /* @__PURE__ */ new Set();
    let observed, reading = null, disposed = false, timer = null;
    const ended = () => Error("Je aanmelding is gewijzigd. Meld je opnieuw aan.");
    function publish(userId) {
      if (observed === userId) return;
      observed = userId;
      for (const listener of [...listeners]) listener(userId);
    }
    async function snapshot() {
      if (disposed) throw ended();
      if (reading) return reading;
      const pending = (async () => {
        const response = await fetchImpl(origin + "/api/session", { method: "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(1e4) });
        if (disposed) throw ended();
        if ([401, 403].includes(response.status)) {
          publish(null);
          return { userId: null };
        }
        if (!response.ok || !response.body) throw Error("Aanmelding kon niet worden gecontroleerd.");
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (; ; ) {
            const { done, value: value2 } = await reader.read();
            if (done) break;
            size += value2.byteLength;
            if (size > 2048) throw Error("Ongeldige aanmelding.");
            chunks.push(value2);
          }
        } finally {
          try {
            void reader.cancel().catch(() => {
            });
          } catch {
          }
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
        let value;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw Error("Aanmelding kon niet worden gecontroleerd.");
        }
        if (!USER.test(value?.userId || "") || disposed) throw ended();
        publish(value.userId);
        return { userId: value.userId };
      })();
      reading = pending;
      try {
        return await pending;
      } finally {
        if (reading === pending) reading = null;
      }
    }
    async function sessionSubject() {
      return (await snapshot()).userId;
    }
    async function currentSession() {
      return Boolean(await sessionSubject());
    }
    const refresh = () => {
      if (!disposed) void snapshot().catch(() => publish(null));
    };
    const visible = () => {
      if (browser.document?.visibilityState === "visible") refresh();
    };
    function watchSession(listener) {
      if (disposed || typeof listener !== "function") throw ended();
      if (!listeners.size) {
        browser.addEventListener?.("focus", refresh);
        browser.addEventListener?.("pageshow", refresh);
        browser.document?.addEventListener("visibilitychange", visible);
        timer = browser.setInterval?.(refresh, 3e4);
        timer?.unref?.();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stopWatching();
      };
    }
    function stopWatching() {
      browser.removeEventListener?.("focus", refresh);
      browser.removeEventListener?.("pageshow", refresh);
      browser.document?.removeEventListener("visibilitychange", visible);
      if (timer !== null) browser.clearInterval?.(timer);
      timer = null;
    }
    async function api(path, options = {}, expectedUserId = null) {
      if (disposed) throw ended();
      let target;
      try {
        target = new URL(path, origin);
      } catch {
        throw Error("Ongeldige aanvraag.");
      }
      const method = (options.method || "GET").toUpperCase();
      if (typeof path !== "string" || path.length > 1200 || !path.startsWith("/api/") || target.pathname + target.search !== path || !target.pathname.startsWith("/api/") || target.origin !== origin || target.username || target.password || target.hash || target.pathname === "/api/payments/webhook" || !["GET", "POST"].includes(method)) throw Error("Ongeldige aanvraag.");
      if (expectedUserId !== null && !USER.test(expectedUserId)) throw ended();
      const before = await snapshot();
      if (expectedUserId !== null && before.userId !== expectedUserId) throw ended();
      if (target.pathname === "/api/session" && !target.search && method === "GET") return Response.json(before.userId ? { userId: before.userId } : { error: "Aanmelden vereist." }, { status: before.userId ? 200 : 401 });
      if (!before.userId) throw ended();
      const bound = expectedUserId ?? before.userId, headers = new Headers(options.headers);
      headers.delete("authorization");
      headers.delete("cookie");
      headers.set("x-rig-expected-user", bound);
      const response = await fetchImpl(target.href, { ...options, method, headers, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
      try {
        if (disposed || (await snapshot()).userId !== bound || options.signal?.aborted) throw ended();
      } catch (error) {
        if (response.body) void response.body.cancel().catch(() => {
        });
        throw error;
      }
      return response;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      listeners.clear();
    }
    return Object.freeze({ api, sessionSubject, currentSession, watchSession, dispose });
  }

  // frontend/multiuser/session-guard.mjs
  async function bindSessionGuard({ auth, binding, onChanged }) {
    const subject = await auth.sessionSubject();
    if (!subject) {
      binding.dispose();
      throw Error("Missing session");
    }
    let ended = false, unsubscribe = () => {
    };
    const end = () => {
      if (ended) return;
      ended = true;
      binding.dispose();
      unsubscribe();
      onChanged();
    };
    unsubscribe = auth.watchSession((next) => {
      if (next !== subject) end();
    });
    if (ended) unsubscribe();
    async function checkCurrent() {
      if (await auth.sessionSubject() !== subject) end();
      return !ended;
    }
    await checkCurrent();
    return { checkCurrent, stop: () => {
      if (!ended) {
        ended = true;
        unsubscribe();
      }
    } };
  }

  // frontend/multiuser/ui-auth.mjs
  async function prepareBoundUi({ auth, browser }) {
    const response = await auth.api("/api/session");
    let body;
    try {
      body = await response.json();
    } catch {
      throw Error("Aanmelding kon niet worden gecontroleerd.");
    }
    const userId = body?.userId;
    if (!response.ok || !/^u-[0-9a-f-]{36}$/.test(userId || "")) throw Error("Aanmelding kon niet worden gecontroleerd.");
    const prefix = `rig-user:${userId}:`, storage = browser.sessionStorage;
    let epoch = 0, disposed = false;
    const pending = /* @__PURE__ */ new Set();
    const check = (expected) => {
      if (disposed || expected !== epoch) throw Error("De aanmelding is be\xEBindigd.");
    };
    const scopedStorage = { getItem: (k) => {
      check(epoch);
      return storage.getItem(prefix + k);
    }, setItem: (k, v) => {
      check(epoch);
      return storage.setItem(prefix + k, v);
    }, removeItem: (k) => {
      check(epoch);
      return storage.removeItem(prefix + k);
    } };
    async function request(path, options = {}) {
      const start = epoch;
      check(start);
      const controller = new AbortController();
      pending.add(controller);
      const relay = () => controller.abort();
      options.signal?.addEventListener("abort", relay, { once: true });
      if (options.signal?.aborted) controller.abort();
      try {
        const res = await auth.api(path, { ...options, signal: controller.signal }, userId);
        if (disposed || start !== epoch || controller.signal.aborted) {
          if (res.body) void res.body.cancel().catch(() => {
          });
          throw Error("De aanmelding is be\xEBindigd.");
        }
        return res;
      } finally {
        pending.delete(controller);
        options.signal?.removeEventListener("abort", relay);
      }
    }
    let currentVideoUrl = null, videoController = null, videoSequence = 0;
    async function openVideo(path) {
      if (!/^\/api\/generations\/[A-Za-z0-9_-]{1,100}\/video$/.test(path)) throw Error("Ongeldig resultaat.");
      const start = epoch;
      check(start);
      if (videoController) videoController.abort();
      const sequence = ++videoSequence, controller = new AbortController();
      videoController = controller;
      pending.add(controller);
      const checkVideo = () => {
        check(start);
        if (sequence !== videoSequence || controller.signal.aborted) throw Error("Het resultaat is niet meer actueel.");
      };
      let reader, res;
      const cancel = () => {
        if (reader) void reader.cancel().catch(() => {
        });
        else if (res?.body) void res.body.cancel().catch(() => {
        });
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        res = await request(path, { cache: "no-store", signal: controller.signal });
        checkVideo();
        if (!res.ok || !/^video\/mp4(?:;|$)/i.test(res.headers.get("content-type") || "") || !res.body) throw Error("Het resultaat kon niet worden geladen.");
        reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        for (; ; ) {
          const { value, done } = await reader.read();
          checkVideo();
          if (done) break;
          size += value.byteLength;
          if (size > 100 * 1024 * 1024) throw Error("Het resultaat is te groot.");
          chunks.push(value);
        }
        checkVideo();
        const next = browser.URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
        if (disposed || start !== epoch || sequence !== videoSequence || controller.signal.aborted) {
          browser.URL.revokeObjectURL(next);
          throw Error("De aanmelding is be\xEBindigd.");
        }
        if (currentVideoUrl) browser.URL.revokeObjectURL(currentVideoUrl);
        currentVideoUrl = next;
        return next;
      } catch (e) {
        if (reader) await reader.cancel().catch(() => {
        });
        else if (res?.body) void res.body.cancel().catch(() => {
        });
        throw e;
      } finally {
        pending.delete(controller);
        if (videoController === controller) videoController = null;
        controller.signal.removeEventListener("abort", cancel);
      }
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      for (const controller of pending) controller.abort();
      pending.clear();
      if (currentVideoUrl) {
        browser.URL.revokeObjectURL(currentVideoUrl);
        currentVideoUrl = null;
      }
      const doc = browser.document;
      if (doc) {
        const studio = doc.getElementById("rigStudio"), video = doc.getElementById("resultVideo"), link = doc.getElementById("export");
        if (studio) studio.hidden = true;
        if (video) {
          try {
            video.pause?.();
          } catch {
          }
          video.removeAttribute("src");
          video.hidden = true;
        }
        if (link) {
          link.removeAttribute("href");
          link.hidden = true;
        }
      }
    }
    return { userId, scopedStorage, request, openVideo, dispose, isActive: () => !disposed };
  }

  // frontend/multiuser/guarded-binding.mjs
  async function prepareGuardedBinding({ auth, browser, onChanged }) {
    let binding = null, interrupted = false;
    const proxy = { dispose() {
      interrupted = true;
      binding?.dispose();
    } };
    const guard = await bindSessionGuard({ auth, binding: proxy, onChanged });
    try {
      if (interrupted) throw Error("De aanmelding is gewijzigd.");
      binding = await prepareBoundUi({ auth, browser });
      if (interrupted || !await guard.checkCurrent()) {
        binding.dispose();
        throw Error("De aanmelding is gewijzigd.");
      }
      return { binding, stop: guard.stop };
    } catch (error) {
      binding?.dispose();
      guard.stop();
      throw error;
    }
  }

  // frontend/multiuser/video-capability.mjs
  async function enableVideoIfAvailable({ binding, window: window2, document, loadScript }) {
    const unavailable = () => {
      const changed = window2.rigVideoEnabled === true || window2.rigVideoQualities?.includes("edit-standard");
      window2.rigVideoEnabled = false;
      window2.rigVideoQualities = [];
      if (changed && binding.isActive()) document.dispatchEvent(new window2.Event("rig-video-availability"));
      return false;
    };
    try {
      if (!binding.isActive()) return unavailable();
      const response = await binding.request("/api/video-config", { cache: "no-store" });
      if (!binding.isActive() || !response.ok) return unavailable();
      const config = await response.json();
      if (!binding.isActive() || config?.enabled !== true) return unavailable();
      const qualities = config.qualities === void 0 ? ["standard", "pro"] : config.qualities;
      if (!Array.isArray(qualities) || !qualities.length || qualities.some((value) => !["standard", "pro", "edit-standard"].includes(value)) || new Set(qualities).size !== qualities.length) return unavailable();
      window2.rigVideoFunding = config.funding === "sponsored" ? "sponsored" : "owner";
      window2.rigVideoQualities = [...qualities];
      if (window2.rigVideoEnabled !== true) await loadScript("generation-ui.js");
      if (!binding.isActive()) return unavailable();
      window2.rigVideoEnabled = true;
      document.getElementById("videoAvailabilityNote").textContent = window2.rigVideoFunding === "sponsored" ? "Je testvideo\u2019s worden betaald uit je gratis testtegoed." : "Mollie staat in testmodus. Videogeneratie gebruikt echt fal-tegoed.";
      document.dispatchEvent(new window2.Event("rig-video-availability"));
      return true;
    } catch {
      return unavailable();
    }
  }

  // frontend/multiuser/invitation.mjs
  var storageKey = "rig-sponsored-invitation:v1";
  var codePattern = /^[A-Za-z0-9_-]{43}$/;
  var ownerPattern = /^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var invitations = /* @__PURE__ */ new WeakMap();
  function readStored(storage) {
    try {
      const value = storage.getItem(storageKey);
      if (value === null) return null;
      const record = JSON.parse(value);
      if (codePattern.test(record?.code || "") && (record.userId === null || ownerPattern.test(record.userId || ""))) return { code: record.code, userId: record.userId };
    } catch {
    }
    try {
      storage.removeItem(storageKey);
    } catch {
    }
    return null;
  }
  function writeStored(storage, record) {
    try {
      storage.setItem(storageKey, JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }
  function clearStored(storage, expected) {
    const current = readStored(storage);
    if (current?.code !== expected.code || current.userId !== expected.userId) return;
    try {
      storage.removeItem(storageKey);
    } catch {
    }
  }
  function captureSponsorInvitation({ browser } = {}) {
    let storage, current;
    try {
      storage = browser.sessionStorage;
      current = new URL(browser.location.href);
    } catch {
      return null;
    }
    let pending = readStored(storage);
    if (/^#invite(?:=|&|$)/.test(current.hash)) {
      const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(current.hash);
      try {
        browser.history.replaceState(browser.history.state, "", current.pathname + current.search);
      } catch {
        try {
          storage.removeItem(storageKey);
        } catch {
        }
        return null;
      }
      if (!match) {
        try {
          storage.removeItem(storageKey);
        } catch {
        }
        return null;
      }
      const next = pending?.code === match[1] ? pending : { code: match[1], userId: null };
      if (!writeStored(storage, next)) return null;
      pending = next;
    }
    if (!pending) return null;
    const invitation = Object.freeze({});
    invitations.set(invitation, { storage });
    return invitation;
  }
  function mountSponsorInvitation({ invitation, binding, document, onRedeemed } = {}) {
    const state = invitations.get(invitation), userId = binding?.userId;
    const active = () => {
      try {
        return binding?.userId === userId && binding.isActive() === true;
      } catch {
        return false;
      }
    };
    if (!state || !ownerPattern.test(userId || "") || typeof binding.request !== "function" || !active()) return null;
    const { storage } = state, pending = readStored(storage), studio = document?.getElementById("rigStudio"), main = studio?.querySelector("main");
    if (!pending || !studio || !main) return null;
    const element = document.createElement("section"), message = document.createElement("p"), button = document.createElement("button");
    element.className = "sponsor-invitation";
    element.setAttribute("aria-label", "Gratis testtegoed");
    element.style.cssText = "margin-top:18px;padding:14px 16px;border:1px solid #40685a;border-radius:10px;background:#192a23";
    message.setAttribute("role", "status");
    message.style.cssText = "margin:0 0 10px;line-height:1.5";
    message.textContent = "Je bent uitgenodigd om RIG te proberen. Je krijgt gratis \u20AC5 testtegoed om je video te maken.";
    button.type = "button";
    button.className = "primary";
    button.textContent = "Activeer gratis \u20AC5 testtegoed";
    element.append(message, button);
    studio.insertBefore(element, main);
    let busy = false, finished = false, disposed = false;
    const accountChanged = () => {
      button.hidden = true;
      message.textContent = "Deze uitnodiging hoort bij het account waarmee je het activeren bent gestart. Meld je aan met dat account.";
    };
    if (pending.userId !== null && pending.userId !== userId) accountChanged();
    async function activate() {
      if (busy || finished || disposed || !active()) return;
      const current = readStored(storage);
      if (!current || current.code !== pending.code) {
        button.hidden = true;
        return;
      }
      if (current.userId !== null && current.userId !== userId) {
        accountChanged();
        return;
      }
      const bound = { code: current.code, userId };
      if (!writeStored(storage, bound)) {
        message.textContent = "Je uitnodiging kon niet bewaard worden. Probeer dit tabblad opnieuw.";
        return;
      }
      busy = true;
      button.disabled = true;
      message.textContent = "Je gratis testtegoed wordt geactiveerd\u2026";
      try {
        if (!active()) return;
        const response = await binding.request("/api/sponsor-invitations/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ code: bound.code })
        });
        let body;
        try {
          body = await response.json();
        } catch {
          throw Error("retry");
        }
        if (response.ok && body?.state === "redeemed" && body.amountCents === 500) {
          clearStored(storage, bound);
          finished = true;
          button.hidden = true;
          if (disposed || !active()) return;
          message.textContent = "Je gratis \u20AC5 testtegoed is actief. Je kunt nu je video maken.";
          document.dispatchEvent(new document.defaultView.Event("rig-balance-changed"));
          if (typeof onRedeemed === "function") {
            try {
              await onRedeemed();
            } catch {
            }
          }
        } else if (response.ok && body?.state === "owner") {
          clearStored(storage, bound);
          finished = true;
          button.hidden = true;
          if (!disposed && active()) message.textContent = "Deze uitnodiging is voor je tester. Deel de uitnodigingslink met hem.";
        } else if ([200, 400, 404, 410].includes(response.status) && ["unavailable", "invalid", "expired"].includes(body?.state)) {
          clearStored(storage, bound);
          finished = true;
          button.hidden = true;
          if (!disposed && active()) message.textContent = "Deze uitnodiging is niet meer beschikbaar.";
        } else {
          throw Error("retry");
        }
      } catch {
        if (!disposed && active()) message.textContent = "Activeren kon nog niet worden bevestigd. Probeer opnieuw met ditzelfde account.";
      } finally {
        busy = false;
        button.disabled = finished || disposed || !active();
      }
    }
    const click = () => {
      void activate();
    };
    button.addEventListener("click", click);
    return { element, dispose() {
      disposed = true;
      button.removeEventListener("click", click);
      element.remove();
    } };
  }

  // frontend/multiuser/native-site-boot.mjs
  async function startNativeSiteApp({ window: browser, document = browser?.document, auth, loadScript } = {}) {
    const invitation = captureSponsorInvitation({ browser });
    const el = (id) => document.getElementById(id), status = el("authStatus"), inlineStatus = el("authInlineStatus"), gate = el("authGate"), studio = el("rigStudio");
    function anchor(id, href, text) {
      const current = el(id);
      if (!current) throw Error("RIG-pagina ontbreekt.");
      let link = current;
      if (current.tagName !== "A") {
        link = document.createElement("a");
        link.id = id;
        link.className = current.className;
        link.hidden = current.hidden;
        current.replaceWith(link);
      }
      link.href = href;
      link.target = "_top";
      link.textContent = text;
      return link;
    }
    const login = anchor("authLogin", "/signin-with-chatgpt?return_to=%2F", "Inloggen met ChatGPT"), logout = anchor("authLogout", "/signout-with-chatgpt", "Afmelden");
    auth ??= createNativeSiteAuth({ browser, fetchImpl: browser.fetch.bind(browser) });
    loadScript ??= ((name) => new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/multiuser/${name}`;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    }));
    let binding = null, unsubscribe = () => {
    }, invitationUi = null, ended = false;
    browser.rigNativeSite = true;
    browser.rigVideoEnabled = false;
    function endSession() {
      if (ended) return;
      ended = true;
      invitationUi?.dispose();
      binding?.dispose();
      unsubscribe();
      auth.dispose?.();
      studio.hidden = true;
      gate.hidden = false;
      login.hidden = false;
      logout.hidden = true;
      status.textContent = "Je aanmelding is gewijzigd. Meld je opnieuw aan.";
    }
    logout.addEventListener("click", () => {
      endSession();
    });
    const enable = async () => {
      const ready = await enableVideoIfAvailable({ binding, window: browser, document, loadScript });
      if (binding?.isActive()) el("videoAvailabilityNote").textContent = browser.rigVideoFunding === "sponsored" ? "Je video\u2019s worden betaald uit je gratis testtegoed. Je ziet de prijs v\xF3\xF3r je bevestigt." : ready ? "Je ziet de prijs v\xF3\xF3r je bevestigt. Een bevestigde video gebruikt echt fal-tegoed." : "Activeer je uitnodiging om een video te maken.";
      return ready;
    };
    try {
      if (!await auth.currentSession()) {
        status.textContent = "Meld je aan om RIG te gebruiken.";
        login.hidden = false;
        return { dispose: endSession };
      }
      const guarded = await prepareGuardedBinding({ auth, browser, onChanged: endSession });
      binding = guarded.binding;
      unsubscribe = guarded.stop;
      if (ended) {
        binding.dispose();
        unsubscribe();
        return { dispose: endSession };
      }
      browser.rigScopedStorage = binding.scopedStorage;
      browser.rigRequest = binding.request;
      browser.rigOpenVideo = binding.openVideo;
      browser.rigSessionActive = binding.isActive;
      browser.rigCheckout = () => {
        throw Error("Betalen is niet nodig tijdens deze test.");
      };
      logout.hidden = false;
      login.hidden = true;
      gate.hidden = true;
      studio.hidden = false;
      status.textContent = "Aangemeld bij RIG.";
      for (const name of ["media.js", "app.js"]) {
        await loadScript(name);
        if (!binding.isActive()) throw Error("Aanmelding gewijzigd.");
      }
      await enable();
      if (!binding.isActive()) throw Error("Aanmelding gewijzigd.");
      await loadScript("payments.js");
      if (!binding.isActive()) throw Error("Aanmelding gewijzigd.");
      invitationUi = mountSponsorInvitation({ invitation, binding, document, onRedeemed: enable });
      return { binding, dispose: endSession };
    } catch {
      if (!ended) (studio.hidden ? status : inlineStatus).textContent = "Aanmelden is momenteel niet beschikbaar. Probeer opnieuw.";
      return { dispose: endSession };
    }
  }
  if (typeof window !== "undefined" && window.document) void startNativeSiteApp({ window });
})();
