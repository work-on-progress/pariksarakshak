// public/js/supabaseClient.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    return await res.json();
  } catch (e) {
    return { error: `Could not reach the server. Check the connection and try again. (${e})` };
  }
}

/** Returns { user, profile } or redirects to the sign-in page. */
export async function requireUser(expectedRole) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { location.replace("index.html#signin"); return null; }
  const { data: profile } = await supabase
    .from("profiles").select("*").eq("id", user.id).single();
  if (expectedRole && profile?.role !== expectedRole) {
    location.replace(profile?.role === "faculty" ? "faculty.html" : "exam.html");
    return null;
  }
  return { user, profile };
}

export async function signOut() {
  await supabase.auth.signOut();
  location.replace("index.html");
}
