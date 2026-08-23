// public/js/student.js

import {
  supabase,
  callFunction,
  requireUser,
  signOut,
  escapeHtml,
} from "./supabaseClient.js";

import {
  INSTITUTE_NAME,
  SEB_CONFIG_FILE,
} from "./config.js";


let user;
let profile;
let busy = false;

const msg =
  document.getElementById("portalMsg");

const list =
  document.getElementById("examList");

const codeInput =
  document.getElementById("examCode");

const startBtn =
  document.getElementById("startByCodeBtn");


boot();


async function boot() {

  const auth =
    await requireUser("student");

  if (!auth) {
    return;
  }

  ({
    user,
    profile,
  } = auth);


  document
    .getElementById("instituteTag")
    .textContent =
    INSTITUTE_NAME;


  document
    .getElementById("whoami")
    .textContent =
    `${profile.full_name || user.email}${
      profile.roll_no
        ? " · " + profile.roll_no
        : ""
    }`;


  document
    .getElementById("signOutBtn")
    .onclick =
    signOut;


  startBtn.onclick =
    () =>
      startSecureExam(
        codeInput.value,
      );


  codeInput.addEventListener(
    "keydown",
    (e) => {

      if (e.key === "Enter") {

        startSecureExam(
          codeInput.value,
        );
      }
    },
  );


  await loadPapers();


  setInterval(
    loadPapers,
    60000,
  );
}


/* ══════════════════════════════════════════════
   AVAILABLE EXAMS
══════════════════════════════════════════════ */

async function loadPapers() {

  const {
    data,
    error,
  } =
    await supabase
      .from("exams")
      .select(
        "id, title, exam_code, duration_min, starts_at, ends_at",
      )
      .order(
        "starts_at",
        {
          ascending: true,
        },
      );


  if (error) {

    list.innerHTML =
      `<p class="notice error">
        ${escapeHtml(error.message)}
      </p>`;

    return;
  }


  const {
    data: mine,
  } =
    await supabase
      .from("attempts")
      .select(
        "exam_id, status",
      )
      .eq(
        "student_id",
        user.id,
      );


  const status = {};


  (mine ?? [])
    .forEach(
      (a) => {

        status[
          a.exam_id
        ] = a.status;
      },
    );


  document
    .getElementById("liveCount")
    .textContent =
    data?.length
      ? `${data.length} open now`
      : "nothing open";


  if (!data?.length) {

    list.innerHTML = `
      <p class="empty">
        No paper is open for you right now.
        It appears here the moment your teacher opens it.
      </p>
    `;

    return;
  }


  list.innerHTML = "";


  data.forEach(
    (exam) => {

      const done =
        status[exam.id];


      const card =
        document.createElement(
          "article",
        );


      card.className =
        "student-exam-card";


      card.innerHTML = `

        <div>

          <span class="tag blue">
            ${escapeHtml(exam.exam_code)}
          </span>

          <h3>
            ${escapeHtml(exam.title)}
          </h3>

          <p class="meta">
            ${exam.duration_min} minutes
            · closes ${when(exam.ends_at)}
          </p>

        </div>

        <div class="card-action"></div>
      `;


      const slot =
        card.querySelector(
          ".card-action",
        );


      if (
        done === "submitted"
      ) {

        slot.innerHTML =
          `<span class="tag pass">submitted</span>`;

      } else {

        const btn =
          document.createElement(
            "button",
          );


        btn.className =
          "btn";


        btn.textContent =
          done === "in_progress"
            ? "Resume in SEB"
            : "Start secure exam";


        btn.onclick =
          () =>
            startSecureExam(
              exam.exam_code,
            );


        slot.appendChild(
          btn,
        );
      }


      list.appendChild(
        card,
      );
    },
  );
}


/* ══════════════════════════════════════════════
   CREATE SECURE ENTRY
══════════════════════════════════════════════ */

