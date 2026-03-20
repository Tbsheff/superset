# Plan: Restty Terminal Migration

**Generated**: 2026-03-19
**Estimated Complexity**: Medium (code exists, needs reconciliation)

## Decision: restty vs ghostty-web vs cherry-pick

### Option A: Cherry-pick backup commits (NOT recommended)
- 26 conflicting files across 4 commits
- 428 commits of main drift since branch point
- Modify/delete conflicts on link-providers and headless-emulator
- `bun.lock` conflicts on every commit
- **Verdict: Too painful. The conflicts require deep judgment calls.**

### Option B: ghostty-web drop-in (NOT recommended)
- Canvas 2D renderer (inferior to WebGPU)
- Active WASM memory corruption bugs (multi-codepoint graphemes, viewport data corruption)
- Last npm release Dec 2025 — 3+ month gap
- No search, no serialize, no ligatures
- **Verdict: Active bugs + stale releases = production risk.**

### Option C: Fresh restty port using backup as reference (RECOMMENDED)
- Backup code is clean, complete, and reusable as reference
- Apply diffs file-by-file onto current main (not cherry-pick)
- Preserves all 428 commits of main improvements (auto-retry, URL handling, etc.)
- restty v0.1.34 hasn't changed since backup was written
- Search feature landed in restty git (Mar 16), pending npm release
- WebGPU rendering, text shaping, plugin system
- **Verdict: Best of both worlds — proven implementation + current main.**

## Overview

Port the restty terminal implementation from `backup/main-before-reset` onto current `main`, file-by-file. The backup has 4 commits with complete Phase 1 (renderer) and Phase 2 (daemon) implementations. Since main has diverged significantly (428 commits, 30+ terminal files changed), we apply the restty changes manually using the backup diffs as a guide rather than cherry-picking.

## Prerequisites

- `backup/main-before-reset` branch accessible locally
- restty v0.1.34: `bun add restty@^0.1.34`
- Remove 10 xterm packages from package.json
- Electron 40+ (WebGPU support via Chromium)

## Reference Files (backup branch)

Key files to port from `git show backup/main-before-reset:<path>`:
- `Terminal/restty/ResttyAdapter.ts` — core adapter (~200 lines)
- `Terminal/restty/SearchShim.ts` — viewport search (~270 lines)
- `Terminal/restty/TrpcPtyTransport.ts` — PTY bridge (~90 lines)
- `Terminal/restty/ResttyLinkDetector.ts` — link detection (~484 lines)
- `Terminal/restty/click-to-move.ts` — cursor movement (~70 lines)
- `Terminal/restty/index.ts` — barrel export
- `terminal-host/wasm-headless-emulator.ts` — daemon VT (~443 lines)
- `terminal-host/wasm-serializer.ts` — session serialize (~503 lines)
- `terminal-host/wasm-vt.ts` — WASM loader (~56 lines)

---

## Sprint 1: Renderer — Core Terminal Swap

**Goal**: Terminal renders via restty WebGPU instead of xterm.js
**Demo/Validation**:
- Open a terminal tab, type commands, see output
- Colors, cursor, scrollback all work
- No xterm.js imports in renderer

### Task 1.1: Add restty, remove xterm packages
- **Location**: `apps/desktop/package.json`
- **Description**: `bun add restty@^0.1.34`, remove all 10 `@xterm/*` packages
- **Dependencies**: None
- **Validation**: `bun install` succeeds

### Task 1.2: Add WASM asset handling to Vite config
- **Location**: `apps/desktop/electron.vite.config.ts`
- **Description**: Add `.wasm` to asset handling for restty's libghostty-vt WASM binary. Reference: backup's config changes in `f39f4887`
- **Dependencies**: 1.1
- **Validation**: Vite builds without WASM errors

### Task 1.3: Port ResttyAdapter and supporting files
- **Location**: `apps/desktop/src/renderer/.../Terminal/restty/`
- **Description**: Copy these files from backup, adapting to current main's types:
  - `ResttyAdapter.ts` — core xterm.js API surface reimplemented on restty
  - `TrpcPtyTransport.ts` — bridges tRPC PTY subscription to restty
  - `click-to-move.ts` — cursor movement via mouse
  - `index.ts` — barrel export
