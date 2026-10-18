## 0.6.7-dev.3 — 2026-10-18

Align Host peers with 0.2.1-rc.1 and drop the retired invariants peer. Retain usage views, billing detection and the Taskboard dialog integration.

Compatibility is restricted to `0.2.0-rc.2 || 0.2.1-rc.1`; no alpha or later Host is implied.

# Changelog

## [0.6.7-dev.2] - 2026-10-08

### Fixed

- 在 Taskboard 创建或编辑弹窗打开期间隐藏 Spend 悬浮组件，避免其层级拦截弹窗的输入与确认按钮；弹窗关闭后恢复组件。
