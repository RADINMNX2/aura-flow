# Third-party notices

flow. is MIT licensed. It talks to, and ships alongside, these projects:

| Component | License | Use |
| --- | --- | --- |
| FFmpeg / ffprobe | LGPL/GPL depending on the build | probing, extraction, encoding, muxing |
| rife-ncnn-vulkan | MIT | frame interpolation engine (bundled in the flow. setup installer, license included) |
| DAIN ncnn-vulkan | MIT | depth-aware interpolation engine (discovered if installed) |
| Flowframes | MIT | optional source of additional engines/models; not required |
| Phosphor Icons | MIT | icon set, vendored under `assets/phosphor` |
| Lenis | MIT | smooth scrolling, vendored under `assets/lenis` |
| Bricolage Grotesque | SIL OFL 1.1 | display type |
| Instrument Sans | SIL OFL 1.1 | UI type |
| Geist Mono | SIL OFL 1.1 | numerals and logs |
| Vazirmatn | SIL OFL 1.1 | Persian type |

The flow. setup executable bundles the MIT-licensed **RIFE 4.26 ncnn-vulkan** binary and
weights, with its license text. The standalone app also discovers engines installed elsewhere
(Flowframes by default) or an engine folder pointed at with `FLOW_ENGINE_ROOT`. FFmpeg is not
bundled; setup uses the copy already on the machine or downloads an official gyan.dev build.
