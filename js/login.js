/**
 * login.js — Authentication Logic for 5D Institut Chatbot
 * =========================================================
 * Handles:
 *  1. xdhub JWT login (POST /jwt-auth/v1/token)
 *  2. User role + display name fetch (GET /wp/v2/users/me)
 *  3. Storing auth data in localStorage
 *  4. Redirecting to the main app (index.html)
 *
 * All data stored in localStorage:
 *  - jwt_token          : Bearer token for API calls
 *  - user_display_name  : e.g. "John Doe"
 *  - user_role          : "administrator" | "customer" | other WP role
 *  - user_login         : WP username slug
 *
 * NOTE: If the user is already authenticated, they are sent directly
 * to index.html so they don't see the login form again.
 */

(function () {

  // ============================================================
  // CONFIGURATION
  // ============================================================

  /** Base URL of the xdhub WordPress REST API */
  var XDHUB_API = 'https://xdhub.de/wp-json';

  /** Page to redirect to after successful login */
  var APP_URL = 'index.html';

  // ============================================================
  // REDIRECT IF ALREADY LOGGED IN
  // ============================================================

  /**
   * If a valid JWT token is already stored, skip the login screen.
   * The token's actual validity will be re-verified inside index.html.
   */
  if (localStorage.getItem('jwt_token')) {
    window.location.href = APP_URL;
    // Stop script execution immediately
    throw new Error('Already authenticated — redirecting.');
  }

  // ============================================================
  // DOM REFERENCES
  // ============================================================

  var form       = document.getElementById('login-form');
  var usernameEl = document.getElementById('login-username');
  var passwordEl = document.getElementById('login-password');
  var submitBtn  = document.getElementById('login-submit-btn');
  var btnText    = document.getElementById('login-btn-text');
  var btnSpinner = document.getElementById('login-btn-spinner');
  var errorBox   = document.getElementById('login-error');
  var errorText  = document.getElementById('login-error-text');
  var togglePw   = document.getElementById('login-toggle-pw');
  var eyeIcon    = document.getElementById('login-eye-icon');

  // ============================================================
  // PASSWORD VISIBILITY TOGGLE
  // ============================================================

  togglePw.addEventListener('click', function () {
    var isPassword = passwordEl.type === 'password';
    passwordEl.type = isPassword ? 'text' : 'password';
    eyeIcon.className = isPassword ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  });

  // ============================================================
  // FORM SUBMISSION HANDLER
  // ============================================================

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var username = usernameEl.value.trim();
    var password = passwordEl.value;

    // Basic client-side validation
    if (!username || !password) {
      showError('Please enter both your username and password.');
      return;
    }

    hideError();
    setLoading(true);

    // Step 1: Authenticate with xdhub JWT endpoint
    authenticateUser(username, password);
  });

  // ============================================================
  // STEP 1: JWT AUTHENTICATION
  // ============================================================

  /**
   * Sends credentials to the xdhub JWT endpoint.
   * On success: stores the token and fetches the user profile.
   * On failure: shows an error message.
   *
   * @param {string} username - The user's xdhub username or email
   * @param {string} password - The user's password
   */
  function authenticateUser(username, password) {
    fetch(XDHUB_API + '/jwt-auth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.token) {
        // Store the token and initial display name
        localStorage.setItem('jwt_token', data.token);
        localStorage.setItem('user_display_name', data.user_display_name || username);
        localStorage.setItem('user_login', data.user_nicename || username);

        // Step 2: Fetch the full user profile to get the role
        getUserRole(data.token);
      } else {
        // The API returned JSON without a token — show the server's message
        var msg = data.message || 'Invalid credentials. Please try again.';
        // WordPress wraps some errors in data.message or message directly
        showError(stripTags(msg));
        setLoading(false);
      }
    })
    .catch(function (err) {
      showError('Could not connect to the authentication server. Please check your network and try again.');
      setLoading(false);
      console.error('[5D Auth] JWT request failed:', err);
    });
  }

  // ============================================================
  // STEP 2: FETCH USER ROLE
  // ============================================================

  /**
   * Calls the WordPress REST API to retrieve the current user's
   * profile, including their roles array.
   *
   * Roles expected: "administrator" or "customer"
   * Falls back to "customer" if the roles array is empty or missing.
   *
   * @param {string} token - The JWT Bearer token from Step 1
   */
  function getUserRole(token) {
    fetch(XDHUB_API + '/wp/v2/users/me?context=edit', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    })
    .then(function (res) { return res.json(); })
    .then(function (userData) {
      // Extract the primary role (first element of the roles array)
      var roles = userData.roles || [];
      var primaryRole = roles[0] || 'customer';

      // Store the role for use in the main app
      localStorage.setItem('user_role', primaryRole);

      // Attempt to get company name from a custom meta field (if it exists)
      // Falls back to empty string — the app handles missing company gracefully
      var company = '';
      if (userData.meta && userData.meta.company) {
        company = userData.meta.company;
      } else if (userData.meta && userData.meta.billing_company) {
        // WooCommerce stores company in billing_company
        company = userData.meta.billing_company;
      }
      localStorage.setItem('user_company', company);

      // All data stored — redirect to the main application
      window.location.href = APP_URL;
    })
    .catch(function (err) {
      // Even if role fetch fails, let the user in with default role
      // The token is already stored; we just couldn't read the role
      console.warn('[5D Auth] Could not fetch user role — defaulting to "customer":', err);
      localStorage.setItem('user_role', 'customer');
      localStorage.setItem('user_company', '');
      window.location.href = APP_URL;
    });
  }

  // ============================================================
  // UI HELPERS
  // ============================================================

  /**
   * Toggles the loading state of the submit button.
   * @param {boolean} isLoading
   */
  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    btnText.style.display    = isLoading ? 'none'   : 'inline';
    btnSpinner.style.display = isLoading ? 'inline' : 'none';
  }

  /** Shows the error banner with a given message. */
  function showError(msg) {
    errorText.textContent = msg;
    errorBox.style.display = 'flex';
  }

  /** Hides the error banner. */
  function hideError() {
    errorBox.style.display = 'none';
  }

  /**
   * Removes HTML tags from a string to safely render server messages.
   * @param {string} str
   * @returns {string}
   */
  function stripTags(str) {
    var div = document.createElement('div');
    div.innerHTML = str;
    return div.textContent || div.innerText || str;
  }

})();
