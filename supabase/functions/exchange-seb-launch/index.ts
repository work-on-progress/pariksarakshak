import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const { launch_token } = await req.json();
    const rawLaunchToken = String(launch_token ?? "");

    if (rawLaunchToken.length < 32 || rawLaunchToken.length > 200) {
      return json({ error: "Invalid secure launch token." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const launchHash = await sha256(rawLaunchToken);
    const nowIso = new Date().toISOString();

    const { data: claimed, error: claimError } = await admin
      .from("seb_launch_tokens")
      .update({ used_at: nowIso })
      .eq("token_hash", launchHash)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .select("student_id, exam_id")
      .maybeSingle();

    if (claimError || !claimed) {
      return json(
        { error: "This secure launch link has expired or was already used." },
        401,
      );
    }

    const { data: exam, error: examError } = await admin
      .from("exams")
      .select("id, exam_code, starts_at, ends_at, is_published")
      .eq("id", claimed.exam_id)
      .single();

    if (
      examError ||
      !exam ||
      !exam.is_published ||
      Date.now() < new Date(exam.starts_at).getTime() ||
      Date.now() > new Date(exam.ends_at).getTime()
    ) {
      return json({ error: "This exam is not open right now." }, 403);
    }

    const { data: submittedAttempt } = await admin
      .from("attempts")
      .select("id")
      .eq("student_id", claimed.student_id)
      .eq("exam_id", claimed.exam_id)
      .eq("status", "submitted")
      .maybeSingle();

    if (submittedAttempt) {
      return json({ error: "This exam has already been submitted." }, 403);
    }

    await admin
      .from("seb_exam_sessions")
      .update({ revoked_at: nowIso })
      .eq("student_id", claimed.student_id)
      .eq("exam_id", claimed.exam_id)
      .is("revoked_at", null);

    const rawSessionToken = randomToken();
    const sessionHash = await sha256(rawSessionToken);

    const { error: sessionError } = await admin
      .from("seb_exam_sessions")
      .insert({
        session_hash: sessionHash,
        student_id: claimed.student_id,
        exam_id: claimed.exam_id,
        expires_at: exam.ends_at,
      });

    if (sessionError) {
      console.error("Could not create SEB session:", sessionError);
      return json({ error: "Could not create the secure exam session." }, 500);
    }

    const { data: userData, error: userError } =
      await admin.auth.admin.getUserById(claimed.student_id);

    const email = userData.user?.email;

    if (userError || !email) {
      return json({ error: "Student account could not be resolved." }, 500);
    }

    const { data: link, error: linkError } =
      await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
      });

    const authTokenHash = link?.properties?.hashed_token;

    if (linkError || !authTokenHash) {
      return json({ error: "Could not create the SEB sign-in session." }, 500);
    }

    return json({
      token_hash: authTokenHash,
      session_token: rawSessionToken,
      exam_code: exam.exam_code,
      exam_id: exam.id,
      expires_at: exam.ends_at,
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Unexpected server error." }, 500);
  }
});

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}