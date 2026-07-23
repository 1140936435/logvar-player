## mplay v1.2.0 Update Notes

### New Features

- **Portrait Video Detection & Playback Optimization**: Auto-detect portrait videos (9:16), support "Full Frame Display" (contain) and "Fill to Screen" (cover) dual modes
- **Portrait Background Blur Fill**: Real-time Canvas video frame capture as blurred background, reducing visual disconnect
- **Portrait Custom Control Bar**: Larger buttons, optimized spacing, frosted glass semi-transparent effect, smart auto-hide/float
- **Danmaku System Upgrade**: Real-time danmaku display and interaction
- **Poster Loading Architecture Refactor**: Virtual scrolling grid, DOM nodes reduced from hundreds to ~20
- **Three-tier Poster Cache**: Browser cache -> Memory cache (100MB LRU) -> Disk cache (500MB LRU)
- **Full WebP Support**: 30-50% image size reduction

### Bug Fixes

- Fix Jellyfin API /Users/Me 400 error, add /Users endpoint fallback
- Fix player state management, optimize play/pause/progress control
- Fix homepage poster loading lag, add concurrent request control (max 6)
- Fix LazyImage component dependency error

### Performance

- Virtual scrolling for homepage, significantly reduce DOM nodes
- Image concurrent request control (max 6), prevent network congestion
- Memory and disk cache with LRU eviction strategy
- Dynamic image resolution, load appropriate size based on container
- All sync I/O migrated to async fs.promises, eliminate main process blocking
- MediaCard uses CSS transitions instead of framer-motion, reducing CPU usage

### Compatibility

- Support Emby and Jellyfin servers
- Windows 10/11 64-bit
- Electron 33.x runtime

### Download

- **mplay-1.2.0-setup.exe** -- Windows installer