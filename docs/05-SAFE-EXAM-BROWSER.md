# 05 · Safe Exam Browser

One file, built once, locks every machine in the lab. This is the layer that stops
screenshots, Alt+Tab, screen recorders, second monitors and virtual machines —
things a web page can never truly stop.

Students never open this file by hand. It lives on your website at
`/seb/pariksarakshak.seb`, and the **Start secure exam** button launches it
through a `sebs://` link with a one-time token attached. Guide 09 explains that
flow; this guide builds the file it needs.

## Install

Download **SEB for Windows** (3.x) from https://safeexambrowser.org/download_en.html
and install it on your own machine and every lab machine. The installer also gives
you the **SEB Configuration Tool** in the Start menu.

## Build the configuration

Open the SEB Configuration Tool. Anything not listed stays at its default.

### General
| Setting | Value |
|---|---|
| Start URL | `https://your-app.vercel.app/exam.html` |
| Administrator password | strong — protects the configuration itself |
| Quit password | a **different** strong password; only invigilators know it |
| Allow user to quit SEB | yes, but quitting demands that password |

### Config File
| Setting | Value |
|---|---|
| Use SEB settings file for | starting an exam |
| Allow opening preferences on the client | no |

### User Interface
| Setting | Value |
|---|---|
| Browser view mode | full screen |
| Browser window toolbar | off |
| Taskbar | off |
| Reload button | off — the page autosaves, so reloading has no purpose |
| Show time | on |
| Zoom | on, for accessibility |

### Browser
| Setting | Value |
|---|---|
| Navigate back and forward | no |
| JavaScript | yes |
| Plug-ins | no |
| Spell checking | no |
| **Enable JavaScript API** | **yes, required** — this is how the page proves it is SEB. With it off, every student is blocked |
| User agent suffix | leave default; it carries the `SEB` marker |

### Exam
| Setting | Value |
|---|---|
| **Allow Query Parameter** | **yes, required** — carries the one-time launch token from the portal to the exam page. With it off, students must type the exam code by hand |
| Config Key | note the 64-character value; it goes on the server (below) |

### Down/Uploads
| Setting | Value |
|---|---|
| Downloading and uploading files | no |
| PDF reader | no |

### Applications
| Setting | Value |
|---|---|
| Monitor processes | yes |
| Switching to third-party applications | no |
| Prohibited processes | `obs64.exe`, `obs32.exe`, `obs.exe`, `SnippingTool.exe`, `ScreenSketch.exe`, `Teams.exe`, `Discord.exe`, `AnyDesk.exe`, `TeamViewer.exe`, `chrome.exe`, `msedge.exe`, `firefox.exe`, `mstsc.exe`, `vlc.exe`, `bandicam.exe`, `ShareX.exe`, `Zoom.exe`, `WhatsApp.exe` |

### Network → Filter
Turn URL filtering **on** and allow exactly these:

```
your-app.vercel.app/*
*.supabase.co/*
cdn.jsdelivr.net/*          ← Supabase client and MediaPipe
cdnjs.cloudflare.com/*      ← the code editor
storage.googleapis.com/*    ← the face-detection model
fonts.googleapis.com/*      ← typefaces
fonts.gstatic.com/*         ← typefaces
```

> If the page loads but looks plain, or the camera never starts, one of these is
> missing. The SEB log is at `%LocalAppData%\SafeExamBrowser\Logs`.

### Security
| Setting | Value |
|---|---|
| Kiosk mode | **create new desktop** — strongest, and it defeats virtual desktops |
| Allow virtual machine | no — SEB then refuses to start inside VMware or VirtualBox |
| Screen sharing and remote sessions | no |
| Screen capture / screen proctoring | **off** — Windows capture protection then makes the window record and screenshot as black |
| Clipboard | block |
| Windows updates and notifications | no |
| Camera | **allow** — the local face check needs it |

### Registry and hooked keys
Disable Alt+Tab, the Windows keys, PrintScreen, Alt+F4, Esc, F1 to F12, and every
Ctrl+Alt+Del menu option.

## Save it into the website

**File → Save As…** → save as **`public/seb/pariksarakshak.seb`** inside the
project folder, then commit it. Vercel serves it, and the portal's launch button
builds its link from that exact path. Nothing is copied to lab machines; only SEB
itself has to be installed there.

If you rename the file, change `SEB_CONFIG_FILE` in `public/js/config.js` to match.

One file serves every exam you will ever run: the start URL is the generic exam
page, and the portal tells it which paper to open.

## Give the server the Config Key

On the **Exam** tab, copy the **Config Key**. This is what lets the server tell
your configuration apart from a copied or home-made one.

```bash
supabase secrets set SEB_CONFIG_KEY=<paste the 64-character key>
supabase functions deploy verify-seb --no-verify-jwt
```

The exam page asks SEB for the Config Key of the current URL and sends it to
`verify-seb`, which recomputes the hash with the secret and compares. A student
who copies your `.seb` file, edits it to remove the restrictions, and points it at
your exam page produces a different key — and the paper does not open.

**Every time you rebuild the configuration the key changes.** Set the secret
again and redeploy `verify-seb`, or every student will be blocked at once.

## Test protocol — all seven on one machine

1. From the student portal in ordinary Chrome, press **Start secure exam** and
   approve the prompt. The machine locks into the paper, full screen, no taskbar,
   already signed in.
2. Press PrintScreen, Win+Shift+S, Alt+Tab, Win+Tab, Ctrl+Alt+Del, F12. Nothing
   useful happens.
3. Start OBS first, then the `.seb` file. SEB must refuse to start.
4. The paper must open, not the block screen. If it does not, the JavaScript API
   is off, or `SEB_CONFIG_KEY` does not match this build of the file.
5. Quit SEB. It must ask for the quit password.
6. Repeat inside VirtualBox. SEB must refuse to run.
7. Open `https://your-app.vercel.app/exam.html` in ordinary Chrome. It must refuse
   and send you back to the portal.

## What SEB handles by itself

- **Second monitors** are blanked in create-new-desktop kiosk mode.
- **Virtual machines** are detected and refused.
- **Screen capture** produces black frames, in screenshots and recordings alike.
- **Overlay apps** — game overlays, chat overlays, remote-desktop helpers — are
  killed by the prohibited process list before the exam can start.
