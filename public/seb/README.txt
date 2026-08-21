Save the Safe Exam Browser configuration you build into THIS folder, named:

    pariksarakshak.seb

The student portal launches:

    sebs://<your-domain>/seb/pariksarakshak.seb?launch=<one-time-token>

Two settings in the SEB Configuration Tool make that work:

  Exam tab     → Allow Query Parameter        (carries the launch token)
  Browser tab  → Enable JavaScript API        (lets the page prove it is SEB)

After saving the file, read its Config Key from the Exam tab and store it:

    supabase secrets set SEB_CONFIG_KEY=<the 64-character key>
    supabase functions deploy verify-seb

The file encrypts its passwords, but treat it as sensitive anyway. Anyone with
it can open a locked browser; nobody with it can open a paper, because the
launch token is minted per student, per exam, and lasts two minutes.
