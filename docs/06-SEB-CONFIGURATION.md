# 6 · Safe Exam Browser configuration

One file, built once, locks every machine in the lab. This is the layer that actually
stops screenshots, Alt+Tab, screen recorders, second monitors and virtual machines —
things a web page can never truly stop.

## 6.1 Install

- Download **SEB for Windows** (3.x) from https://safeexambrowser.org/download_en.html
- Install it on your own machine for authoring, and on every lab machine.
- The installer also provides the **SEB Configuration Tool** in the Start menu.

## 6.2 Build the configuration

Open the SEB Configuration Tool and set the following. Anything not listed stays at its
default.

### General
| Setting | Value |
|---|---|
| Start URL | `https://your-app.vercel.app/exam.html` |
| Administrator password | a strong password — protects the configuration itself |
| Quit password | a **different** strong password — only invigilators know it |
| Allow user to quit SEB | yes, but quitting demands the password above |

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
| **Enable JavaScript API** | **yes** — this is what `anticheat.js` detects |
| User agent suffix | leave default; it carries the `SEB` marker |

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
| Prohibited processes | `obs64.exe`, `obs32.exe`, `obs.exe`, `SnippingTool.exe`, `ScreenSketch.exe`, `Teams.exe`, `Discord.exe`, `AnyDesk.exe`, `TeamViewer.exe`, `chrome.exe`, `msedge.exe`, `firefox.exe`, `mstsc.exe`, `vlc.exe`, `bandicam.exe`, `ShareX.exe` |

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

Everything else is blocked once filtering is on.

> If the exam page loads but looks plain, or the camera never starts, one of these
> domains is missing. The SEB log is at `%LocalAppData%\SafeExamBrowser\Logs`.

### Security
| Setting | Value |
|---|---|
| Kiosk mode | **create new desktop** — the strongest option; it also defeats virtual desktops |
| Allow virtual machine | no — SEB then refuses to start inside VMware or VirtualBox |
| Screen sharing and remote sessions | no |
| Screen capture / screen proctoring | **off** — Windows capture protection then makes the SEB window record and screenshot as black |
| Clipboard | block |
| Windows updates and notifications | no |
| Camera | **allow** — the local face check needs it |

### Registry and hooked keys
Disable: Alt+Tab, the Windows keys, PrintScreen, Alt+F4, Esc, F1 to F12, and every
Ctrl+Alt+Del menu option.

## 6.3 Save and hand out

1. **File → Save As…** → `pariksarakshak.seb`, into the `seb/` folder or straight to
   your department share.
2. Distribute by share drive or USB. Students double-click the file and the machine
   opens into the exam page with nowhere else to go.

One file serves every exam you will ever run, because the start URL is the generic exam
page and the exam code is typed inside the app. You never rebuild it per paper.

## 6.4 What SEB handles on its own

- **Second monitors** are blanked in create-new-desktop kiosk mode.
- **Virtual machines** are detected and refused.
- **Screen capture** produces black frames, in screenshots and in recordings alike.
- **Overlay applications** — game overlays, chat overlays, remote-desktop helpers — are
  killed by the prohibited process list before the exam can start.

## 6.5 Test protocol — run every step on one machine

1. Double-click the `.seb` file. The machine locks into the exam page, full screen, no
   taskbar.
2. Press PrintScreen, Win+Shift+S, Alt+Tab, Win+Tab, Ctrl+Alt+Del and F12. Nothing
   useful happens.
3. Start OBS first, then the `.seb` file. SEB must refuse to start.
4. The exam page must **not** show "Open this exam in Safe Exam Browser" — if it does,
   the JavaScript API is off in the Browser tab.
5. Quit SEB. It must ask for the quit password.
6. Repeat inside VirtualBox. SEB must refuse to run.

✅ **Done when** all six pass.

Next → [07 · Deployment checklist](07-DEPLOYMENT-CHECKLIST.md)
