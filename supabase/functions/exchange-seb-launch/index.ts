// Exchanges the one-time token received through sebs:// for a Supabase magic-link
// token, so the student is signed into the isolated SEB browser without typing the
// password again. Deploy this function with JWT verification disabled.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const { launch_token } = await req.json();
    const raw = String(launch_token ?? "");
    if (raw.length < 32 || raw.length > 200) {
      return json({ error: "Invalid secure launch token." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const tokenHash = await sha256(raw);

    // Atomic claim: only the first exchange can set used_at and receive the row.
    const { data: claimed, error: claimError } = await admin.from("seb_launch_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token_hash", tokenHash)
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("student_id, exam_id")
      .maybeSingle();

    if (claimError || !claimed) {
      return json({ error: "This secure launch link has expired or was already used." }, 401);
    }

    const { data: exam } = await admin.from("exams")
      .select("exam_code, starts_at, ends_at, is_published")
      .eq("id", claimed.exam_id).single();
    if (!exam || !exam.is_published ||
        Date.now() < new Date(exam.starts_at).getTime() ||
        Date.now() > new Date(exam.ends_at).getTime()) {
      return json({ error: "This exam is not open right now." }, 403);
    }

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(claimed.student_id);
    const email = userData.user?.email;
    if (userError || !email) return json({ error: "Student account could not be resolved." }, 500);

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const tokenHashForAuth = link?.properties?.hashed_token;
    if (linkError || !tokenHashForAuth) {
      return json({ error: "Could not create the SEB sign-in session." }, 500);
    }

    return json({
      token_hash: tokenHashForAuth,
      exam_code: exam.exam_code,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
