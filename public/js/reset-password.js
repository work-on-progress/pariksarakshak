// public/js/reset-password.js
import { supabase, configLooksFilled } from "./supabaseClient.js";

const newPassword = document.getElementById("newPassword");
const confirmPassword = document.getElementById("confirmPassword");
const resetBtn = document.getElementById("resetBtn");
const msg = document.getElementById("resetMsg");

function show(text, kind = "error") {
  msg.textContent = text;
  msg.className = `notice ${kind}`;
  msg.classList.remove("hidden");
}

function enableForm() {
  newPassword.disabled = false;
  confirmPassword.disabled = false;
  resetBtn.disabled = false;
  newPassword.focus();
}

async function boot() {
  if (!configLooksFilled()) {
    show("This site has no Supabase keys yet. Run the setup check first.");
    return;
  }

  /*
   * Supabase may return recovery credentials in either form:
   * - a PKCE ?code=... URL
   * - an implicit recovery URL that supabase-js detects automatically
   *
   * Handle both so the page remains reliable across project auth settings.
   */
  const url = new URL(location.href);
  const code = url.searchParams.get("code");

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        show(
          "This password-reset link is invalid or has expired. Return to sign in and request a new one.",
        );
        return;
      }
    }

    history.replaceState({}, "", location.pathname);
  }

  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    enableForm();
    show("Recovery link verified. Choose your new password.", "ok");
    return;
  }

  /*
   * For implicit recovery links, supabase-js may finish processing the hash
   * immediately after page load. Give the PASSWORD_RECOVERY event a moment.
   */
  let opened = false;

  const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
    if (opened) return;

    if ((event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") && nextSession) {
      opened = true;
      enableForm();
      show("Recovery link verified. Choose your new password.", "ok");
    }
  });

  setTimeout(async () => {
    if (opened) return;

    const { data: { session: laterSession } } = await supabase.auth.getSession();

    if (laterSession) {
      opened = true;
      enableForm();
      show("Recovery link verified. Choose your new password.", "ok");
    } else {
      show(
        "Open this page using the password-reset link from your email. If the link has expired, request another one from the sign-in page.",
      );
    }

    listener.subscription.unsubscribe();
  }, 1200);
}

resetBtn.onclick = async () => {
  const p1 = newPassword.value;
  const p2 = confirmPassword.value;

  if (p1.length < 8) {
    show("Use at least 8 characters for the new password.");
    return;
  }

  if (p1 !== p2) {
    show("The two passwords do not match.");
    return;
  }

  resetBtn.disabled = true;
  const original = resetBtn.textContent;
  resetBtn.textContent = "Updating…";

  try {
    const { error } = await supabase.auth.updateUser({
      password: p1,
    });

    if (error) {
      show(`Could not update the password: ${error.message}`);
      return;
    }

    show("Password changed successfully. Returning to sign in…", "ok");

    await supabase.auth.signOut();

    setTimeout(() => {
      location.replace("index.html?password_reset=1#signin");
    }, 900);
  } finally {
    resetBtn.disabled = false;
    resetBtn.textContent = original;
  }
};

confirmPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !resetBtn.disabled) resetBtn.click();
});

boot();
