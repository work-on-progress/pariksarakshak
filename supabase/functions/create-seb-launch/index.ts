import { createClient } from "npm:@supabase/supabase-js@2";

const LAUNCH_TTL_MS = 5 * 60_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: authHeader },
        },
      },
    );

    const {
      data: { user },
    } = await supaUser.auth.getUser();

    if (!user) {
      return json(
        { error: "Sign in again before starting the exam." },
        401,
      );
    }

    const { data: profile } = await supaUser
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "student") {
      return json(
        { error: "Only student accounts can start an exam." },
        403,
      );
    }

    const { exam_code } = await req.json();

    const code = String(exam_code ?? "")
      .trim()
      .toUpperCase();

    if (!code) {
      return json({ error: "Enter the exam code." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: exam } = await admin
      .from("exams")
      .select(
        "id, exam_code, title, starts_at, ends_at, is_published, delivery_mode",
      )
      .eq("exam_code", code)
      .maybeSingle();

    if (!exam || !exam.is_published) {
      return json(
        { error: "No published exam has that code." },
        404,
      );
    }

    const now = Date.now();

    if (now < new Date(exam.starts_at).getTime()) {
      return json(
        { error: "This exam has not opened yet." },
        403,
      );
    }

    if (now > new Date(exam.ends_at).getTime()) {
      return json(
        { error: "This exam has already closed." },
        403,
      );
    }

    const { data: existing } = await admin
      .from("attempts")
      .select("status")
      .eq("exam_id", exam.id)
      .eq("student_id", user.id)
      .maybeSingle();

    if (existing?.status === "submitted") {
      return json(
        { error: "You have already submitted this paper." },
        403,
      );
    }

    // Remove older unused codes for the same student/exam.
    await admin
      .from("seb_launch_tokens")
      .delete()
      .eq("student_id", user.id)
      .eq("exam_id", exam.id)
      .is("used_at", null);

    const rawLaunchToken = randomToken(32);
    const tokenHash = await sha256(rawLaunchToken);

    const expiresAt = new Date(
      Date.now() + LAUNCH_TTL_MS,
    ).toISOString();

    // Try several random 6-digit codes in the unlikely event
    // that another active launch already has the same code.
    let entryCode = "";
    let inserted = false;

    for (let attempt = 0; attempt < 10; attempt++) {
      entryCode = randomEntryCode();

      const { error } = await admin
        .from("seb_launch_tokens")
        .insert({
          token_hash: tokenHash,
          entry_code: entryCode,
          student_id: user.id,
          exam_id: exam.id,
          expires_at: expiresAt,
        });

      if (!error) {
        inserted = true;
        break;
      }

      // 23505 = PostgreSQL unique violation.
      if (error.code !== "23505") {
        console.error(error);
        break;
      }
    }

    if (!inserted) {
      return json(
        { error: "Could not prepare the secure exam entry." },
        500,
      );
    }

    return json({
      launch_token: rawLaunchToken,
      entry_code: entryCode,
      exam_code: exam.exam_code,
      exam_title: exam.title,
      delivery_mode: exam.delivery_mode ?? "seb",
      expires_at: expiresAt,
    });
  } catch (e) {
    console.error(e);
    return json(
      { error: "Unexpected server error." },
      500,
    );
  }
});

function randomEntryCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);

  return String(
    100000 + (values[0] % 900000),
  );
}

function randomToken(bytes: number) {
  const buf = crypto.getRandomValues(
    new Uint8Array(bytes),
  );

  let binary = "";

  buf.forEach((b) => {
    binary += String.fromCharCode(b);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((b) =>
      b.toString(16).padStart(2, "0")
    )
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