async function startSecureExam(
  rawCode,
) {

  if (busy) {
    return;
  }


  const examCode =
    String(
      rawCode || "",
    )
      .trim()
      .toUpperCase();


  if (!examCode) {

    return show(
      "Type the exam code, or pick a paper above.",
    );
  }


  hide();

  setBusy(true);


  try {

    /*
     * Make sure the .seb file exists.
     */
    const present =
      await fetch(
        `/seb/${SEB_CONFIG_FILE}`,
        {
          method: "HEAD",
          cache: "no-store",
        },
      )
        .catch(
          () => null,
        );


    if (!present?.ok) {

      return show(
        "The Safe Exam Browser configuration has not been published on this site yet. Tell the invigilator.",
      );
    }


    /*
     * Server now returns:
     *
     * launch_token
     * entry_code
     * exam_code
     * expires_at
     */
    const res =
      await callFunction(
        "create-seb-launch",
        {
          exam_code:
            examCode,
        },
      );


    if (res.error) {

      return show(
        res.error,
      );
    }


    if (!res.entry_code) {

      return show(
        "The server did not return a secure entry code. The launch function needs to be redeployed.",
      );
    }


    /*
     * Keep the sebs:// launch available.
     *
     * If the browser passes the query parameter correctly,
     * SEB will still auto-login.
     *
     * If the browser downloads the .seb file instead,
     * the student can manually open it and type the 6-digit code.
     */
    const launch =
      new URL(
        `/seb/${SEB_CONFIG_FILE}`,
        location.origin,
      );


    launch.protocol =
      location.protocol === "https:"
        ? "sebs:"
        : "seb:";


    launch.searchParams.set(
      "launch",
      res.launch_token,
    );


    /*
     * IMPORTANT:
     * Display the 6-digit code prominently.
     */
    msg.className =
      "notice ok";


    msg.innerHTML = `

      <div style="text-align:left">

        <b>
          Secure exam entry is ready
        </b>

        <p style="margin:.6rem 0">
          Your temporary secure code is:
        </p>

        <div
          style="
            font-family:JetBrains Mono,monospace;
            font-size:2rem;
            font-weight:700;
            letter-spacing:.35rem;
            padding:.8rem 1rem;
            border:2px solid currentColor;
            border-radius:12px;
            display:inline-block;
            margin:.3rem 0 .9rem;
          "
        >
          ${escapeHtml(res.entry_code)}
        </div>

        <p style="margin:.2rem 0 .8rem">
          Keep this screen open.
          The code works once and expires shortly.
        </p>

        <a
          class="btn"
          href="${escapeHtml(launch.toString())}"
        >
          Open Safe Exam Browser
        </a>

        <div
          class="meta"
          style="margin-top:.9rem;line-height:1.5"
        >
          If your browser downloads the
          <b>.seb</b> file instead of opening SEB automatically:
          <br>
          1. Open the downloaded file.
          <br>
          2. Safe Exam Browser will show
          <b>Enter secure exam code</b>.
          <br>
          3. Type
          <b>${escapeHtml(res.entry_code)}</b>.
          <br>
          Do not enter your username or password again.
        </div>

      </div>
    `;


    msg.classList
      .remove("hidden");


    setBusy(false);

  } catch (e) {

    console.error(e);


    show(
      "Could not prepare the secure exam. Please try again.",
    );

  } finally {

    setBusy(false);
  }
}


/* ══════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════ */

function setBusy(on) {

  busy = on;


  startBtn.disabled =
    on;


  startBtn.textContent =
    on
      ? "Preparing secure entry…"
      : "Start secure exam";


  list
    .querySelectorAll(
      "button",
    )
    .forEach(
      (b) => {

        b.disabled =
          on;
      },
    );
}


function show(
  text,
  kind = "error",
) {

  msg.textContent =
    text;


  msg.className =
    `notice ${kind}`;


  msg.classList
    .remove("hidden");
}


function hide() {

  msg.classList
    .add("hidden");
}


function when(v) {

  return new Date(v)
    .toLocaleString(
      [],
      {
        dateStyle:
          "medium",

        timeStyle:
          "short",
      },
    );
}