- **Dependencies**: 1.1
- **Validation**: Files compile with `bun run typecheck`

### Task 1.4: Update helpers.ts
- **Location**: `apps/desktop/src/renderer/.../Terminal/helpers.ts`
- **Description**: Replace `createTerminalInstance()` to use ResttyAdapter instead of `new XTerm()`. Remove WebGL loader, addon loading, all xterm-specific setup. Keep the feature additions from main (auto-retry, URL click handler). Use backup diff as reference.
- **Dependencies**: 1.3
- **Acceptance Criteria**:
  - No `@xterm/xterm` imports remain
  - `createTerminalInstance()` returns a restty-based terminal
  - Auto-retry and URL click handler preserved

### Task 1.5: Update Terminal.tsx and hooks
- **Location**: `Terminal.tsx`, `useTerminalLifecycle.ts`, `useTerminalStream.ts`, `useTerminalRefs.ts`, `useTerminalHotkeys.ts`, `useTerminalColdRestore.ts`, `useTerminalRestore.ts`
- **Description**: Swap xterm types/refs for restty equivalents. Most hooks are type-only changes. `useTerminalLifecycle.ts` is the most complex — needs restty initialization, event wiring, resize handling.
- **Dependencies**: 1.4
- **Validation**: Terminal renders, typing works, output displays

### Task 1.6: Update terminal theme
- **Location**: `stores/theme/utils/terminal-theme.ts`, `stores/theme/store.ts`
- **Description**: Change `toXtermTheme()` → `toResttyTheme()` returning Ghostty theme format. Reference: backup's `3951e586`
- **Dependencies**: 1.5
- **Validation**: Terminal colors match current theme

### Task 1.7: Update config.ts
- **Location**: `Terminal/config.ts`
- **Description**: Replace `ITerminalOptions` with restty config schema. Map option names.
- **Dependencies**: 1.5
- **Validation**: Font size, cursor style, scrollback all configurable

### Task 1.8: Remove xterm.css import
- **Location**: `Terminal.tsx`
- **Description**: Remove `import "@xterm/xterm/css/xterm.css"`. Restty manages its own styles.
- **Dependencies**: 1.5
- **Validation**: No visual regression

---

## Sprint 2: Renderer — Features

**Goal**: Search, links, scroll-to-bottom, and ScrollToBottomButton all work
**Demo/Validation**:
- Cmd+F opens search, finds text in terminal
- File paths and URLs are clickable
- Scroll-to-bottom button appears when scrolled up

### Task 2.1: Port SearchShim
- **Location**: `Terminal/restty/SearchShim.ts`, `Terminal/TerminalSearch/TerminalSearch.tsx`
- **Description**: Port the viewport search shim from backup. Update TerminalSearch component to use SearchShim instead of `@xterm/addon-search`. Currently viewport-only; full scrollback search will come when restty publishes the WASM search ABI.
- **Dependencies**: Sprint 1
- **Validation**: Cmd+F finds visible text, next/prev navigation works

### Task 2.2: Port ResttyLinkDetector
- **Location**: `Terminal/restty/ResttyLinkDetector.ts`
- **Description**: Port link detection from backup. Reconcile with main's updated link-provider implementations (file-path, URL, multi-line). Main extended these since the backup — merge the improvements.
- **Dependencies**: Sprint 1
- **Validation**: File paths and URLs are highlighted and clickable

### Task 2.3: Update ScrollToBottomButton
- **Location**: `Terminal/ScrollToBottomButton/ScrollToBottomButton.tsx`
- **Description**: Replace xterm buffer/scroll API calls with restty equivalents.
- **Dependencies**: Sprint 1
- **Validation**: Button shows when scrolled up, clicking scrolls to bottom

### Task 2.4: Handle suppressQueryResponses
- **Location**: `Terminal/suppressQueryResponses.ts`
- **Description**: Verify restty's ghostty-vt handles CPR/focus/mode reports natively. If yes, delete this file. If not, port using restty's parser hooks.
- **Dependencies**: Sprint 1
- **Validation**: No garbage text from VT query responses

### Task 2.5: Update commandBuffer
- **Location**: `Terminal/commandBuffer.ts`
- **Description**: Replace `xterm.buffer.active.getLine()` with restty buffer access API.
- **Dependencies**: Sprint 1
- **Validation**: Tab titles reflect running command

