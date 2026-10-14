`desktop/overlay/resources/linux/code.png` (512x512) and `.../win32/code.ico` (16–256 px, PNG entries) were made from
`assets/logo.png`: pad to a square with a white background, then `sips -z <size> <size>` for 16, 32, 48, 64, 128, 256 and
assemble the ICO container (6-byte header, 16-byte directory entries, PNG payloads). Regenerate when the logo changes.
