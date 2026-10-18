# Security policy

`flow.` is a local tool: it has no server, no accounts and no telemetry, and it never opens a
network listener. The only outbound requests it makes are the two you start by clicking inside
the setup wizard — an ffmpeg download from gyan.dev and, if you choose it, an engine download.

## What we treat as a bug

- Anything that lets a crafted media file run code, escape the app folder or read files the
  user did not select.
- A path traversal in the output folder, temp folder or the `/local/<path>` dev route.
- A command built from user input without proper argument separation (ffmpeg, ffprobe, RIFE,
  DAIN, PowerShell).
- Anything that installs, repairs or uninstalls outside the user's own profile without consent.
- An installer that ships an engine other than the one pinned in `tools/verify-payload.mjs`.

## What is out of scope

- Physical access to the machine, and anything a user's own antivirus/WebView2 policy allows.
- Vulnerabilities in upstream binaries we do not build (ffmpeg, rife-ncnn-vulkan) — report those
  upstream, and tell us so we can bump the pin.
- Unsigned-install complaints: the installers are intentionally unsigned, and the README says so.

## Reporting

Open a private report through GitHub's
[Report a vulnerability](https://github.com/RADINMNX2/aura-flow/security/advisories/new) form, or
DM [@RADINMNX2](https://github.com/RADINMNX2). Please do not file a public issue first.
Expect a reply within a week; this is a one-person project run in spare time, so fixes land when
they land — but a real report will not be ignored.
