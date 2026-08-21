// public/js/supabaseClient.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const configLooksFilled = () =>
  !SUPABASE_URL.includes("YOUR_PROJECT_REF") && !SUPABASE_ANON_KEY.includes("YOUR_ANON");

/** Calls a Supabase Edge Function with the signed-in user's token. */
export async function callFunction(name, payload) {
  const { data: { session } } = await supabase.auth.getSession();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session?.access_token ?? ""}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      return { error: `The ${name} function is not deployed yet. See docs/03.` };
    }
    return body;
  } catch (e) {
    return { error: `Could not reach the server. Check the connection and try again. (${e})` };
  }
}

/** Calls an Edge Function that deliberately accepts requests before sign-in.
 *  Only the SEB launch exchange and the SEB verification use this. */
export async function callPublicFunction(name, payload) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      return { error: `The ${name} function is not deployed yet. See docs/03.` };
    }
    return { ...body, _status: res.status };
  } catch (e) {
    return { error: `Could not reach the server. Check the connection and try again. (${e})` };
  }
}

/** Returns { user, profile }, or sends the person where they belong. */
export async function requireUser(expectedRole) {
  if (!configLooksFilled()) {
    location.replace("setup.html");
    return null;
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { location.replace("index.html#signin"); return null; }

  const { data: profile } = await supabase
    .from("profiles").select("*").eq("id", user.id).single();

  if (expectedRole && profile?.role !== expectedRole) {
    location.replace(profile?.role === "faculty" ? "faculty.html" : "student.html");
    return null;
  }
  return { user, profile };
}

export async function signOut() {
  await supabase.auth.signOut();
  location.replace("index.html");
}

/** Downloads rows as a CSV file. */
export function downloadCsv(filename, header, rows) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [header.join(",")]
    .concat(rows.map((r) => r.map(cell).join(",")))
    .join("\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