---

## Sprint 3: Daemon — Headless WASM VT

**Goal**: Terminal session persistence works via WASM VT instead of @xterm/headless
**Demo/Validation**:
- Close and reopen terminal tab — scrollback preserved
- Cold restart app — terminal history restored
- No `@xterm/headless` imports in main process

### Task 3.1: Port wasm-vt.ts
- **Location**: `main/lib/terminal-host/wasm-vt.ts`
- **Description**: WASM loader singleton from backup. Initializes libghostty-vt WASM for headless use in Bun/Node.
- **Dependencies**: 1.1
- **Validation**: WASM loads in main process

### Task 3.2: Port wasm-headless-emulator.ts
- **Location**: `main/lib/terminal-host/wasm-headless-emulator.ts`
- **Description**: Replace `HeadlessEmulator` (xterm-based) with `WasmHeadlessEmulator` (restty WASM). Reconcile with main's current `headless-emulator.ts` — main added features since the backup.
- **Dependencies**: 3.1
- **Validation**: Terminal state tracked server-side

### Task 3.3: Port wasm-serializer.ts
- **Location**: `main/lib/terminal-host/wasm-serializer.ts`
- **Description**: Custom serializer replacing `@xterm/addon-serialize`. Reads WASM VT state to produce ANSI string for cold restore.
- **Dependencies**: 3.2
- **Validation**: `serialize()` produces valid ANSI that restores terminal state

### Task 3.4: Update session.ts and daemon
- **Location**: `main/terminal-host/session.ts`, `main/terminal-host/index.ts`
- **Description**: Wire `WasmHeadlessEmulator` into the session lifecycle. Remove `@xterm/headless` imports. Delete `xterm-env-polyfill.ts`.
- **Dependencies**: 3.2, 3.3
- **Validation**: Sessions create, persist, and restore

---

## Sprint 4: Cleanup and Tests

**Goal**: No xterm.js references remain, all tests pass
**Demo/Validation**:
- `bun run typecheck` passes
- `bun run lint:fix` clean
- All terminal tests pass
- `grep -r "@xterm" src/` returns nothing

### Task 4.1: Remove dead xterm code
- **Description**: Delete any remaining xterm-specific files, imports, types
- **Dependencies**: Sprints 1-3
- **Validation**: No `@xterm` imports in codebase

### Task 4.2: Update tests
- **Location**: All test files in Terminal/ and terminal-host/
- **Description**: Update mocks, types, and assertions for restty APIs
- **Dependencies**: 4.1
- **Validation**: All tests pass

### Task 4.3: Verify package.json is clean
- **Description**: Confirm all 10 `@xterm/*` packages removed, `restty` is the only terminal dep
- **Dependencies**: 4.1
- **Validation**: `bun install` clean, no orphan xterm deps

---

## Testing Strategy

- **Per sprint**: Run the demo/validation checklist
- **Regression**: Full terminal workflow — open tab, type commands, scroll, search, click links, close/reopen, cold restart
- **Edge cases**: Large output (10k+ lines), Unicode/CJK text, rapid resize, multiple terminals
- **Performance**: Monitor renderer memory — restty should use less than xterm.js (no addon overhead)

## Potential Risks and Gotchas

1. **Search is viewport-only** until restty publishes WASM search ABI (landed in git Mar 16, pending npm release). Acceptable for initial ship; transparent upgrade later.

2. **WebGPU context loss** in Electron — restty falls back to WebGL2, but test with multiple terminals and window minimize/restore cycles.

3. **Main's link-provider improvements** (CJK paths, multi-line detection) need careful merge into ResttyLinkDetector — these were added after the backup.

4. **Auto-retry connection logic** in `useTerminalLifecycle.ts` must be preserved during the hook rewrite.

5. **`setupClickToMoveCursor`** accesses xterm private APIs (`_core._renderService.dimensions`). The backup reimplemented this via restty's cell size callbacks — verify it still works.

6. **restty v0.1.x API stability** — the maintainer warns APIs may change. Pin to `0.1.34` exactly if concerned.

## Rollback Plan

- All work on a feature branch
- Current xterm.js implementation stays on main until merge
- If restty issues arise post-merge, revert the PR (single commit)
- `@xterm/*` packages can be re-added in <5 minutes
