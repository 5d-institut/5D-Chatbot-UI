(function () {
  // ============================================================
  // KONFIGURATION
  // ============================================================

  // Produktions-URL des n8n WEBHOOK-Nodes
  var N8N_CHAT_URL = "https://n8nki.5d-institut.de/webhook/12a59f94-0b8f-4b5f-8ae4-55142c3bbcec";
  var AUTH_USER = "";
  var AUTH_PASS = "";
  var TIMEOUT_MS = 180000;
  
  // Aktiviertes Laden der Historie
  var LOAD_HISTORY = true;
  var GREETING = "Hallo! Ich beantworte Fragen zur RIB40-Datenbank - " +
    "z. B. zu Projekten, LV-Positionen und Einheitspreisen. Was möchtest du wissen?";

  // ============================================================
  // INITIALISIERUNG
  // ============================================================

  var elMsgs   = document.getElementById("mhc-messages");
  var elInput  = document.getElementById("mhc-input");
  var elSend   = document.getElementById("mhc-send");
  var elStatus = document.getElementById("mhc-status");
  var elError  = document.getElementById("mhc-error");

  var pending = false;
  var transcript = [];
  var sessionId = getSessionId();

  // marked.js configuration
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true, // translate newlines to <br>
      gfm: true     // Github Flavored Markdown (für Tabellen etc.)
    });
  }

  var transport = detectTransport();
  setStatus("bereit · " + transport.name);

  elSend.addEventListener("click", send);
  elInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  loadHistory(function (restoredCount) {
    if (restoredCount === 0 && GREETING) {
      addMessage("bot", GREETING, true);
    }
    elInput.focus();
  });

  // ============================================================
  // TRANSPORT: AngularJS $http -> jQuery $.ajax -> natives XHR
  // ============================================================

  function detectTransport() {
    var ng = null, ngWhere = "";
    try {
      if (window.parent && window.parent !== window && window.parent.angular) {
        ng = window.parent.angular; ngWhere = "parent";
      }
    } catch (e) {}
    if (!ng) {
      try { if (window.angular) { ng = window.angular; ngWhere = "eigen"; } } catch (e) {}
    }
    if (ng) {
      var $http = getAngularHttp(ng, ngWhere);
      if ($http) return { name: "angular/" + ngWhere, send: makeAngularSend($http) };
    }

    var jq = null, jqWhere = "";
    try {
      if (window.parent && window.parent !== window) {
        if (window.parent.jQuery && window.parent.jQuery.ajax) { jq = window.parent.jQuery; jqWhere = "parent"; }
        else if (window.parent.$ && window.parent.$.ajax) { jq = window.parent.$; jqWhere = "parent"; }
      }
    } catch (e) {}
    if (!jq) {
      try {
        if (window.jQuery && window.jQuery.ajax) { jq = window.jQuery; jqWhere = "eigen"; }
        else if (window.$ && window.$.ajax) { jq = window.$; jqWhere = "eigen"; }
      } catch (e) {}
    }
    if (jq) return { name: "jquery/" + jqWhere, send: makeJqSend(jq) };

    return { name: "xhr", send: xhrSend };
  }

  function getAngularHttp(ng, where) {
    try { return ng.injector(["ng"]).get("$http"); } catch (e) {}
    try {
      var doc = (where === "parent") ? window.parent.document : document;
      var inj = ng.element(doc.body).injector();
      if (inj) return inj.get("$http");
    } catch (e) {}
    return null;
  }

  function makeAngularSend($http) {
    return function (url, payload, succeed, fail) {
      var cfg = { headers: { "Content-Type": "application/json" }, timeout: TIMEOUT_MS };
      if (AUTH_USER) cfg.headers["Authorization"] = "Basic " + btoa(AUTH_USER + ":" + AUTH_PASS);
      try {
        $http.post(url, payload, cfg).then(
          function (resp) { succeed(resp ? resp.data : null); },
          function (resp) {
            var st = resp ? resp.status : 0;
            if (st === -1 || st === 0) {
              fail("Keine Verbindung oder Timeout");
            } else {
              fail("HTTP " + st + " " + ((resp && resp.statusText) || ""));
            }
          }
        );
      } catch (e) { fail("Fehler: " + e.message); }
    };
  }

  function makeJqSend(jq) {
    return function (url, payload, succeed, fail) {
      var opts = {
        url: url, type: "POST", method: "POST",
        contentType: "application/json", data: JSON.stringify(payload), dataType: "text",
        timeout: TIMEOUT_MS,
        success: function (txt) { succeed(txt); },
        error: function (xhr, textStatus) {
          if (textStatus === "timeout") fail("Zeitüberschreitung");
          else if (xhr && xhr.status) fail("HTTP " + xhr.status);
          else fail("Keine Verbindung");
        }
      };
      if (AUTH_USER) opts.headers = { "Authorization": "Basic " + btoa(AUTH_USER + ":" + AUTH_PASS) };
      try { jq.ajax(opts); } catch (e) { fail("Fehler: " + e.message); }
    };
  }

  function xhrSend(url, payload, succeed, fail) {
    var xhr = new XMLHttpRequest();
    try {
      xhr.open("POST", url, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      if (AUTH_USER) xhr.setRequestHeader("Authorization", "Basic " + btoa(AUTH_USER + ":" + AUTH_PASS));
      xhr.timeout = TIMEOUT_MS;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) succeed(xhr.responseText);
        else if (xhr.status === 0) fail("Keine Verbindung");
        else fail("HTTP " + xhr.status);
      };
      xhr.ontimeout = function () { fail("Zeitüberschreitung"); };
      xhr.onerror = function () { fail("Keine Verbindung"); };
      xhr.send(JSON.stringify(payload));
    } catch (e) { fail("Fehler: " + e.message); }
  }

  function postJson(url, payload, onSuccess, onError) {
    var settled = false;
    transport.send(
      url, payload,
      function (raw) {
        if (settled) return;
        settled = true;
        var data;
        try { data = (typeof raw === "string") ? JSON.parse(raw) : raw; } catch (e) { data = raw; }
        onSuccess(data);
      },
      function (msg) {
        if (settled) return;
        settled = true;
        onError(new Error(msg));
      }
    );
  }

  // ============================================================
  // CHAT-LOGIK
  // ============================================================

  function send() {
    if (pending) return;
    var text = elInput.value.replace(/\s+$/, "");
    if (!text) return;

    clearError();
    elInput.value = "";
    
    // Resize textarea back to default
    elInput.style.height = 'auto';

    addMessage("user", text, false);

    pending = true;
    elSend.disabled = true;
    setStatus("Agent arbeitet ... · " + transport.name);
    showTyping();

    postJson(
      N8N_CHAT_URL,
      { action: "sendMessage", sessionId: sessionId, chatInput: text },
      function (data) {
        addMessage("bot", extractAnswer(data), false);
        finishRequest();
      },
      function (err) {
        showError("Verbindungsfehler: " + err.message);
        finishRequest();
      }
    );
  }

  function finishRequest() {
    pending = false;
    elSend.disabled = false;
    setStatus("bereit · " + transport.name);
    hideTyping();
    elInput.focus();
  }

  function loadHistory(done) {
    if (!LOAD_HISTORY) { done(0); return; }
    postJson(
      N8N_CHAT_URL,
      { action: "loadPreviousSession", sessionId: sessionId },
      function (data) {
        var arr = (data && data.data) || [];
        var n = 0;
        for (var i = 0; i < arr.length; i++) {
          var m = arr[i];
          var content = m && m.kwargs && m.kwargs.content;
          if (!content) continue;
          var idStr = (m.id && m.id.join) ? m.id.join(",") : "";
          addMessage(idStr.indexOf("HumanMessage") >= 0 ? "user" : "bot", content, true);
          n++;
        }
        done(n);
      },
      function () { done(0); }
    );
  }

  // ============================================================
  // DARSTELLUNG
  // ============================================================

  function addMessage(role, text, skipPersist) {
    var wrap = document.createElement("div");
    wrap.className = "mhc-msg mhc-" + role;

    var bubble = document.createElement("div");
    bubble.className = "mhc-bubble";
    
    var formattedText = formatText(text);
    bubble.innerHTML = formattedText;

    // Enhance tables with export button
    var tables = bubble.querySelectorAll("table");
    if (tables.length > 0) {
      tables.forEach(function(table) {
        var exportBtn = document.createElement("button");
        exportBtn.className = "mhc-table-export-btn";
        exportBtn.innerHTML = '<i class="fa-solid fa-file-csv"></i> Als CSV exportieren';
        exportBtn.onclick = function() {
          exportTableToCSV(table, "5D_Institut_Export_" + Date.now() + ".csv");
        };
        table.parentNode.insertBefore(exportBtn, table);
      });
    }

    var time = document.createElement("div");
    time.className = "mhc-time";
    time.textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    elMsgs.appendChild(wrap);
    elMsgs.scrollTop = elMsgs.scrollHeight;

    if (!skipPersist) {
      transcript.push({ role: role, text: text });
      persistToContext(role, text);
    }
  }

  function showTyping() {
    var t = document.createElement("div");
    t.className = "mhc-msg mhc-bot";
    t.id = "mhc-typing-row";
    t.innerHTML = '<div class="mhc-bubble mhc-typing"><span></span><span></span><span></span></div>';
    elMsgs.appendChild(t);
    elMsgs.scrollTop = elMsgs.scrollHeight;
  }

  function hideTyping() {
    var t = document.getElementById("mhc-typing-row");
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }

  function formatText(s) {
    if (typeof marked !== 'undefined') {
      // Use marked library if available for robust markdown rendering
      return marked.parse(s);
    }
    
    // Fallback if marked is missing
    var t = escapeHtml(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\n/g, "<br>");
    return t;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(t) { elStatus.textContent = t; }
  function showError(msg) { elError.textContent = msg; elError.style.display = "block"; }
  function clearError() { elError.style.display = "none"; }

  // ============================================================
  // CSV EXPORT LOGIK
  // ============================================================
  
  function exportTableToCSV(table, filename) {
    var csv = [];
    var rows = table.querySelectorAll("tr");
    
    for (var i = 0; i < rows.length; i++) {
        var row = [], cols = rows[i].querySelectorAll("td, th");
        for (var j = 0; j < cols.length; j++) {
            // Remove double quotes and escape existing quotes
            var data = cols[j].innerText.replace(/"/g, '""');
            row.push('"' + data + '"');
        }
        csv.push(row.join(","));
    }
    
    downloadCSV(csv.join("\n"), filename);
  }

  function downloadCSV(csv, filename) {
    var csvFile;
    var downloadLink;
    
    // CSV File
    var BOM = "\uFEFF"; // Adds BOM for Excel UTF-8 encoding
    csvFile = new Blob([BOM + csv], {type: "text/csv;charset=utf-8;"});
    
    // Download link
    downloadLink = document.createElement("a");
    downloadLink.download = filename;
    downloadLink.href = window.URL.createObjectURL(csvFile);
    downloadLink.style.display = "none";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
  }

  // ============================================================
  // ANTWORT / SESSION / CONTEXT
  // ============================================================

  function extractAnswer(data) {
    if (data === null || data === undefined) return "(leere Antwort)";
    if (typeof data === "string") return data;
    if (Object.prototype.toString.call(data) === "[object Array]") {
      return data.length ? extractAnswer(data[0]) : "(leere Antwort)";
    }
    if (typeof data.output === "string") return data.output;
    if (typeof data.text === "string") return data.text;
    if (typeof data.message === "string") return data.message;
    if (data.json) return extractAnswer(data.json);
    try { return JSON.stringify(data); } catch (e) { return String(data); }
  }

  function getCtx() {
    try { if (typeof Context !== "undefined" && Context) return Context; } catch (e) {}
    try { if (window.parent && window.parent.Context) return window.parent.Context; } catch (e) {}
    return null;
  }

  // Persist session ID to simulate a logged-in user until xdhub integration
  function getSessionId() {
    var ctx = getCtx();
    if (ctx && ctx.ChatSessionId) {
      return String(ctx.ChatSessionId);
    }
    
    // Use localStorage to maintain session across reloads
    var storedId = localStorage.getItem("itwo_chatbot_session");
    if (storedId) {
      return storedId;
    }
    
    var newId = genId();
    localStorage.setItem("itwo_chatbot_session", newId);
    
    if (ctx) {
      try { ctx.ChatSessionId = newId; } catch (e) {}
    }
    
    return newId;
  }

  function genId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    return "itwo-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  }

  function persistToContext(role, text) {
    var ctx = getCtx();
    if (!ctx) return;
    try {
      var lines = [];
      for (var i = 0; i < transcript.length; i++) {
        lines.push((transcript[i].role === "user" ? "Nutzer: " : "Agent: ") + transcript[i].text);
      }
      ctx.ChatTranscript = lines.join("\n");
      if (role === "bot") ctx.ChatLastAnswer = text;
    } catch (e) { }
  }

  // Textarea auto-resize
  elInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });
})();
