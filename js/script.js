/**
 * script.js — Main Application Logic
 * 5D Institut · AI Chatbot
 * =====================================================================
 * Responsibilities:
 *  1. Auth guard  — redirects to login.html if no token in localStorage
 *  2. UI boot     — renders user info, history list, admin controls
 *  3. Chat logic  — sends messages, handles responses (n8n webhook)
 *  4. History     — persists conversations in localStorage, renders list
 *  5. Transport   — AngularJS $http → jQuery $.ajax → native XHR fallback
 *  6. Rendering   — formats Markdown, attaches CSV export to tables
 *  7. Dark mode   — persists theme preference in localStorage
 *  8. Export      — TXT and PDF (print) export of conversations
 *  9. Delete      — per-conversation delete with inline confirmation
 * =====================================================================
 */
(function () {

  // ==================================================================
  // CONFIGURATION — edit these values to change app behaviour
  // ==================================================================

  /** n8n Webhook URL — must use /webhook/ (not /webhook-test/) for active workflows */
  var N8N_CHAT_URL = localStorage.getItem('admin_webhook_url') ||
    'https://n8nki.5d-institut.de/webhook/f6af1b9e-8eec-414b-b523-e73f65c8f799';

  /** JWT credential secret for n8n webhook authentication (HS256) */
  var JWT_SECRET = '5T9{z3Bn$98&';

  /** Cached JWT token (generated once per session) */
  var _jwtBearer = null;

  /** Request timeout in milliseconds (local LLMs can be slow) */
  var TIMEOUT_MS = parseInt(localStorage.getItem('admin_timeout'), 10) || 180000;

  /** Whether to attempt loading previous session messages from n8n memory.
   *  Only works with Chat Trigger nodes, not plain Webhook nodes. */
  var LOAD_HISTORY_FROM_N8N = false;

  /** Default greeting shown when a new chat has no messages */
  var GREETING =
    'Hello! I can answer questions about the database — ' +
    'for example about projects, LV positions, and unit prices. What would you like to know?';

  /** localStorage key for the list of saved conversations */
  var STORAGE_KEY_CONVERSATIONS = '5d_conversations';

  // ==================================================================
  // AUTH GUARD — redirect to login if not authenticated
  // ==================================================================

  var jwtToken = localStorage.getItem('jwt_token');
  if (!jwtToken) {
    window.location.href = 'login.html';
    // Halt script — nothing below should run without a token
    throw new Error('[5D App] Not authenticated — redirecting to login.');
  }

  // ==================================================================
  // DOM REFERENCES
  // ==================================================================

  var elMsgs = document.getElementById('mhc-messages');
  var elInput = document.getElementById('mhc-input');
  var elSend = document.getElementById('mhc-send');
  var elStatus = document.getElementById('mhc-status');
  var elError = document.getElementById('mhc-error');
  var elWelcome = document.getElementById('chat-welcome');
  var elHistory = document.getElementById('sidebar-history');
  var elBtnNewChat = document.getElementById('btn-new-chat');
  var elBtnSignout = document.getElementById('btn-signout');
  var elBtnMenu = document.getElementById('btn-menu');
  var elSidebar = document.getElementById('sidebar');
  var elOverlay = document.getElementById('sidebar-overlay');
  var elChatTitle = document.getElementById('chat-title');

  // Admin panel DOM nodes
  var elBtnAdminSettings = document.getElementById('btn-admin-settings');
  var elAdminPanel = document.getElementById('admin-panel');
  var elBtnAdminClose = document.getElementById('btn-admin-close');
  var elBtnAdminSave = document.getElementById('btn-admin-save');
  var elAdminWebhookUrl = document.getElementById('admin-webhook-url');
  var elAdminTimeout = document.getElementById('admin-timeout');

  // Dark mode DOM nodes
  var elBtnDarkMode = document.getElementById('btn-dark-mode');

  // Delete confirmation popover
  var elDeletePopover = document.getElementById('delete-confirm-popover');
  var elDeleteConfirmYes = document.getElementById('delete-confirm-yes');
  var elDeleteConfirmNo = document.getElementById('delete-confirm-no');

  // ==================================================================
  // APPLICATION STATE
  // ==================================================================

  var pending = false;           // true while a request is in flight
  var requestStartTime = 0;      // timestamp (ms) set when a request begins
  var sessionId = '';            // current n8n session ID (UUID)
  var currentConvId = null;           // ID of the currently displayed conversation
  var conversations = loadConversations(); // array of { id, title, date, messages[] }

  // Delete popover state
  var pendingDeleteId = null;       // conversation ID awaiting delete confirmation
  var pendingDeleteWrap = null;       // the DOM wrap element for the item being deleted

  // ==================================================================
  // MARKED.JS CONFIGURATION (Markdown rendering)
  // ==================================================================

  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,  // convert newlines to <br>
      gfm: true   // enable GitHub Flavored Markdown (tables, etc.)
    });
  }

  // ==================================================================
  // TRANSPORT DETECTION
  // Priority: AngularJS $http → jQuery $.ajax → native XHR
  // ==================================================================

  var transport = detectTransport();
  setStatus('Ready');

  /**
   * Determines the best available HTTP transport in the current context.
   * Checks for AngularJS and jQuery in both the current window and its parent
   * (useful when embedded inside iTWO as an iframe).
   * Falls back to native XMLHttpRequest if neither is found.
   */
  function detectTransport() {
    // 1) Try AngularJS — preferred inside iTWO, avoids CORS issues with $http
    var ng = null, ngWhere = '';
    try {
      if (window.parent && window.parent !== window && window.parent.angular) {
        ng = window.parent.angular; ngWhere = 'parent';
      }
    } catch (e) { }
    if (!ng) {
      try { if (window.angular) { ng = window.angular; ngWhere = 'own'; } } catch (e) { }
    }
    if (ng) {
      var $http = getAngularHttp(ng, ngWhere);
      if ($http) return { name: 'angular/' + ngWhere, send: makeAngularSend($http) };
    }

    // 2) Try jQuery
    var jq = null, jqWhere = '';
    try {
      if (window.parent && window.parent !== window) {
        if (window.parent.jQuery && window.parent.jQuery.ajax) { jq = window.parent.jQuery; jqWhere = 'parent'; }
        else if (window.parent.$ && window.parent.$.ajax) { jq = window.parent.$; jqWhere = 'parent'; }
      }
    } catch (e) { }
    if (!jq) {
      try {
        if (window.jQuery && window.jQuery.ajax) { jq = window.jQuery; jqWhere = 'own'; }
        else if (window.$ && window.$.ajax) { jq = window.$; jqWhere = 'own'; }
      } catch (e) { }
    }
    if (jq) return { name: 'jquery/' + jqWhere, send: makeJqSend(jq) };

    // 3) Fallback — native XHR
    return { name: 'xhr', send: xhrSend };
  }

  // ==================================================================
  // JWT BEARER TOKEN GENERATION (HS256 — Web Crypto API)
  // ==================================================================

  /**
   * Returns a cached JWT bearer token signed with JWT_SECRET (HS256).
   * The token is valid for 1 hour from first call.
   * Uses the Web Crypto API (available in all modern browsers).
   * Falls back to null (no auth header) if Crypto API is unavailable.
   *
   * n8n JWT credential config:
   *   Key Type : Passphrase  →  NOT used on our side
   *   Secret   : JWT_SECRET  →  shared HS256 signing key
   *   Algorithm: HS256
   */
  function getJwtBearer() {
    // Return cached token if still within its validity window
    if (_jwtBearer) return _jwtBearer;

    // Build JWT synchronously via TextEncoder + Web Crypto SubtleCrypto
    // NOTE: SubtleCrypto.sign is async, so we generate the token once at boot
    // and store the Promise result; subsequent calls always return the cached value.
    // For simplicity we create a *pre-signed* token string using pure JS HS256.
    try {
      _jwtBearer = buildHs256Jwt(JWT_SECRET);
    } catch (e) {
      console.warn('[5D Auth] JWT generation failed — requests will be sent without auth header:', e);
      _jwtBearer = '';
    }
    return _jwtBearer;
  }

  /**
   * Builds a compact HS256-signed JWT using pure synchronous JS.
   * Uses btoa + TextEncoder + SubtleCrypto importKey/sign (async-free workaround
   * via XHR sync trick is NOT used — instead we use a pure-JS HMAC-SHA256).
   *
   * Because SubtleCrypto is async, this implementation uses a minimal pure-JS
   * HMAC-SHA256 so that the token is available synchronously.
   *
   * @param {string} secret - The HS256 signing key
   * @returns {string} JWT compact serialisation
   */
  function buildHs256Jwt(secret) {
    var header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    var now = Math.floor(Date.now() / 1000);
    var payload = b64url(JSON.stringify({ iat: now, exp: now + 3600, iss: '5d-chatbot' }));
    var data = header + '.' + payload;
    var sig = b64url(hmacSha256(secret, data));
    return data + '.' + sig;
  }

  /** Base64URL-encodes a string (UTF-8 safe). */
  function b64url(str) {
    // Convert to UTF-8 bytes, then base64, then make URL-safe
    var bytes;
    if (typeof TextEncoder !== 'undefined') {
      bytes = new TextEncoder().encode(str);
    } else {
      // Legacy fallback
      bytes = unescape(encodeURIComponent(str)).split('').map(function (c) { return c.charCodeAt(0); });
    }
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Pure-JS HMAC-SHA256.
   * Returns a raw binary string (bytes as chars) suitable for base64 encoding.
   * Based on the well-known RFC 2104 + SHA-256 reference implementation.
   */
  function hmacSha256(key, data) {
    function sha256(msg) {
      var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ];
      var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

      // Convert string to byte array
      var bytes = [];
      for (var i = 0; i < msg.length; i++) {
        var c = msg.charCodeAt(i);
        if (c < 0x80) { bytes.push(c); }
        else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
        else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
      }
      var l = bytes.length * 8;
      bytes.push(0x80);
      while (bytes.length % 64 !== 56) bytes.push(0);
      bytes.push(0, 0, 0, 0, (l >>> 24) & 0xff, (l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff);

      for (var blk = 0; blk < bytes.length; blk += 64) {
        var w = [];
        for (var j = 0; j < 16; j++) w[j] = (bytes[blk + j * 4] << 24) | (bytes[blk + j * 4 + 1] << 16) | (bytes[blk + j * 4 + 2] << 8) | bytes[blk + j * 4 + 3];
        for (var j = 16; j < 64; j++) {
          var s0 = ror(w[j - 15], 7) ^ ror(w[j - 15], 18) ^ (w[j - 15] >>> 3);
          var s1 = ror(w[j - 2], 17) ^ ror(w[j - 2], 19) ^ (w[j - 2] >>> 10);
          w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (var j = 0; j < 64; j++) {
          var S1 = (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25));
          var ch = (e & f) ^ (~e & g);
          var t1 = (h + S1 + ch + K[j] + w[j]) | 0;
          var S0 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22));
          var maj = (a & b) ^ (a & c) ^ (b & c);
          var t2 = (S0 + maj) | 0;
          h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
      }
      var out = '';
      for (var i = 0; i < 8; i++) { out += String.fromCharCode((H[i] >>> 24) & 0xff, (H[i] >>> 16) & 0xff, (H[i] >>> 8) & 0xff, H[i] & 0xff); }
      return out;
    }

    function ror(x, n) { return (x >>> n) | (x << (32 - n)); }

    // Normalise key to byte array (binary string)
    var keyBytes = '';
    for (var i = 0; i < key.length; i++) keyBytes += String.fromCharCode(key.charCodeAt(i) & 0xff);
    if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
    // Pad key
    while (keyBytes.length < 64) keyBytes += '\x00';

    var ipad = '', opad = '';
    for (var i = 0; i < 64; i++) {
      ipad += String.fromCharCode(keyBytes.charCodeAt(i) ^ 0x36);
      opad += String.fromCharCode(keyBytes.charCodeAt(i) ^ 0x5c);
    }
    return sha256(opad + sha256(ipad + data));
  }

  function getAngularHttp(ng, where) {
    // Prefer a fresh injector with only the 'ng' module to avoid iTWO interceptors
    try { return ng.injector(['ng']).get('$http'); } catch (e) { }
    try {
      var doc = (where === 'parent') ? window.parent.document : document;
      var inj = ng.element(doc.body).injector();
      if (inj) return inj.get('$http');
    } catch (e) { }
    return null;
  }

  function makeAngularSend($http) {
    return function (url, payload, succeed, fail) {
      var cfg = { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS };
      try {
        $http.post(url, payload, cfg).then(
          function (resp) { succeed(resp ? resp.data : null); },
          function (resp) {
            var st = resp ? resp.status : 0;
            fail(st === -1 || st === 0
              ? 'No connection or timeout'
              : 'HTTP ' + st + ' ' + ((resp && resp.statusText) || ''));
          }
        );
      } catch (e) { fail('Request error: ' + e.message); }
    };
  }

  function makeJqSend(jq) {
    return function (url, payload, succeed, fail) {
      var opts = {
        url: url, type: 'POST', method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify(payload),
        dataType: 'text',      // parse manually — robust against plain text replies
        timeout: TIMEOUT_MS,
        success: function (txt) { succeed(txt); },
        error: function (xhr, textStatus) {
          if (textStatus === 'timeout') fail('Request timeout — agent did not respond within ' + Math.round(TIMEOUT_MS / 1000) + 's');
          else if (xhr && xhr.status) fail('HTTP ' + xhr.status + ' ' + (xhr.statusText || ''));
          else fail('No connection');
        }
      };
      try { jq.ajax(opts); } catch (e) { fail('Request error: ' + e.message); }
    };
  }

  function xhrSend(url, payload, succeed, fail) {
    var xhr = new XMLHttpRequest();
    try {
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = TIMEOUT_MS;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) succeed(xhr.responseText);
        else if (xhr.status === 0) fail('No connection — check network, HTTPS, or CORS settings');
        else fail('HTTP ' + xhr.status + ' ' + (xhr.statusText || ''));
      };
      xhr.ontimeout = function () { fail('Request timeout — agent did not respond within ' + Math.round(TIMEOUT_MS / 1000) + 's'); };
      xhr.onerror = function () { fail('No connection'); };
      xhr.send(JSON.stringify(payload));
    } catch (e) { fail('Request error: ' + e.message); }
  }

  /**
   * Dispatches a JSON POST request via the detected transport.
   * Guarantees exactly one callback is fired (succeed or fail).
   */
  function postJson(url, payload, onSuccess, onError) {
    var settled = false;
    transport.send(
      url, payload,
      function (raw) {
        if (settled) return;
        settled = true;
        var data;
        try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { data = raw; }
        onSuccess(data);
      },
      function (msg) {
        if (settled) return;
        settled = true;
        onError(new Error(msg));
      }
    );
  }

  // ==================================================================
  // USER INFO — render name, role, company, avatar in sidebar
  // ==================================================================

  /** Boots the sidebar user section from localStorage values. */
  function bootUserInfo() {
    var name = localStorage.getItem('user_display_name') || 'User';
    var role = localStorage.getItem('user_role') || 'customer';
    var company = localStorage.getItem('user_company') || '';

    // Avatar: first letter of each word (max 2 chars)
    var initials = name.split(' ')
      .map(function (w) { return w[0]; })
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();

    document.getElementById('sidebar-user-avatar').textContent = initials;
    document.getElementById('sidebar-user-name').textContent = name;
    document.getElementById('sidebar-user-role').textContent = role.charAt(0).toUpperCase() + role.slice(1);
    document.getElementById('sidebar-user-company').textContent = company;

    // Show admin-only UI elements
    if (role === 'administrator') {
      elBtnAdminSettings.style.display = 'grid';
    }
  }

  // ==================================================================
  // DARK MODE — toggle & persist
  // ==================================================================

  /**
   * Applies the given theme ('light' or 'dark') to the page and
   * updates the toggle button icon accordingly.
   * @param {string} theme - 'light' | 'dark'
   */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var isDark = theme === 'dark';
    elBtnDarkMode.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    if (isDark) {
      elBtnDarkMode.classList.add('dark-active');
      elBtnDarkMode.title = 'Switch to light mode';
    } else {
      elBtnDarkMode.classList.remove('dark-active');
      elBtnDarkMode.title = 'Switch to dark mode';
    }
  }

  /** Reads persisted theme from localStorage on boot. */
  function bootTheme() {
    var saved = localStorage.getItem('5d_theme') || 'light';
    applyTheme(saved);
  }

  elBtnDarkMode.addEventListener('click', function () {
    var current = document.documentElement.getAttribute('data-theme') || 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('5d_theme', next);
  });

  // ==================================================================
  // CONVERSATION HISTORY — localStorage persistence
  // ==================================================================

  /**
   * Loads the list of saved conversations from localStorage.
   * Returns an array of conversation objects (newest first).
   * @returns {Array}
   */
  function loadConversations() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_CONVERSATIONS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('[5D App] Could not parse conversations from storage:', e);
      return [];
    }
  }

  /**
   * Saves the conversations array back to localStorage.
   */
  function saveConversations() {
    try {
      localStorage.setItem(STORAGE_KEY_CONVERSATIONS, JSON.stringify(conversations));
    } catch (e) {
      console.warn('[5D App] Could not save conversations to storage:', e);
    }
  }

  /**
   * Updates the chat header title to reflect the current conversation.
   * @param {string} [title] - Title to display. Falls back to 'AI Assistant'.
   */
  function updateHeaderTitle(title) {
    elChatTitle.textContent = title || 'AI Assistant';
  }

  /**
   * Renders the conversation history list in the sidebar.
   * Each item shows the conversation title, date, and a delete button.
   */
  function renderHistoryList() {
    elHistory.innerHTML = '';

    if (!conversations.length) {
      var empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No conversations yet.';
      elHistory.appendChild(empty);
      return;
    }

    conversations.forEach(function (conv) {
      // Outer wrapper — needed for the absolute-positioned delete button
      var wrap = document.createElement('div');
      wrap.className = 'history-item-wrap';

      // Main clickable item button
      var item = document.createElement('button');
      item.className = 'history-item' + (conv.id === currentConvId ? ' active' : '');
      item.dataset.id = conv.id;
      item.type = 'button';

      var icon = document.createElement('div');
      icon.className = 'history-item-icon';
      icon.innerHTML = '<i class="fa-regular fa-message"></i>';

      var body = document.createElement('div');
      body.className = 'history-item-body';

      var title = document.createElement('div');
      title.className = 'history-item-title';
      title.textContent = conv.title || 'Untitled conversation';

      var date = document.createElement('div');
      date.className = 'history-item-date';
      date.textContent = formatRelativeDate(conv.date);

      body.appendChild(title);
      body.appendChild(date);
      item.appendChild(icon);
      item.appendChild(body);

      item.addEventListener('click', function () {
        loadConversation(conv.id);
        closeMobileSidebar();
      });

      // Delete button
      var delBtn = document.createElement('button');
      delBtn.className = 'history-item-delete';
      delBtn.type = 'button';
      delBtn.title = 'Delete conversation';
      delBtn.setAttribute('aria-label', 'Delete conversation');
      delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';

      delBtn.addEventListener('click', function (e) {
        e.stopPropagation(); // don't trigger the item click
        showDeleteConfirm(conv.id, wrap);
      });

      wrap.appendChild(item);
      wrap.appendChild(delBtn);
      elHistory.appendChild(wrap);
    });
  }

  /**
   * Opens an existing conversation in the main chat area.
   * Replaces the current messages with the stored ones.
   * @param {string} id - The conversation ID to load
   */
  function loadConversation(id) {
    var conv = conversations.find(function (c) { return c.id === id; });
    if (!conv) return;

    currentConvId = id;
    sessionId = conv.sessionId || genId();

    // Clear the UI
    elMsgs.innerHTML = '';
    clearError();

    // Replay messages
    conv.messages.forEach(function (msg) {
      renderMessage(msg.role, msg.text, msg.time);
    });

    // Switch from welcome screen to message list
    showChatArea();
    renderHistoryList();
    updateHeaderTitle(conv.title);
  }

  /**
   * Creates a new, blank conversation and starts fresh.
   */
  function startNewConversation() {
    sessionId = genId();
    currentConvId = null;
    elMsgs.innerHTML = '';
    clearError();
    showWelcomeScreen();
    renderHistoryList();
    updateHeaderTitle('AI Assistant');
    elInput.focus();
  }

  /**
   * Appends a message to the current conversation record and
   * saves it to localStorage. Creates a new conversation if none
   * is active yet.
   * @param {string} role - 'user' | 'bot'
   * @param {string} text - The message content
   * @param {string} time - Formatted time string
   */
  function persistMessage(role, text, time) {
    var msg = { role: role, text: text, time: time };

    if (currentConvId) {
      // Append to existing conversation
      var conv = conversations.find(function (c) { return c.id === currentConvId; });
      if (conv) {
        conv.messages.push(msg);
        // Update title if it's still the default (use first user message)
        if (conv.title === 'New conversation' && role === 'user') {
          conv.title = text.length > 48 ? text.slice(0, 48) + '…' : text;
          updateHeaderTitle(conv.title);
        }
        conv.date = new Date().toISOString();
      }
    } else {
      // Create a new conversation record
      var newConv = {
        id: genId(),
        sessionId: sessionId,
        title: role === 'user'
          ? (text.length > 48 ? text.slice(0, 48) + '…' : text)
          : 'New conversation',
        date: new Date().toISOString(),
        messages: [msg]
      };
      conversations.unshift(newConv); // newest first
      currentConvId = newConv.id;
      updateHeaderTitle(newConv.title);
    }

    saveConversations();
    renderHistoryList();
  }

  // ==================================================================
  // DELETE CONVERSATION — with inline popover confirmation
  // ==================================================================

  /**
   * Positions and shows the delete confirmation popover near the
   * given DOM element, recording the conversation ID to delete.
   * @param {string}  convId   - Conversation ID to potentially delete
   * @param {Element} wrapEl   - The .history-item-wrap element for positioning
   */
  function showDeleteConfirm(convId, wrapEl) {
    // If clicking the same item again, hide (toggle)
    if (pendingDeleteId === convId && elDeletePopover.style.display !== 'none') {
      hideDeleteConfirm();
      return;
    }

    pendingDeleteId = convId;
    pendingDeleteWrap = wrapEl;

    // Position popover below the item wrap
    var rect = wrapEl.getBoundingClientRect();
    elDeletePopover.style.display = 'flex';
    elDeletePopover.removeAttribute('aria-hidden');

    // Compute position — show below the item, aligned left
    var top = rect.bottom + window.scrollY + 4;
    var left = rect.left + window.scrollX;

    elDeletePopover.style.top = top + 'px';
    elDeletePopover.style.left = left + 'px';

    // Ensure it doesn't overflow the right edge of the viewport
    var popWidth = elDeletePopover.offsetWidth || 210;
    if (left + popWidth > window.innerWidth - 8) {
      elDeletePopover.style.left = (window.innerWidth - popWidth - 8) + 'px';
    }
  }

  /** Hides the delete confirmation popover and clears state. */
  function hideDeleteConfirm() {
    elDeletePopover.style.display = 'none';
    elDeletePopover.setAttribute('aria-hidden', 'true');
    pendingDeleteId = null;
    pendingDeleteWrap = null;
  }

  /**
   * Deletes a conversation by ID, persists the change, and refreshes
   * the sidebar. If the deleted conversation was active, shows the
   * welcome screen.
   * @param {string} id - Conversation ID to delete
   */
  function deleteConversation(id) {
    conversations = conversations.filter(function (c) { return c.id !== id; });
    saveConversations();

    if (currentConvId === id) {
      currentConvId = null;
      elMsgs.innerHTML = '';
      clearError();
      showWelcomeScreen();
      updateHeaderTitle('AI Assistant');
    }

    renderHistoryList();
    hideDeleteConfirm();
  }

  // Confirm delete
  elDeleteConfirmYes.addEventListener('click', function () {
    if (pendingDeleteId) {
      deleteConversation(pendingDeleteId);
    }
  });

  // Cancel delete
  elDeleteConfirmNo.addEventListener('click', hideDeleteConfirm);

  // Close popover when clicking outside
  document.addEventListener('click', function (e) {
    if (
      elDeletePopover.style.display !== 'none' &&
      !elDeletePopover.contains(e.target) &&
      !e.target.closest('.history-item-delete')
    ) {
      hideDeleteConfirm();
    }
  });

  // ==================================================================
  // CHAT LOGIC — sending and receiving messages
  // ==================================================================

  /**
   * Sends the current textarea content to the n8n webhook.
   * Manages loading state, typing indicator, and error handling.
   */
  function send() {
    if (pending) return;

    var text = elInput.value.replace(/\s+$/, '');
    if (!text) return;

    clearError();
    elInput.value = '';
    elInput.style.height = 'auto'; // reset auto-resize

    // Show the message list area (hides the welcome screen)
    showChatArea();

    // Render the user's message immediately
    addMessage('user', text);

    pending = true;
    elSend.disabled = true;
    requestStartTime = Date.now();
    setStatus('Agent working…', true);
    showTyping();

    // Build payload — include role so n8n can apply role-based data access
    var payload = {
      action:    'sendMessage',
      sessionId: sessionId,
      chatInput: text,
      userRole:  localStorage.getItem('user_role')  || 'customer',
      userLogin: localStorage.getItem('user_login') || ''
    };

    postJson(
      N8N_CHAT_URL,
      payload,
      function (data) {
        var elapsedMs = Date.now() - requestStartTime;
        addMessage('bot', extractAnswer(data), elapsedMs);
        finishRequest();
      },
      function (err) {
        showError(
          'Connection error: ' + err.message +
          ' — Is the n8n workflow active and CORS enabled on the webhook?'
        );
        finishRequest();
      }
    );
  }

  /** Resets UI state after a request completes (success or error). */
  function finishRequest() {
    pending = false;
    elSend.disabled = false;
    setStatus('Ready', false);
    hideTyping();
    elInput.focus();
  }

  /**
   * Optionally loads the previous session from n8n memory.
   * Only functional when using Chat Trigger nodes (not plain webhooks).
   * @param {function} done - Callback receiving the number of restored messages
   */
  function loadN8nHistory(done) {
    if (!LOAD_HISTORY_FROM_N8N) { done(0); return; }
    postJson(
      N8N_CHAT_URL,
      { action: 'loadPreviousSession', sessionId: sessionId },
      function (data) {
        var arr = (data && data.data) || [];
        var n = 0;
        arr.forEach(function (m) {
          var content = m && m.kwargs && m.kwargs.content;
          if (!content) return;
          var idStr = (m.id && m.id.join) ? m.id.join(',') : '';
          addMessage(idStr.indexOf('HumanMessage') >= 0 ? 'user' : 'bot', content, true);
          n++;
        });
        done(n);
      },
      function () { done(0); }
    );
  }

  // ==================================================================
  // RENDERING — messages, typing indicator, formatting
  // ==================================================================

  /**
   * Adds a message to the chat area and persists it to localStorage.
   * @param {string}  role        - 'user' | 'bot'
   * @param {string}  text        - Raw text / Markdown content
   * @param {boolean} [skipSave]  - If true, don't persist (used for history replay)
   */
  /**
   * Adds a message to the chat area and persists it to localStorage.
   * @param {string}  role        - 'user' | 'bot'
   * @param {string}  text        - Raw text / Markdown content
   * @param {number}  [elapsedMs] - Optional response time in ms (bot messages only)
   * @param {boolean} [skipSave]  - If true, don't persist (used for history replay)
   */
  function addMessage(role, text, elapsedMs, skipSave) {
    var time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    renderMessage(role, text, time, elapsedMs);
    if (!skipSave) {
      persistMessage(role, text, time);
    }
  }

  /**
   * Creates and inserts a message bubble into the DOM.
   * Includes a copy-to-clipboard button that appears on hover.
   * @param {string} role       - 'user' | 'bot'
   * @param {string} text       - Content (raw Markdown)
   * @param {string} time       - Formatted time string to display
   * @param {number} [elapsedMs] - Optional: response time in ms for bot messages
   */
  function renderMessage(role, text, time, elapsedMs) {
    var wrap = document.createElement('div');
    wrap.className = 'mhc-msg mhc-' + role;

    var bubble = document.createElement('div');
    bubble.className = 'mhc-bubble';
    bubble.innerHTML = formatText(text);

    // Attach CSV export buttons to any Markdown tables in bot responses
    bubble.querySelectorAll('table').forEach(function (table) {
      var btn = document.createElement('button');
      btn.className = 'mhc-table-export-btn';
      btn.innerHTML = '<i class="fa-solid fa-file-csv"></i> Export as CSV';
      btn.onclick = function () {
        exportTableToCSV(table, '5D_Export_' + Date.now() + '.csv');
      };
      table.parentNode.insertBefore(btn, table);
    });

    // ── Copy button ─────────────────────────────────────────────
    var copyBtn = document.createElement('button');
    copyBtn.className = 'mhc-copy-btn';
    copyBtn.title = 'Copy message';
    copyBtn.setAttribute('aria-label', 'Copy message to clipboard');
    copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
    copyBtn.addEventListener('click', function () {
      // Extract plain text (strip HTML tags from rendered markdown)
      var plain = bubble.innerText || bubble.textContent || text;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(plain).then(function () {
          copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
          copyBtn.classList.add('copied');
          setTimeout(function () {
            copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
            copyBtn.classList.remove('copied');
          }, 2000);
        }).catch(function () {
          copyFallback(plain, copyBtn);
        });
      } else {
        copyFallback(plain, copyBtn);
      }
    });

    var timeEl = document.createElement('div');
    timeEl.className = 'mhc-time';
    timeEl.textContent = time || '';

    // Bottom row: timestamp + optional response-time pill + copy button
    var meta = document.createElement('div');
    meta.className = 'mhc-meta';
    meta.appendChild(timeEl);

    // Response-time chip — only on bot messages, fades out after 5 s
    if (role === 'bot' && elapsedMs != null) {
      var secs = (elapsedMs / 1000).toFixed(1);
      var timeChip = document.createElement('span');
      timeChip.className = 'mhc-response-time';
      timeChip.textContent = 'Answered in ' + secs + ' s';
      meta.appendChild(timeChip);
      // Start fade-out after 5 seconds
      setTimeout(function () {
        timeChip.classList.add('mhc-response-time--fade');
        // Remove from DOM once animation ends
        timeChip.addEventListener('transitionend', function () {
          if (timeChip.parentNode) timeChip.parentNode.removeChild(timeChip);
        });
      }, 5000);
    }

    meta.appendChild(copyBtn);

    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    elMsgs.appendChild(wrap);
    elMsgs.scrollTop = elMsgs.scrollHeight;
  }

  /**
   * Fallback clipboard copy using a temporary textarea.
   * @param {string} text - Text to copy
   * @param {Element} btn  - The copy button element for feedback
   */
  function copyFallback(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      btn.innerHTML = '<i class="fa-solid fa-check"></i>';
      btn.classList.add('copied');
      setTimeout(function () {
        btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
        btn.classList.remove('copied');
      }, 2000);
    } catch (e) { }
    document.body.removeChild(ta);
  }

  /** Shows the three-dot typing animation while waiting for the bot. */
  function showTyping() {
    var t = document.createElement('div');
    t.className = 'mhc-msg mhc-bot';
    t.id = 'mhc-typing-row';
    t.innerHTML = '<div class="mhc-bubble mhc-typing"><span></span><span></span><span></span></div>';
    elMsgs.appendChild(t);
    elMsgs.scrollTop = elMsgs.scrollHeight;
  }

  /** Removes the typing animation. */
  function hideTyping() {
    var t = document.getElementById('mhc-typing-row');
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }

  /**
   * Converts raw text to safe HTML, with Markdown support via marked.js.
   * Falls back to a minimal manual parser if marked is unavailable.
   * @param {string} s - Raw input
   * @returns {string} HTML string
   */
  function formatText(s) {
    if (typeof marked !== 'undefined') {
      return marked.parse(String(s));
    }
    // Fallback: escape HTML, then apply minimal Markdown
    var t = escapeHtml(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\n/g, '<br>');
    return t;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================================================================
  // VIEW HELPERS — switching between welcome screen and chat area
  // ==================================================================

  function showChatArea() {
    elWelcome.style.display = 'none';
    elMsgs.style.display = 'flex';
  }

  function showWelcomeScreen() {
    elMsgs.style.display = 'none';
    elWelcome.style.display = 'flex';
  }

  function setStatus(text, isWorking) {
    elStatus.textContent = text;
    if (isWorking) {
      elStatus.classList.add('working');
    } else {
      elStatus.classList.remove('working');
    }
  }

  function showError(msg) {
    elError.textContent = msg;
    elError.style.display = 'block';
  }

  function clearError() {
    elError.style.display = 'none';
  }

  // ==================================================================
  // CSV TABLE EXPORT
  // ==================================================================

  /**
   * Reads an HTML table element and triggers a UTF-8 CSV download.
   * Adds a BOM so Excel recognises the encoding correctly.
   * @param {HTMLTableElement} table
   * @param {string}           filename
   */
  function exportTableToCSV(table, filename) {
    var rows = Array.from(table.querySelectorAll('tr'));
    var csv = rows.map(function (row) {
      return Array.from(row.querySelectorAll('td, th')).map(function (cell) {
        return '"' + cell.innerText.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');

    var BOM = '\uFEFF'; // Byte Order Mark for Excel UTF-8 compatibility
    var blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ==================================================================
  // ANSWER EXTRACTION — handles various n8n response shapes
  // ==================================================================

  /**
   * Extracts the human-readable answer from the various response
   * formats that n8n can return (Webhook vs Chat Trigger, single vs array).
   * @param {*} data - Parsed JSON response from n8n
   * @returns {string}
   */
  function extractAnswer(data) {
    if (data === null || data === undefined) return '(empty response)';
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) return data.length ? extractAnswer(data[0]) : '(empty response)';
    if (typeof data.output === 'string') return data.output;
    if (typeof data.text === 'string') return data.text;
    if (typeof data.message === 'string') return data.message;
    if (data.json) return extractAnswer(data.json);
    try { return JSON.stringify(data); } catch (e) { return String(data); }
  }

  // ==================================================================
  // SESSION ID — stable across page reloads via localStorage
  // ==================================================================

  /**
   * Returns a session ID tied to the currently active conversation.
   * If embedded in iTWO, uses the Context object's ChatSessionId.
   * Otherwise, falls back to a new UUID stored in localStorage.
   * @returns {string}
   */
  function initSessionId() {
    // Check if running inside iTWO (Context object)
    var ctx = getCtx();
    if (ctx && ctx.ChatSessionId) return String(ctx.ChatSessionId);

    // Generate a fresh UUID for this conversation
    var id = genId();
    if (ctx) { try { ctx.ChatSessionId = id; } catch (e) { } }
    return id;
  }

  function getCtx() {
    try { if (typeof Context !== 'undefined' && Context) return Context; } catch (e) { }
    try { if (window.parent && window.parent.Context) return window.parent.Context; } catch (e) { }
    return null;
  }

  function genId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) { }
    return '5d-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
  }

  // ==================================================================
  // RELATIVE DATE FORMATTING (sidebar history items)
  // ==================================================================

  /**
   * Returns a human-friendly relative date string (e.g. "Today", "Yesterday", "3 Aug").
   * @param {string} isoDate - ISO 8601 date string
   * @returns {string}
   */
  function formatRelativeDate(isoDate) {
    if (!isoDate) return '';
    var d = new Date(isoDate);
    var now = new Date();
    var diff = now - d;

    if (diff < 86400000 && d.getDate() === now.getDate()) return 'Today';
    if (diff < 172800000) return 'Yesterday';

    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // ==================================================================
  // ADMIN PANEL — settings for administrators only
  // ==================================================================

  elBtnAdminSettings.addEventListener('click', function () {
    // Pre-fill current values
    elAdminWebhookUrl.value = localStorage.getItem('admin_webhook_url') || N8N_CHAT_URL;
    elAdminTimeout.value = localStorage.getItem('admin_timeout') || TIMEOUT_MS;
    elAdminPanel.style.display = 'block';
    elAdminPanel.removeAttribute('aria-hidden');
  });

  elBtnAdminClose.addEventListener('click', function () {
    elAdminPanel.style.display = 'none';
    elAdminPanel.setAttribute('aria-hidden', 'true');
  });

  elBtnAdminSave.addEventListener('click', function () {
    var newUrl = elAdminWebhookUrl.value.trim();
    var newTimeout = parseInt(elAdminTimeout.value, 10);

    if (newUrl) localStorage.setItem('admin_webhook_url', newUrl);
    if (!isNaN(newTimeout)) localStorage.setItem('admin_timeout', newTimeout);

    // Update live values
    N8N_CHAT_URL = newUrl || N8N_CHAT_URL;
    TIMEOUT_MS = !isNaN(newTimeout) ? newTimeout : TIMEOUT_MS;

    elAdminPanel.style.display = 'none';
    elAdminPanel.setAttribute('aria-hidden', 'true');

    setStatus('Settings saved', false);
  });

  // ==================================================================
  // MOBILE SIDEBAR TOGGLE
  // ==================================================================

  elBtnMenu.addEventListener('click', function () {
    elSidebar.classList.add('open');
    elOverlay.classList.add('active');
  });

  elOverlay.addEventListener('click', closeMobileSidebar);

  function closeMobileSidebar() {
    elSidebar.classList.remove('open');
    elOverlay.classList.remove('active');
  }

  // ==================================================================
  // SIGN OUT
  // ==================================================================

  elBtnSignout.addEventListener('click', function () {
    // Clear all authentication data from localStorage
    ['jwt_token', 'user_display_name', 'user_role', 'user_company', 'user_login']
      .forEach(function (key) { localStorage.removeItem(key); });
    window.location.href = 'login.html';
  });

  // ==================================================================
  // SUGGESTION CARDS (welcome screen)
  // ==================================================================

  document.querySelectorAll('.chat-suggestion-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var prompt = card.dataset.prompt;
      if (!prompt) return;
      elInput.value = prompt;
      send();
    });
  });

  // ==================================================================
  // NEW CHAT BUTTON
  // ==================================================================

  elBtnNewChat.addEventListener('click', function () {
    startNewConversation();
    sessionId = initSessionId();
    closeMobileSidebar();
  });

  // ==================================================================
  // INPUT EVENT LISTENERS
  // ==================================================================

  // Send on Enter (Shift+Enter = new line)
  elInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Auto-resize the textarea as the user types
  elInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  });

  // Send button
  elSend.addEventListener('click', send);

  // ==================================================================
  // BOOT SEQUENCE — runs once on page load
  // ==================================================================

  (function boot() {
    // 1. Apply saved theme (dark/light)
    bootTheme();

    // 2. Render user info in sidebar
    bootUserInfo();

    // 3. Render existing conversation history in sidebar
    renderHistoryList();

    // 4. Initialise the session ID for a new conversation
    sessionId = initSessionId();

    // 5. Show welcome screen (or last conversation if desired)
    showWelcomeScreen();
    updateHeaderTitle('AI Assistant');

    // 6. Attempt to load n8n history (no-op if LOAD_HISTORY_FROM_N8N = false)
    loadN8nHistory(function (restored) {
      if (restored > 0) {
        showChatArea();
      }
      elInput.focus();
    });
  })();

})();
