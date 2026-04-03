/* ═══════════════════════════════════════════════════════════
   TERMINAL — Authentication Module
   Supabase Auth: Email/Password + Google OAuth
   ═══════════════════════════════════════════════════════════ */

// ── Supabase Configuration ──
// Replace these with your Supabase project credentials.
// Dashboard → Settings → API → Project URL & anon/public key.
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

let supabase;
try {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.warn('Supabase client not initialized — running in demo mode.', e);
  supabase = null;
}

// ── Auth State ──
const auth = {
  user: null,
  session: null,
  loading: true,
};

// ── DOM References ──
const welcomePage = document.getElementById('welcome-page');
const appContainer = document.getElementById('app');
const userNav = document.getElementById('user-nav');
const userDisplayName = document.getElementById('user-display-name');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const googleLoginBtn = document.getElementById('google-login-btn');
const logoutBtn = document.getElementById('logout-btn');

// ── Auth Tab Switching ──
document.querySelectorAll('[data-auth-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.authTab;
    document.querySelectorAll('[data-auth-tab]').forEach(t => t.classList.remove('auth-tab--active'));
    tab.classList.add('auth-tab--active');

    if (target === 'login') {
      loginForm.style.display = '';
      registerForm.style.display = 'none';
    } else {
      loginForm.style.display = 'none';
      registerForm.style.display = '';
    }
    // Clear errors on tab switch
    loginError.textContent = '';
    registerError.textContent = '';
  });
});

// ── Show / Hide Helpers ──
function showTerminal(user) {
  auth.user = user;
  welcomePage.style.display = 'none';
  appContainer.style.display = '';
  userNav.style.display = '';

  // Display name: prefer full name, fall back to email prefix
  const meta = user.user_metadata || {};
  const name = meta.display_name
    || meta.full_name
    || [meta.first_name, meta.last_name].filter(Boolean).join(' ')
    || user.email.split('@')[0];
  userDisplayName.textContent = name;

  // Initialize the terminal app (defined in app.js)
  if (typeof initTerminal === 'function') {
    initTerminal();
  }
}

function showWelcome() {
  auth.user = null;
  auth.session = null;
  welcomePage.style.display = '';
  appContainer.style.display = 'none';
  userNav.style.display = 'none';
}

// ── Loading State Helper ──
function setSubmitting(btn, loading) {
  const text = btn.querySelector('.auth-btn__text');
  const loader = btn.querySelector('.auth-btn__loader');
  btn.disabled = loading;
  if (text) text.style.opacity = loading ? '0' : '1';
  if (loader) loader.hidden = !loading;
}

// ── Email/Password Login ──
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-submit');

  if (!email || !password) {
    loginError.textContent = 'Please fill in all fields.';
    return;
  }

  setSubmitting(btn, true);

  if (!supabase) {
    loginError.textContent = 'Auth service not configured. Please set Supabase credentials in auth.js.';
    setSubmitting(btn, false);
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  setSubmitting(btn, false);

  if (error) {
    loginError.textContent = error.message;
    return;
  }

  showTerminal(data.user);
});

// ── Email/Password Registration ──
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  const firstName = document.getElementById('register-first').value.trim();
  const lastName = document.getElementById('register-last').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const btn = document.getElementById('register-submit');

  if (!email || !password) {
    registerError.textContent = 'Email and password are required.';
    return;
  }

  if (password.length < 8) {
    registerError.textContent = 'Password must be at least 8 characters.';
    return;
  }

  setSubmitting(btn, true);

  if (!supabase) {
    registerError.textContent = 'Auth service not configured. Please set Supabase credentials in auth.js.';
    setSubmitting(btn, false);
    return;
  }

  const displayName = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: firstName,
        last_name: lastName,
        display_name: displayName,
      },
    },
  });

  setSubmitting(btn, false);

  if (error) {
    registerError.textContent = error.message;
    return;
  }

  // Supabase may require email confirmation
  if (data.user && !data.user.confirmed_at && data.user.identities?.length === 0) {
    registerError.textContent = 'An account with this email already exists.';
    registerError.style.color = 'var(--red)';
    return;
  }

  if (data.session) {
    showTerminal(data.user);
  } else {
    // Email confirmation required
    registerError.textContent = 'Check your email for a confirmation link.';
    registerError.style.color = 'var(--green)';
  }
});

// ── Google OAuth ──
googleLoginBtn.addEventListener('click', async () => {
  if (!supabase) {
    loginError.textContent = 'Auth service not configured. Please set Supabase credentials in auth.js.';
    return;
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });

  if (error) {
    loginError.textContent = error.message;
  }
});

// ── Logout ──
logoutBtn.addEventListener('click', async () => {
  if (supabase) {
    await supabase.auth.signOut();
  }
  showWelcome();
});

// ── Session Restoration (on page load & OAuth redirect) ──
async function initAuth() {
  if (!supabase) {
    auth.loading = false;
    showWelcome();
    return;
  }

  // Listen for auth state changes (handles OAuth redirects, token refresh, etc.)
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      auth.session = session;
      showTerminal(session.user);
    } else if (event === 'SIGNED_OUT') {
      showWelcome();
    }
  });

  // Check for existing session
  const { data: { session } } = await supabase.auth.getSession();
  auth.loading = false;

  if (session?.user) {
    auth.session = session;
    showTerminal(session.user);
  } else {
    showWelcome();
  }
}

// Initialize auth immediately
initAuth();
