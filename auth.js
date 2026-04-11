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

// Check for invite or recovery links before Supabase strips the hash
let isInviteOrRecovery = false;
if (window.location.hash.includes('type=invite') || window.location.hash.includes('type=recovery')) {
  isInviteOrRecovery = true;
}

// ── DOM References ──
const welcomePage = document.getElementById('welcome-page');
const appContainer = document.getElementById('app');
const userNav = document.getElementById('user-nav');
const userDisplayName = document.getElementById('user-display-name');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const waitlistForm = document.getElementById('waitlist-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const waitlistError = document.getElementById('waitlist-error');
const waitlistSuccess = document.getElementById('waitlist-success');
const googleLoginBtn = document.getElementById('google-login-btn');
const logoutBtn = document.getElementById('logout-btn');

// ── Auth Tab Switching ──
document.querySelectorAll('[data-auth-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.authTab;
    document.querySelectorAll('[data-auth-tab]').forEach(t => t.classList.remove('auth-tab--active'));
    tab.classList.add('auth-tab--active');

    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    if (waitlistForm) waitlistForm.style.display = 'none';

    if (target === 'login') {
      loginForm.style.display = '';
    } else if (target === 'register') {
      registerForm.style.display = '';
    } else if (target === 'waitlist') {
      if (waitlistForm) waitlistForm.style.display = '';
    }

    // Clear errors on tab switch
    loginError.textContent = '';
    registerError.textContent = '';
    if (waitlistError) {
      waitlistError.textContent = '';
      if (waitlistSuccess) waitlistSuccess.style.display = 'none';
    }
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
  auth.isRegistering = true;

  if (!supabaseClient) {
    registerError.textContent = 'Auth service not configured. Please set Supabase credentials in auth.js.';
    setSubmitting(btn, false);
    return;
  }

  const displayName = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

  const { data, error } = await supabaseClient.auth.signUp({
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

  // Supabase may require email confirmation natively
  if (data.user && !data.user.confirmed_at && data.user.identities?.length === 0) {
    registerError.textContent = 'An account with this email already exists.';
    registerError.style.color = 'var(--red)';
    return;
  }

  // Since you have a custom activation flow and don't want auto-login:
  if (data.session) {
    // Immediately sign them out so they don't bypass your custom activation
    await supabaseClient.auth.signOut();
  }

  // Show a success message and keep them on the auth page
  registerError.textContent = 'Account created successfully! Please follow your custom email instructions to activate.';
  registerError.style.color = 'var(--green)';

  // Optionally, you can clear the form fields here:
  document.getElementById('register-form').reset();

  // Reset flag
  auth.isRegistering = false;
});

// ── Google OAuth (Currently Disabled) ──
/*
googleLoginBtn.addEventListener('click', async () => {
  if (!supabaseClient) {
    loginError.textContent = 'Auth service not configured. Please set Supabase credentials in auth.js.';
    return;
  }

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });

  if (error) {
    loginError.textContent = error.message;
  }
});
*/

// ── Waitlist Application ──
if (waitlistForm) {
  waitlistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    waitlistError.textContent = '';
    waitlistSuccess.style.display = 'none';
    
    const name = document.getElementById('waitlist-name').value.trim();
    const email = document.getElementById('waitlist-email').value.trim();
    const comments = document.getElementById('waitlist-comments').value.trim();
    const btn = document.getElementById('waitlist-submit');

    if (!name || !email || !comments) {
      waitlistError.textContent = 'Please fill in all fields.';
      return;
    }

    setSubmitting(btn, true);

    if (!supabaseClient) {
      waitlistError.textContent = 'Service not configured. Please try again later.';
      setSubmitting(btn, false);
      return;
    }

    const { error } = await supabaseClient
      .from('waitlist')
      .insert([
        { name, email, comments }
      ]);

    setSubmitting(btn, false);

    if (error) {
      if (error.code === '23505') {
        waitlistError.textContent = 'You are already on the waitlist!';
      } else {
        waitlistError.textContent = error.message;
      }
      return;
    }

    waitlistSuccess.textContent = 'Application submitted! We will carefully review your feature requests and get back to you soon.';
    waitlistSuccess.style.display = 'block';
    waitlistForm.reset();
  });
}

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
      
      // If user came via an invite link, prompt them to set their password
      if (isInviteOrRecovery || event === 'PASSWORD_RECOVERY') {
        const pwdModal = document.getElementById('password-modal');
        if (pwdModal) pwdModal.style.display = 'block';
        isInviteOrRecovery = false; // Prevent showing again unnecessarily
      }

      processLogin(session.user);
    } else if (event === 'SIGNED_OUT') {
      showWelcome();
    }
  });

  // Handle set-password form for invitees
  const setPasswordForm = document.getElementById('set-password-form');
  if (setPasswordForm) {
    setPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('set-password-submit');
      const pwd = document.getElementById('new-password').value;
      const err = document.getElementById('set-password-error');
      const succ = document.getElementById('set-password-success');

      err.textContent = '';
      succ.style.display = 'none';

      if (pwd.length < 8) {
        err.textContent = 'Password must be at least 8 characters.';
        return;
      }

      setSubmitting(btn, true);

      // Updates the password for the currently logged-in active session
      const { error } = await supabaseClient.auth.updateUser({ password: pwd });
      
      setSubmitting(btn, false);

      if (error) {
        err.textContent = error.message;
      } else {
        succ.textContent = 'Password successfully set! You can safely close this.';
        succ.style.display = 'block';
        // Hide the modal shortly after success
        setTimeout(() => {
          document.getElementById('password-modal').style.display = 'none';
        }, 2000);
      }
    });
  }

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
