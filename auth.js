/* ═══════════════════════════════════════════════════════════
   TERMINAL — Authentication Module
   Supabase Auth: Email/Password + Google OAuth
   ═══════════════════════════════════════════════════════════ */

// ── Supabase Configuration ──
// Replace these with your Supabase project credentials.
// Dashboard → Settings → API → Project URL & anon/public key.
const SUPABASE_URL = 'https://dukjbygxuzzofakrajkt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1a2pieWd4dXp6b2Zha3Jhamt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMzAzMTksImV4cCI6MjA5MDgwNjMxOX0.69Ya9Izi8qn29Ku8FMi_RSsNO-XH4s6ukYPDwPUiYqE';

let supabaseClient;
try {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.warn('Supabase client not initialized — running in demo mode.', e);
  supabaseClient = null;
}

// ── Auth State ──
const auth = {
  user: null,
  session: null,
  loading: true,
  isRegistering: false, // Prevents terminal flash during custom signup flow
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

async function processLogin(user) {
  if (supabaseClient) {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('is_active')
      .eq('id', user.id)
      .single();

    if (profile && profile.is_active === false) {
      // Force sign-out if account is deactivated or pending
      await supabaseClient.auth.signOut();
      
      const loginError = document.getElementById('login-error');
      if (loginError && !auth.isRegistering) {
        loginError.textContent = 'Account disabled or pending activation. Please verify your email.';
        loginError.style.color = 'var(--red)';
      }
      showWelcome();
      return; // Do not render terminal
    }
  }

  showTerminal(user);
}

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

  if (!supabaseClient) {
    loginError.textContent = 'Auth service not configured. Please set Supabase credentials in auth.js.';
    setSubmitting(btn, false);
    return;
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  setSubmitting(btn, false);

  if (error) {
    loginError.textContent = error.message;
    return;
  }

  processLogin(data.user);
});

// ── Waitlist Application ──
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  const firstName = document.getElementById('register-first').value.trim();
  const lastName = document.getElementById('register-last').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const featuresWanted = document.getElementById('register-features').value.trim();
  const btn = document.getElementById('register-submit');

  if (!email || !featuresWanted) {
    registerError.textContent = 'Email and requested features are required.';
    return;
  }

  setSubmitting(btn, true);

  if (!supabaseClient) {
    registerError.textContent = 'Database service not configured. Please set Supabase credentials in auth.js.';
    setSubmitting(btn, false);
    return;
  }

  // Insert into waitlist table
  const { error } = await supabaseClient
    .from('waitlist')
    .insert([
      { 
        first_name: firstName, 
        last_name: lastName, 
        email: email,
        features_wanted: featuresWanted 
      }
    ]);

  setSubmitting(btn, false);

  if (error) {
    // Handle specific unique constraint error
    if (error.code === '23505' || error.message.includes('duplicate')) {
      registerError.textContent = 'You are already on the waitlist with this email!';
    } else {
      registerError.textContent = error.message;
    }
    return;
  }

  // Show a success message
  registerError.textContent = 'Application received! We will notify you once selected for beta.';
  registerError.style.color = 'var(--green)';
  
  // Clear the form fields
  document.getElementById('register-form').reset();
});


// ── Logout ──
logoutBtn.addEventListener('click', async () => {
  if (supabaseClient) {
    await supabaseClient.auth.signOut();
  }
  showWelcome();
});

// ── Session Restoration (on page load & OAuth redirect) ──
async function initAuth() {
  if (!supabaseClient) {
    auth.loading = false;
    showWelcome();
    return;
  }

  // Listen for auth state changes (handles OAuth redirects, token refresh, etc.)
  supabaseClient.auth.onAuthStateChange((event, session) => {
    // Prevent terminal flash during custom sign-up flow
    if (auth.isRegistering) return;

    if (session?.user) {
      auth.session = session;
      processLogin(session.user);
    } else if (event === 'SIGNED_OUT') {
      showWelcome();
    }
  });

  // Check for existing session
  const { data: { session } } = await supabaseClient.auth.getSession();
  auth.loading = false;

  if (session?.user) {
      auth.session = session;
      processLogin(session.user);
  } else {
    showWelcome();
  }
}

// Initialize auth immediately
initAuth();
