# DLSS 5 Swapper Linux v2.2.9-linux.1

First official Linux release of DLSS 5 Swapper, providing Linux-native and Proton support while keeping the repository clean of proprietary NVIDIA binaries.

## Highlights
- **Native Linux Build**: Packaged as AppImage, DEB, and RPM for Fedora, Ubuntu/Debian, and other distributions.
- **Dual Engine Support**: Full support for ReShade / RenoDX / Feeder routes under Proton and DLSS5VKLayer (`dlssnr`) for native Vulkan and Proton titles.
- **Steam Overlay Compatibility**: Preserves Steam's process hierarchy (`gameoverlayrenderer.so`) so the Shift+Tab overlay works seamlessly during active gameplay.
- **Hardware Verified**: Verified end-to-end on NVIDIA GeForce RTX 5070 hardware with active neural rendering (`feature 18 created`, `nr[evals=3000]`).
- **Clean Distribution**: Proprietary NVIDIA binaries are not redistributed; payloads are fetched on demand from upstream releases and verified with SHA-256 checksums.
- **Upstream Sync & Tracking**: Includes `scripts/sync-upstream.sh` to track `rakanki911/DLSS5-Swapper` and automated GitHub release checking for base and addon components.
- **Community Chat**: Full integration with the upstream community chat backend (`https://5.rakanki.com`) with privacy opt-in.

## Package Checksums (SHA-256)
- **AppImage**: `c0e4bd4414b9ffd4aa716a624c4d8626a73c8fd0ba218b78f03a8e8e2e6a11ba`  `DLSS5-Swapper-Linux-2.2.9-linux.1.AppImage`
- **DEB**: `bb0e00972e4cdbf950daf19d2bb37a491ee9c90b529aebad04d669e884fd9dec`  `DLSS5-Swapper-Linux-2.2.9-linux.1-amd64.deb`
- **RPM**: `6b880ec18765954a7c29571ff5204c35e3ca4457e51ca2d5f0b40eb25c7ce1a5`  `DLSS5-Swapper-Linux-2.2.9-linux.1-x86_64.rpm`
