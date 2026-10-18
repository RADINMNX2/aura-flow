# engine-pack

Binary payload for the flow. setup wizard. Not source - this orphan branch exists so CI can check these four files into
setup/src-tauri/payload/ without putting 18 MB of weights in the main history.

The build verifies every byte against the sha256 pins in tools/verify-payload.mjs on
main (.github/workflows/release.yml), so a mismatched engine fails the release instead of shipping it.

Files: rife-ncnn-vulkan.exe (MIT, nihui/rife-ncnn-vulkan) + rife-v4.26/flownet.{bin,param} weights + license.
