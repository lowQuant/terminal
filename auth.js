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
// Expose to sibling scripts (wf.js reads auth.user.email etc.)
window.auth = auth;

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
      .select('is_active, llm_keys')
      .eq('id', user.id)
      .single();

    if (profile) {
      if (profile.is_active === false) {
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
      
      // Store LLM Keys for the session
      window.User = window.User || {};
      window.User.llm_keys = profile.llm_keys || {};
      // If the WF hub is already rendered, refresh its agent chip
      if (typeof window.wfUpdateAgentLabel === 'function') {
        window.wfUpdateAgentLabel();
      }
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

// ═══════════════════════════════════════════════════════════════════
// USER SETTINGS — LLM provider selection, keys, model dropdowns
//
// Two-level selection: the user picks a Primary Provider, then picks
// a Model from that provider. The Model control is a <select> for the
// fixed providers (Anthropic/OpenAI/Gemini/Perplexity) and a searchable
// <input list=datalist> for OpenRouter, because OpenRouter has 400+
// models that would drown a plain dropdown.
//
// OpenRouter models are fetched once (cached server-side for 10 min)
// from /api/wf/openrouter/models — the endpoint normalizes OpenRouter's
// schema into {id, name, context_length, pricing, supports_tools}.
//
// The stored shape of `profiles.llm_keys` is:
//   {
//     provider:    "openrouter",
//     agent_model: "anthropic/claude-3.5-sonnet",
//     anthropic: "sk-ant-...", openai: "sk-...", ...
//   }
// ═══════════════════════════════════════════════════════════════════

// Curated default model lists for each fixed provider.
// These are hints — users can still paste any model ID via the raw
// text input (OpenRouter's searchable field also accepts free-form).
const SETTINGS_PROVIDER_MODELS = {
  anthropic: [
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022',  name: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-20240229',     name: 'Claude 3 Opus' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-5-20250929',   name: 'Claude Opus 4.5' },
  ],
  openai: [
    { id: 'gpt-4o',             name: 'GPT-4o' },
    { id: 'gpt-4o-mini',        name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo',        name: 'GPT-4 Turbo' },
    { id: 'o1-preview',         name: 'o1 (reasoning preview)' },
    { id: 'o1-mini',            name: 'o1 Mini' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro',     name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',   name: 'Gemini 2.5 Flash' },
    { id: 'gemini-1.5-pro',     name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash',   name: 'Gemini 1.5 Flash' },
  ],
  perplexity: [
    { id: 'sonar-pro',          name: 'Sonar Pro (web search + reasoning)' },
    { id: 'sonar',              name: 'Sonar (web search)' },
    { id: 'sonar-reasoning',    name: 'Sonar Reasoning' },
  ],
  openrouter: [],  // populated dynamically from /api/wf/openrouter/models
};

// In-memory cache of the normalized OpenRouter list — avoids a refetch
// every time the user flips the provider dropdown within one session.
let _openrouterModelsCache = null;

const settingsForm = document.getElementById('settings-form');
if (settingsForm) {
  const providerSel = document.getElementById('settings-provider');
  const modelSel    = document.getElementById('settings-agent-model');
  const orInput     = document.getElementById('settings-openrouter-model');
  const orList      = document.getElementById('openrouter-models-datalist');
  const orWrap      = document.getElementById('settings-openrouter-wrap');
  const stdWrap     = document.getElementById('settings-model-wrap');
  const modelHint   = document.getElementById('settings-model-hint');
  const orInfo      = document.getElementById('settings-openrouter-info');

  // ── Populate the key-status chips (● set / ○ not set) ──
  function updateKeyStatuses() {
    const providers = ['anthropic', 'openai', 'gemini', 'perplexity', 'openrouter'];
    providers.forEach((p) => {
      const input = document.getElementById(`key-${p}`);
      const dot   = document.getElementById(`status-${p}`);
      if (!dot || !input) return;
      const has = input.value.trim().length > 0;
      dot.textContent = has ? '● set' : '○ not set';
      dot.className = 'key-status ' + (has ? 'key-status--set' : 'key-status--unset');
    });
  }

  // Refresh chip state whenever a key input changes
  ['anthropic', 'openai', 'gemini', 'perplexity', 'openrouter'].forEach((p) => {
    const input = document.getElementById(`key-${p}`);
    if (input) input.addEventListener('input', updateKeyStatuses);
  });

  // ── Render model options for a given provider ──
  function renderModelsForProvider(provider, preselectModel) {
    const isOpenRouter = provider === 'openrouter';
    stdWrap.style.display = isOpenRouter ? 'none' : '';
    orWrap.style.display  = isOpenRouter ? '' : 'none';

    if (!isOpenRouter) {
      const models = SETTINGS_PROVIDER_MODELS[provider] || [];
      modelSel.innerHTML = models.map((m) =>
        `<option value="${m.id}">${m.name}</option>`
      ).join('');
      if (preselectModel) modelSel.value = preselectModel;
      modelHint.textContent = `${models.length} curated models`;
      return;
    }

    // OpenRouter: fetch once, render as <datalist> options for search
    if (preselectModel) orInput.value = preselectModel;
    modelHint.textContent = 'Type to search — 400+ models from all providers';
    fetchOpenRouterModels().then((models) => {
      orList.innerHTML = models.map((m) => {
        const pp = m.pricing_prompt ? `$${(+m.pricing_prompt * 1e6).toFixed(2)}/Mtok` : '';
        const ctx = m.context_length ? ` · ${Math.round(m.context_length / 1000)}k` : '';
        const tools = m.supports_tools ? ' · tools' : '';
        const label = `${m.name}${ctx}${tools}${pp ? ' · ' + pp : ''}`;
        return `<option value="${m.id}" label="${label.replace(/"/g, '&quot;')}">${label}</option>`;
      }).join('');
      orInfo.textContent = `${models.length} models available · pricing shown per 1M input tokens`;

      // Show details when the user picks/types a specific model
      orInput.addEventListener('input', () => {
        const m = models.find((x) => x.id === orInput.value);
        if (m) {
          const pp = m.pricing_prompt ? ` · $${(+m.pricing_prompt * 1e6).toFixed(2)}/Mtok in` : '';
          const pc = m.pricing_completion ? ` · $${(+m.pricing_completion * 1e6).toFixed(2)}/Mtok out` : '';
          const ctx = m.context_length ? ` · ${Math.round(m.context_length / 1000)}k ctx` : '';
          const t = m.supports_tools ? ' · tools ✓' : ' · no tools';
          orInfo.textContent = (m.name || m.id) + ctx + t + pp + pc;
        }
      }, { once: false });
    }).catch((err) => {
      orInfo.textContent = 'Could not load OpenRouter models: ' + err.message;
    });
  }

  async function fetchOpenRouterModels() {
    if (_openrouterModelsCache) return _openrouterModelsCache;
    const res = await fetch('/api/wf/openrouter/models');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    _openrouterModelsCache = data.models || [];
    return _openrouterModelsCache;
  }

  // Swap model list whenever the provider changes
  providerSel.addEventListener('change', () => {
    renderModelsForProvider(providerSel.value, null);
  });

  // ── Open/close the settings modal ──
  //
  // The shared .article-modal CSS hides the modal with
  // ``opacity: 0; pointer-events: none;`` and reveals it via the
  // ``.article-modal--visible`` class. Toggling ``style.display``
  // alone does nothing because the CSS opacity rule still applies.
  const settingsModal = document.getElementById('settings-modal');

  function openSettingsModal() {
    settingsModal.classList.add('article-modal--visible');
    document.body.style.overflow = 'hidden';
  }
  function closeSettingsModal() {
    settingsModal.classList.remove('article-modal--visible');
    document.body.style.overflow = '';
  }

  // Close handlers: X button, click on backdrop, Esc
  document.getElementById('settings-close-btn')?.addEventListener('click', closeSettingsModal);
  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.classList.contains('article-modal--visible')) {
      closeSettingsModal();
    }
  });

  // Open the modal — load keys, render provider + model
  document.getElementById('settings-btn')?.addEventListener('click', async () => {
    openSettingsModal();
    document.getElementById('settings-success').style.display = 'none';
    document.getElementById('settings-error').style.display = 'none';
    if (!supabaseClient || !auth.user) return;

    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('llm_keys')
      .eq('id', auth.user.id)
      .single();

    if (error) {
      console.warn('[settings] profile load failed:', error);
      return;
    }

    const keys = (profile && profile.llm_keys) || {};
    // Key fields
    document.getElementById('key-anthropic').value  = keys.anthropic  || '';
    document.getElementById('key-openai').value     = keys.openai     || '';
    document.getElementById('key-gemini').value     = keys.gemini     || '';
    document.getElementById('key-perplexity').value = keys.perplexity || '';
    document.getElementById('key-openrouter').value = keys.openrouter || '';
    updateKeyStatuses();

    // Provider + model selection
    const provider = keys.provider || inferProviderFromModel(keys.agent_model) || 'anthropic';
    providerSel.value = provider;
    renderModelsForProvider(provider, keys.agent_model);

    window.User = window.User || {};
    window.User.llm_keys = keys;
  });

  // Cheap fallback for old profiles missing the `provider` field
  function inferProviderFromModel(model) {
    if (!model) return null;
    const m = String(model).toLowerCase();
    if (m.startsWith('openrouter/')) return 'openrouter';
    if (m.startsWith('gemini/') || m.includes('gemini')) return 'gemini';
    if (m.includes('sonar') || m.includes('perplexity')) return 'perplexity';
    if (m.includes('claude')) return 'anthropic';
    if (m.includes('gpt') || m.startsWith('o1')) return 'openai';
    return null;
  }

  // ── Save ──
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn  = document.getElementById('settings-submit');
    const succ = document.getElementById('settings-success');
    const err  = document.getElementById('settings-error');
    succ.style.display = 'none';
    err.style.display  = 'none';

    if (!supabaseClient || !auth.user) return;
    setSubmitting(btn, true);

    const provider = providerSel.value;
    const agent_model =
      provider === 'openrouter'
        ? (orInput.value.trim() || 'anthropic/claude-3.5-sonnet')
        : modelSel.value;

    const keys = {
      provider,
      agent_model,
      anthropic:  document.getElementById('key-anthropic').value.trim(),
      openai:     document.getElementById('key-openai').value.trim(),
      gemini:     document.getElementById('key-gemini').value.trim(),
      perplexity: document.getElementById('key-perplexity').value.trim(),
      openrouter: document.getElementById('key-openrouter').value.trim(),
    };

    // Sanity: warn (don't block) if the selected provider has no key
    const selectedKey = keys[provider];
    if (!selectedKey) {
      err.textContent = `No ${provider} API key set. The primary provider will fail until you add one.`;
      err.style.color = 'var(--orange, #ff8c00)';
      err.style.display = 'block';
    }

    const { error: saveErr } = await supabaseClient
      .from('profiles')
      .update({ llm_keys: keys })
      .eq('id', auth.user.id);

    setSubmitting(btn, false);

    if (saveErr) {
      err.textContent = 'Save failed: ' + saveErr.message;
      err.style.color = 'var(--red, #ef5350)';
      err.style.display = 'block';
      return;
    }

    succ.style.display = 'block';
    window.User = window.User || {};
    window.User.llm_keys = keys;
    // Live-refresh the WF hub's agent chip so the user sees the new
    // selection without a page reload.
    if (typeof window.wfUpdateAgentLabel === 'function') {
      window.wfUpdateAgentLabel();
    }
    setTimeout(closeSettingsModal, 1500);
  });
}
