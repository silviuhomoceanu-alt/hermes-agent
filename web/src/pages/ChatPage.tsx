/**
 * ChatPage — embeds `hermes --tui` inside the dashboard.
 *
 *   <div host> (dashboard chrome)                                         .
 *     └─ <div wrapper> (rounded, dark bg, padded — the "terminal window"  .
 *         look that gives the page a distinct visual identity)            .
 *         └─ @xterm/xterm Terminal (WebGL renderer, Unicode 11 widths)    .
 *              │ onData      keystrokes → WebSocket → PTY master          .
 *              │ onResize    terminal resize → `\x1b[RESIZE:cols;rows]`   .
 *              │ write(data) PTY output bytes → VT100 parser              .
 *              ▼                                                          .
 *     WebSocket /api/pty?token=<session>                                  .
 *          ▼                                                              .
 *     FastAPI pty_ws  (hermes_cli/web_server.py)                          .
 *          ▼                                                              .
 *     POSIX PTY → `node ui-tui/dist/entry.js` → tui_gateway + AIAgent     .
 */

import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@nous-research/ui/ui/components/button";
import { Typography } from "@nous-research/ui/ui/components/typography/index";
import { HERMES_BASE_PATH, buildWsAuthParam } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Copy, Paperclip, PanelRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { ChatSidebar } from "@/components/ChatSidebar";
import { AttachmentBar, type StagedAttachment } from "@/components/AttachmentBar";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { PluginSlot } from "@/plugins";

function buildWsUrl(
  authParam: [string, string],
  resume: string | null,
  channel: string,
): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // ``authParam`` is ``["token", <session>]`` in loopback mode and
  // ``["ticket", <minted>]`` in gated mode. The server-side helper
  // ``_ws_auth_ok`` picks whichever shape matches the current gate state.
  const qs = new URLSearchParams({ [authParam[0]]: authParam[1], channel });
  if (resume) qs.set("resume", resume);
  return `${proto}//${window.location.host}${HERMES_BASE_PATH}/api/pty?${qs.toString()}`;
}

// Channel id ties this chat tab's PTY child (publisher) to its sidebar
// (subscriber).  Generated once per mount so a tab refresh starts a fresh
// channel — the previous PTY child terminates with the old WS, and its
// channel auto-evicts when no subscribers remain.
function generateChannelId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `chat-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// Colors for the terminal body.  Matches the dashboard's dark teal canvas
// with cream foreground — we intentionally don't pick monokai or a loud
// theme, because the TUI's skin engine already paints the content; the
// terminal chrome just needs to sit quietly inside the dashboard.
const TERMINAL_THEME = {
  background: "#0d2626",
  foreground: "#f0e6d2",
  cursor: "#f0e6d2",
  cursorAccent: "#0d2626",
  selectionBackground: "#f0e6d244",
};

/**
 * CSS width for xterm font tiers.
 *
 * Prefer the terminal host's `clientWidth` — Chrome DevTools device mode often
 * keeps `window.innerWidth` at the full desktop value while the *drawn* layout
 * is phone-sized, which made us pick desktop font sizes (~14px) and look huge.
 */
function terminalTierWidthPx(host: HTMLElement | null): number {
  if (typeof window === "undefined") return 1280;
  const fromHost = host?.clientWidth ?? 0;
  if (fromHost > 2) return Math.round(fromHost);
  const doc = document.documentElement?.clientWidth ?? 0;
  const vv = window.visualViewport;
  const inner = window.innerWidth;
  const vvw = vv?.width ?? inner;
  const layout = Math.min(inner, vvw, doc > 0 ? doc : inner);
  return Math.max(1, Math.round(layout));
}

function terminalFontSizeForWidth(layoutWidthPx: number): number {
  if (layoutWidthPx < 300) return 7;
  if (layoutWidthPx < 360) return 8;
  if (layoutWidthPx < 420) return 9;
  if (layoutWidthPx < 520) return 10;
  if (layoutWidthPx < 720) return 11;
  if (layoutWidthPx < 1024) return 12;
  return 14;
}

function terminalLineHeightForWidth(layoutWidthPx: number): number {
  return layoutWidthPx < 1024 ? 1.02 : 1.15;
}

export default function ChatPage({ isActive = true }: { isActive?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Exposed to the main metrics-sync effect so it can refit the terminal
  // the moment `isActive` flips back to true (display:none → display:flex
  // collapses the host's box, so ResizeObserver never fires on return).
  const syncMetricsRef = useRef<(() => void) | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // Lazy-init: the missing-token check happens at construction so the effect
  // body doesn't have to setState (React 19's set-state-in-effect rule).
  // In gated (OAuth) mode the server intentionally omits the session token —
  // the SPA authenticates the WS via a single-use ticket (buildWsAuthParam),
  // so a missing token there is expected, not an error.
  const [banner, setBanner] = useState<string | null>(() =>
    typeof window !== "undefined" &&
    !window.__HERMES_SESSION_TOKEN__ &&
    !window.__HERMES_AUTH_REQUIRED__
      ? "Session token unavailable. Open this page through `hermes dashboard`, not directly."
      : null,
  );
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<StagedAttachment[]>([]);
  const stageFilesRef = useRef<(files: File[]) => void>(() => {});
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  // Raw state for the mobile side-sheet + a derived value that force-
  // closes whenever the chat tab isn't active.  The *derived* value is
  // what side-effects (body-scroll lock, keydown listener, portal render)
  // key on — that way switching to another tab triggers the effect's
  // cleanup, releasing the scroll-lock on /sessions etc.  Returning to
  // /chat re-runs the effect (derived flips back to true) and re-locks.
  // Keying on the raw state would leak the body.overflow="hidden" across
  // tabs because the dep wouldn't change on tab switch.
  const [mobilePanelOpenRaw, setMobilePanelOpenRaw] = useState(false);
  const mobilePanelOpen = isActive && mobilePanelOpenRaw;
  const { setEnd } = usePageHeader();
  const { t } = useI18n();
  const closeMobilePanel = useCallback(() => setMobilePanelOpenRaw(false), []);
  const modelToolsLabel = useMemo(
    () => `${t.app.modelToolsSheetTitle} ${t.app.modelToolsSheetSubtitle}`,
    [t.app.modelToolsSheetSubtitle, t.app.modelToolsSheetTitle],
  );
  const [portalRoot] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null,
  );
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1023px)").matches
      : false,
  );

  // The dashboard keeps ChatPage mounted persistently so the PTY survives tab
  // switches. That is great for ordinary /chat navigation, but it means query
  // param changes do NOT remount the component. Resume-in-chat from the
  // Sessions page relies on `/chat?resume=<id>` changing at runtime, so we must
  // treat the current resume target as part of the PTY identity and rebuild the
  // terminal session when it changes.
  const resumeParam = searchParams.get("resume");
  const channel = useMemo(() => generateChannelId(), [resumeParam]);

  useEffect(() => {
    if (!resumeParam) return;

    let cancelled = false;

    api
      .getSessionLatestDescendant(resumeParam)
      .then((res) => {
        if (cancelled || !res.session_id || res.session_id === resumeParam) {
          return;
        }

        const next = new URLSearchParams(searchParams);
        next.set("resume", res.session_id);
        setSearchParams(next, { replace: true });
      })
      .catch(() => {
        // Best-effort: old servers or missing sessions should not block chat.
      });

    return () => {
      cancelled = true;
    };
  }, [resumeParam, searchParams, setSearchParams]);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1023px)");
    const sync = () => setNarrow(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobilePanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobilePanel();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobilePanelOpen, closeMobilePanel]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobilePanelOpenRaw(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // When hidden (non-chat tab) we must not register the header button —
    // another page owns the header's end slot at that point.
    if (!isActive) {
      setEnd(null);
      return;
    }
    if (!narrow) {
      setEnd(null);
      return;
    }
    setEnd(
      <Button
        ghost
        onClick={() => setMobilePanelOpenRaw(true)}
        aria-expanded={mobilePanelOpen}
        aria-controls="chat-side-panel"
        className={cn(
          "shrink-0 rounded border border-current/20",
          "px-2 py-1 text-xs font-medium tracking-wide",
          "text-text-secondary hover:text-midground hover:bg-midground/5",
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <PanelRight className="h-3 w-3 shrink-0" />
          {modelToolsLabel}
        </span>
      </Button>,
    );
    return () => setEnd(null);
  }, [isActive, narrow, mobilePanelOpen, modelToolsLabel, setEnd]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const doomed = prev.find((att) => att.id === id);
      if (doomed?.previewUrl) URL.revokeObjectURL(doomed.previewUrl);
      return prev.filter((att) => att.id !== id);
    });
  }, []);

  const stageFiles = useCallback((files: File[]) => {
    for (const file of files) {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `att-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const staged: StagedAttachment = {
        id,
        filename: file.name || "attachment",
        previewUrl,
        type: isImage ? "image" : "document",
        status: "uploading",
      };
      setAttachments((prev) => [...prev, staged]);
      api
        .uploadChatFile(file)
        .then((res) => {
          setAttachments((prev) =>
            prev.map((att) =>
              att.id === id
                ? {
                    ...att,
                    type: res.file_type,
                    status: "ready",
                    serverPath: res.path,
                  }
                : att,
            ),
          );
        })
        .catch((err) => {
          console.warn("[hermes-chat] file upload failed:", err);
          setAttachments((prev) =>
            prev.map((att) =>
              att.id === id ? { ...att, status: "error" } : att,
            ),
          );
        });
    }
  }, []);

  useEffect(() => {
    stageFilesRef.current = stageFiles;
  }, [stageFiles]);

  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, [channel]);

  const handleFileInput = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files ?? []);
    if (files.length > 0) stageFiles(files);
    ev.target.value = "";
  }, [stageFiles]);

  const handleCopyLast = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Send the slash as a burst, wait long enough for Ink's tokenizer to
    // emit a keypress event for each character (not coalesce them into a
    // paste), then send Return as its own event.  The timing here is
    // empirical — 100ms is safely past Node's default stdin coalescing
    // window and well inside UI responsiveness.
    ws.send("/copy");
    setTimeout(() => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send("\r");
    }, 100);
    setCopyState("copied");
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopyState("idle"), 1500);
    termRef.current?.focus();
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const token = window.__HERMES_SESSION_TOKEN__;
    const gated = !!window.__HERMES_AUTH_REQUIRED__;
    // Banner already initialised above; just bail before wiring xterm/WS.
    // In gated mode the token is absent by design — buildWsAuthParam() mints
    // a WS ticket instead, so don't bail; let the effect reach that path.
    if (!token && !gated) {
      return;
    }

    const tierW0 = terminalTierWidthPx(host);
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'MesloLGS NF', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: terminalFontSizeForWidth(tierW0),
      lineHeight: terminalLineHeightForWidth(tierW0),
      letterSpacing: 0,
      fontWeight: "400",
      fontWeightBold: "700",
      macOptionIsMeta: true,
      // Hold Option (Alt on Linux/Windows) to force native text selection
      // even when the inner Hermes TUI has enabled xterm mouse-events
      // mode (CSI ?1000h family). Without this, click-and-drag in the
      // chat canvas selects nothing and Cmd+C falls back to copying the
      // entire visible buffer, which is rarely what the user wants.
      // See #25720.
      macOptionClickForcesSelection: true,
      // Right-click selects the word under the pointer. xterm.js default
      // is false; enabling it gives users a single-action selection
      // path on top of the modifier-based bypass above.
      rightClickSelectsWord: true,
      // Browser-embedded chat runs the TUI in inline mode. Keep transcript
      // history in xterm.js so the browser wheel can scroll it directly.
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    termRef.current = term;

    // --- Clipboard integration ---------------------------------------
    //
    // Three independent paths all route to the system clipboard:
    //
    //   1. **Selection → Ctrl+C (or Cmd+C on macOS).**  Ink's own handler
    //      in useInputHandlers.ts turns Ctrl+C into a copy when the
    //      terminal has a selection, then emits an OSC 52 escape.  Our
    //      OSC 52 handler below decodes that escape and writes to the
    //      browser clipboard — so the flow works just like it does in
    //      `hermes --tui`.
    //
    //   2. **Ctrl/Cmd+Shift+C.**  Belt-and-suspenders shortcut that
    //      operates directly on xterm's selection, useful if the TUI
    //      ever stops listening (e.g. overlays / pickers) or if the user
    //      has selected with the mouse outside of Ink's selection model.
    //
    //   3. **Ctrl/Cmd+Shift+V.**  Reads the system clipboard and feeds
    //      it to the terminal as keyboard input.  xterm's paste() wraps
    //      it with bracketed-paste if the host has that mode enabled.
    //
    // OSC 52 reads (terminal asking to read the clipboard) are not
    // supported — that would let any content the TUI renders exfiltrate
    // the user's clipboard.
    term.parser.registerOscHandler(52, (data) => {
      // Format: "<targets>;<base64 | '?'>"
      const semi = data.indexOf(";");
      if (semi < 0) return false;
      const payload = data.slice(semi + 1);
      if (payload === "?" || payload === "") return false; // read/clear — ignore
      try {
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const text = new TextDecoder("utf-8").decode(bytes);
        writeClipboardText(text, "OSC 52 write");
      } catch {
        console.warn("[dashboard clipboard] malformed OSC 52 payload");
      }
      return true;
    });

    const isMac =
      typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

    const writeClipboardText = (text: string, label: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch((err) => {
          console.warn(`[dashboard clipboard] ${label} failed:`, err.message);
        });
        return true;
      }

      // Clipboard API is unavailable on insecure LAN origins. Because this
      // runs inside the user's key gesture, the legacy copy command still
      // works in Chromium/Safari and keeps Cmd+C usable from http://<mac-ip>.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        return document.execCommand("copy");
      } catch (err) {
        console.warn(
          `[dashboard clipboard] ${label} fallback failed:`,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      } finally {
        textarea.remove();
        term.focus();
      }
    };

    const copyFromTerminalSelection = (ev: KeyboardEvent) => {
      const sel = term.getSelection();
      if (!sel) return false;

      // Direct clipboard writes inside the keydown handler preserve the user
      // gesture — async round-trips through OSC 52 can lose activation
      // and fail with "Document is not focused".
      writeClipboardText(sel, "direct copy");
      // Clear xterm.js's highlight after copy (matches gnome-terminal).
      term.clearSelection();
      ev.preventDefault();
      return true;
    };

    const canReadClipboardItems = () => !!navigator.clipboard?.read;

    const pasteFromBrowserClipboard = async () => {
      const clipboard = navigator.clipboard;
      // Screenshot images copied via Cmd+Ctrl+Shift+4 only appear as clipboard
      // items. If `clipboard.read()` is unavailable (common on insecure LAN
      // origins), do NOT fall back to readText() here: preventing Cmd+V would
      // suppress the native DOM paste event that still carries the image.
      if (!canReadClipboardItems()) {
        return false;
      }

      try {
        if (clipboard.read) {
          const items = await clipboard.read();
          const imageFiles: File[] = [];
          for (const item of items) {
            const imageType = item.types.find((type) => type.startsWith("image/"));
            if (!imageType) continue;
            const blob = await item.getType(imageType);
            const ext = imageType.split("/")[1] || "png";
            imageFiles.push(new File([blob], `clipboard-image.${ext}`, { type: imageType }));
          }
          if (imageFiles.length > 0) {
            stageFilesRef.current(imageFiles);
            return true;
          }
        }
        if (clipboard.readText) {
          const text = await clipboard.readText();
          if (text) {
            term.paste(text);
            return true;
          }
        }
      } catch (err) {
        console.warn(
          "[dashboard clipboard] paste failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      return true;
    };

    const isCopyKey = (ev: KeyboardEvent) => {
      const key = ev.key.toLowerCase();
      return key === "c" && (isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey);
    };

    const isMacNativePasteKey = (ev: KeyboardEvent) =>
      isMac && ev.key.toLowerCase() === "v" && ev.metaKey && !ev.ctrlKey && !ev.altKey;

    const isMacTerminalPasteKey = (ev: KeyboardEvent) =>
      isMac &&
      ev.key.toLowerCase() === "v" &&
      ev.ctrlKey &&
      !ev.metaKey &&
      !ev.shiftKey &&
      !ev.altKey;

    const isPasteKey = (ev: KeyboardEvent) => {
      const key = ev.key.toLowerCase();
      if (key !== "v") return false;
      return isMac
        ? isMacNativePasteKey(ev) || isMacTerminalPasteKey(ev)
        : ev.ctrlKey && ev.shiftKey;
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Copy: Cmd+C on macOS, Ctrl+Shift+C on other platforms. Bare Ctrl+C
      // is reserved for SIGINT to the TUI child — matches xterm / gnome-terminal /
      // konsole / Windows Terminal. Ctrl+Shift+C only copies if a selection exists;
      // without a selection it passes through to the TUI so agents can still
      // react to the keypress.
      // Paste: Cmd+V and Ctrl+V on macOS, Ctrl+Shift+V on others.
      // macOS users often press Ctrl+V from terminal muscle memory; if we
      // let that fall through, the TUI tries to read the clipboard from a
      // Python subprocess, which cannot reliably see browser-held image
      // clipboard permissions.
      if (isCopyKey(ev)) {
        if (copyFromTerminalSelection(ev)) {
          return false;
        }
        // No selection → fall through so the TUI receives Ctrl+Shift+C
        // (or the bare ev if the user used a different modifier).
      }

      if (ev.key === "Enter") {
        const ready = attachmentsRef.current.filter(
          (att) => att.status === "ready" && att.serverPath,
        );
        if (ready.length > 0) {
          term.paste(ready.map((att) => att.serverPath).join(" "));
          setAttachments((prev) => {
            for (const att of prev) {
              if (ready.some((r) => r.id === att.id) && att.previewUrl) {
                URL.revokeObjectURL(att.previewUrl);
              }
            }
            return prev.filter((att) => !ready.some((r) => r.id === att.id));
          });
          setTimeout(() => term.input("\r"), 300);
          ev.preventDefault();
          return false;
        }
      }

      if (isPasteKey(ev)) {
        if (!canReadClipboardItems()) {
          // Cmd+V must fall through so the browser fires a native `paste`
          // event with event.clipboardData.items. Ctrl+V is not a native
          // macOS paste shortcut; letting it through sends ^V to the TUI and
          // triggers the server-side "No image found in clipboard" path.
          if (isMacTerminalPasteKey(ev)) {
            ev.preventDefault();
            return false;
          }
          return true;
        }
        void pasteFromBrowserClipboard();
        ev.preventDefault();
        return false;
      }

      return true;
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // Dashboard chat should scroll the browser-side transcript, not send
    // mouse-wheel protocol bytes through the PTY.
    term.attachCustomWheelEventHandler((ev) => {
      const delta = ev.deltaY;
      if (!delta) {
        return false;
      }

      const step = Math.max(1, Math.round(Math.abs(delta) / 50));
      term.scrollLines(delta > 0 ? step : -step);

      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });

    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.loadAddon(new WebLinksAddon());

    term.open(host);

    const handleHostPaste = (ev: ClipboardEvent) => {
      const items = Array.from(ev.clipboardData?.items ?? []);
      const imageFiles: File[] = [];
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        const ext = item.type.split("/")[1] || "png";
        imageFiles.push(
          new File([file], file.name || `clipboard-image.${ext}`, { type: item.type }),
        );
      }
      if (imageFiles.length > 0) {
        ev.preventDefault();
        ev.stopPropagation();
        stageFilesRef.current(imageFiles);
        return;
      }

      // When async Clipboard is unavailable (common on http://<LAN-IP>),
      // allow the native paste event to be the text source instead. Do not
      // block plain text paste unless we actually inject it into xterm.
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        ev.preventDefault();
        ev.stopPropagation();
        term.paste(text);
      }
    };

    const handleHostKeyDown = (ev: KeyboardEvent) => {
      // Some browser/xterm combinations on macOS consume Cmd+C/V before
      // xterm's custom key handler sees them. Capture at the host DOM layer
      // too, so dashboard clipboard behavior matches normal macOS muscle memory.
      if (isCopyKey(ev)) {
        copyFromTerminalSelection(ev);
        return;
      }

      if (isPasteKey(ev)) {
        if (canReadClipboardItems()) {
          ev.preventDefault();
          ev.stopPropagation();
          void pasteFromBrowserClipboard();
          return;
        }
        if (isMacTerminalPasteKey(ev)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      }
    };

    host.addEventListener("paste", handleHostPaste, { capture: true });
    document.addEventListener("paste", handleHostPaste, { capture: true });
    host.addEventListener("keydown", handleHostKeyDown, { capture: true });

    // WebGL draws from a texture atlas sized with device pixels. On phones and
    // in DevTools device mode that often produces *visually* much larger cells
    // than `fontSize` suggests — users see "huge" text even at 7–9px settings.
    // The canvas/DOM renderer tracks `fontSize` faithfully; use it for narrow
    // hosts.  Wide layouts still get WebGL for crisp box-drawing.
    const useWebgl = terminalTierWidthPx(host) >= 768;
    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (err) {
        console.warn(
          "[hermes-chat] WebGL renderer unavailable; falling back to default",
          err,
        );
      }
    }

    // Initial fit + resize observer.  fit.fit() reads the container's
    // current bounding box and resizes the terminal grid to match.
    //
    // The subtle bit: the dashboard has CSS transitions on the container
    // (backdrop fade-in, rounded corners settling as fonts load).  If we
    // call fit() at mount time, the bounding box we measure is often 1-2
    // cell widths off from the final size.  ResizeObserver *does* fire
    // when the container settles, but if the pixel delta happens to be
    // smaller than one cell's width, fit() computes the same integer
    // (cols, rows) as before and doesn't emit onResize — so the PTY
    // never learns the final size.  Users see truncated long lines until
    // they resize the browser window.
    //
    // We force one extra fit + explicit RESIZE send after two animation
    // frames.  rAF→rAF guarantees one layout commit between the two
    // callbacks, giving CSS transitions and font metrics time to finalize
    // before we take the authoritative measurement.
    let hostSyncRaf = 0;
    const scheduleHostSync = () => {
      if (hostSyncRaf) return;
      hostSyncRaf = requestAnimationFrame(() => {
        hostSyncRaf = 0;
        syncTerminalMetrics();
      });
    };

    let metricsDebounce: ReturnType<typeof setTimeout> | null = null;
    const syncTerminalMetrics = () => {
      // display:none hosts have clientWidth/Height = 0, which fit() turns
      // into a 1x1 terminal.  Skip entirely while hidden; the visibility
      // effect below runs another fit as soon as the tab is shown again.
      if (!host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
        return;
      }
      const w = terminalTierWidthPx(host);
      const nextSize = terminalFontSizeForWidth(w);
      const nextLh = terminalLineHeightForWidth(w);
      const fontChanged =
        term.options.fontSize !== nextSize ||
        term.options.lineHeight !== nextLh;
      if (fontChanged) {
        term.options.fontSize = nextSize;
        term.options.lineHeight = nextLh;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      if (fontChanged && term.rows > 0) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* ignore */
        }
      }
      if (
        fontChanged &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        wsRef.current.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
      }
    };
    syncMetricsRef.current = syncTerminalMetrics;

    const scheduleSyncTerminalMetrics = () => {
      if (metricsDebounce) clearTimeout(metricsDebounce);
      metricsDebounce = setTimeout(() => {
        metricsDebounce = null;
        syncTerminalMetrics();
      }, 60);
    };

    const ro = new ResizeObserver(() => scheduleHostSync());
    ro.observe(host);

    window.addEventListener("resize", scheduleSyncTerminalMetrics);
    window.visualViewport?.addEventListener("resize", scheduleSyncTerminalMetrics);
    scheduleHostSync();
    requestAnimationFrame(() => scheduleHostSync());

    // Double-rAF authoritative fit.  On the second frame the layout has
    // committed at least once since mount; fit.fit() then reads the
    // stable container size.  We always send a RESIZE escape afterwards
    // (even if fit's cols/rows didn't change, so the PTY has the same
    // dims registered as our JS state — prevents a drift where Ink
    // thinks the terminal is one col bigger than what's on screen).
    let settleRaf1 = 0;
    let settleRaf2 = 0;
    settleRaf1 = requestAnimationFrame(() => {
      settleRaf1 = 0;
      settleRaf2 = requestAnimationFrame(() => {
        settleRaf2 = 0;
        syncTerminalMetrics();
      });
    });

    // WebSocket. In gated mode (``window.__HERMES_AUTH_REQUIRED__``) this
    // awaits a single-use ticket via /api/auth/ws-ticket before opening;
    // in loopback mode it resolves synchronously against the injected
    // session token. The IIFE keeps the outer effect synchronous so its
    // ``return cleanup`` stays at the top level; handlers + disposables
    // are hoisted to ``let`` bindings the cleanup closes over.
    let unmounting = false;
    let onDataDisposable: { dispose(): void } | null = null;
    let onResizeDisposable: { dispose(): void } | null = null;
    void (async () => {
      const authParam = await buildWsAuthParam();
      if (unmounting) return;
      const url = buildWsUrl(authParam, resumeParam, channel);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

    ws.onopen = () => {
      setBanner(null);
      // Send the initial RESIZE immediately so Ink has *a* size to lay
      // out against on its first paint.  The double-rAF block above will
      // follow up with the authoritative measurement — at worst Ink
      // reflows once after the PTY boots, which is imperceptible.
      ws.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = (ev) => {
      wsRef.current = null;
      if (unmounting) {
        return;
      }
      if (ev.code === 4401) {
        setBanner("Auth failed. Reload the page to refresh the session token.");
        return;
      }
      if (ev.code === 4403) {
        setBanner("Chat is only reachable from localhost.");
        return;
      }
      if (ev.code === 1011) {
        // Server already wrote an ANSI error frame.
        return;
      }
      term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
    };

    // Keystrokes → PTY.
    //
    // IMPORTANT:
    // The embedded web chat has occasionally surfaced stray letters/digits
    // in the input line after a turn completes. The most likely culprit is
    // browser-side terminal control traffic being forwarded back into the
    // PTY as if it were user text. SGR mouse tracking is the highest-risk
    // path here: xterm.js emits raw CSI reports (`\x1b[<...`) that look like
    // ordinary bytes to the backend.
    //
    // For the browser embed we prefer input stability over terminal-style
    // mouse reporting, so we drop SGR mouse reports entirely instead of
    // forwarding them into Hermes. Keyboard input, paste, and resize still
    // behave normally.
      // eslint-disable-next-line no-control-regex -- intentional ESC byte in xterm SGR mouse report parser
      const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
      onDataDisposable = term.onData((data) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (SGR_MOUSE_RE.test(data)) {
          return;
        }

        ws.send(data);
      });

      onResizeDisposable = term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\x1b[RESIZE:${cols};${rows}]`);
        }
      });
    })();

    term.focus();

    return () => {
      unmounting = true;
      syncMetricsRef.current = null;
      onDataDisposable?.dispose();
      onResizeDisposable?.dispose();
      if (metricsDebounce) clearTimeout(metricsDebounce);
      window.removeEventListener("resize", scheduleSyncTerminalMetrics);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleSyncTerminalMetrics,
      );
      host.removeEventListener("paste", handleHostPaste, { capture: true });
      document.removeEventListener("paste", handleHostPaste, { capture: true });
      host.removeEventListener("keydown", handleHostKeyDown, { capture: true });
      ro.disconnect();
      if (hostSyncRaf) cancelAnimationFrame(hostSyncRaf);
      if (settleRaf1) cancelAnimationFrame(settleRaf1);
      if (settleRaf2) cancelAnimationFrame(settleRaf2);
      // Phase 5.3: ``ws`` is local to the IIFE that opens it (the gated-mode
      // ticket fetch makes the open async). The cleanup runs at the outer
      // effect's top level so it can't reach into that scope — close via
      // the ref instead. ``?.`` covers the race where unmount fires before
      // the ticket fetch resolves and ``wsRef.current`` was never assigned.
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
        copyResetRef.current = null;
      }
    };
  }, [channel, resumeParam]);

  // When the user returns to the chat tab (isActive: false → true), the
  // terminal host just transitioned from display:none to display:flex.
  // ResizeObserver won't fire on that kind of style-driven box change —
  // xterm thinks its grid is still whatever it was when the tab was
  // hidden (or 0×0, if it was hidden before first fit).  Force a refit
  // after two animation frames so layout has committed.
  //
  // Focus handling: we only steal focus back into the terminal when
  // nothing else inside ChatPage was holding it (typically the first
  // activation after mount, where document.activeElement is <body>; or
  // a return after the user had been typing in the terminal, where
  // focus was already on the xterm textarea before the tab got hidden
  // and has since fallen back to <body>).  If the user had clicked
  // into the sidebar (model picker, tool-call entry) before switching
  // tabs, we must not yank focus away from wherever they left it when
  // they come back — that's a surprise and an a11y foot-gun.
  useEffect(() => {
    if (!isActive) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf1 = 0;
      raf2 = requestAnimationFrame(() => {
        raf2 = 0;
        syncMetricsRef.current?.();
        const host = hostRef.current;
        const active = typeof document !== "undefined"
          ? document.activeElement
          : null;
        const focusIsElsewhereInChatPage =
          active !== null &&
          active !== document.body &&
          host !== null &&
          !host.contains(active);
        if (!focusIsElsewhereInChatPage) {
          termRef.current?.focus();
        }
      });
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [isActive]);

  // Layout:
  //   outer flex column — sits inside the dashboard's content area
  //   row split — terminal pane (flex-1) + sidebar (fixed width, lg+)
  //   terminal wrapper — rounded, dark, padded — the "terminal window"
  //   floating copy button — bottom-right corner, transparent with a
  //     subtle border; stays out of the way until hovered.  Sends
  //     `/copy\n` to Ink, which emits OSC 52 → our clipboard handler.
  //   sidebar — ChatSidebar opens its own JSON-RPC sidecar; renders
  //     model badge, tool-call list, model picker. Best-effort: if the
  //     sidecar fails to connect the terminal pane keeps working.
  //
  // Mobile model/tools sheet is portaled to `document.body` so it stacks
  // above the app sidebar (`z-50`) and mobile chrome (`z-40`).  The main
  // dashboard column uses `relative z-2`, which traps `position:fixed`
  // descendants below those layers (see Toast.tsx).
  const mobileModelToolsPortal =
    isActive &&
    narrow &&
    portalRoot &&
    createPortal(
      <>
        {mobilePanelOpen && (
          <Button
            ghost
            aria-label={t.app.closeModelTools}
            onClick={closeMobilePanel}
            className={cn(
              "fixed inset-0 z-[55] p-0 block",
              "bg-black/60 backdrop-blur-sm",
            )}
          />
        )}

        <div
          id="chat-side-panel"
          role="complementary"
          aria-label={modelToolsLabel}
          className={cn(
            "font-mondwest fixed top-0 right-0 z-[60] flex h-dvh max-h-dvh w-64 min-w-0 flex-col antialiased",
            "border-l border-current/20 text-midground",
            "bg-background-base/95 backdrop-blur-sm",
            "transition-transform duration-200 ease-out",
            "[background:var(--component-sidebar-background)]",
            "[clip-path:var(--component-sidebar-clip-path)]",
            "[border-image:var(--component-sidebar-border-image)]",
            mobilePanelOpen
              ? "translate-x-0"
              : "pointer-events-none translate-x-full",
          )}
        >
          <div
            className={cn(
              "flex h-14 shrink-0 items-center justify-between gap-2 border-b border-current/20 px-5",
            )}
          >
            <Typography
              mondwest
              className="text-display font-bold text-[1.125rem] leading-[0.95] tracking-[0.0525rem] text-midground"
              style={{ mixBlendMode: "plus-lighter" }}
            >
              {t.app.modelToolsSheetTitle}
              <br />
              {t.app.modelToolsSheetSubtitle}
            </Typography>

            <Button
              ghost
              size="icon"
              onClick={closeMobilePanel}
              aria-label={t.app.closeModelTools}
              className="text-text-secondary hover:text-midground"
            >
              <X />
            </Button>
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overflow-x-hidden",
              "border-t border-current/10",
            )}
          >
            <ChatSidebar channel={channel} />
          </div>
        </div>
      </>,
      portalRoot,
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <PluginSlot name="chat:top" />
      {mobileModelToolsPortal}

      {banner && (
        <div className="border border-warning/50 bg-warning/10 text-warning px-3 py-2 text-xs tracking-wide">
          {banner}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-3">
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg",
            "p-2 sm:p-3",
          )}
          style={{
            backgroundColor: TERMINAL_THEME.background,
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
          }}
        >
          <div
            ref={hostRef}
            className="hermes-chat-xterm-host min-h-0 min-w-0 flex-1"
          />

          <div className="flex shrink-0 items-center gap-2 pt-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInput}
            />
            <Button
              ghost
              onClick={() => fileInputRef.current?.click()}
              title="Attach file to next message"
              aria-label="Attach file"
              className={cn(
                "shrink-0 normal-case tracking-normal font-normal",
                "rounded border border-current/30",
                "bg-black/20 backdrop-blur-sm",
                "opacity-70 hover:opacity-100 hover:border-current/60",
                "px-2 py-1 text-xs sm:px-2.5 sm:py-1.5",
              )}
              style={{ color: TERMINAL_THEME.foreground }}
            >
              <Paperclip className="h-3 w-3 shrink-0" />
            </Button>

            <AttachmentBar
              attachments={attachments}
              onRemove={removeAttachment}
              className="min-w-0 flex-1 px-0 pt-0"
            />

            <Button
              ghost
              onClick={handleCopyLast}
              title="Copy last assistant response as raw markdown"
              aria-label="Copy last assistant response"
              className={cn(
                "shrink-0 normal-case tracking-normal font-normal",
                "rounded border border-current/30",
                "bg-black/20 backdrop-blur-sm",
                "opacity-70 hover:opacity-100 hover:border-current/60",
                "transition-opacity duration-150",
                "px-2 py-1 text-xs sm:px-2.5 sm:py-1.5",
              )}
              style={{ color: TERMINAL_THEME.foreground }}
            >
              <span className="inline-flex items-center gap-1.5">
                <Copy className="h-3 w-3 shrink-0" />
                <span className="hidden min-[400px]:inline tracking-wide">
                  {copyState === "copied" ? "copied" : "copy last response"}
                </span>
              </span>
            </Button>
          </div>
        </div>

        {!narrow && (
          <div
            id="chat-side-panel"
            role="complementary"
            aria-label={modelToolsLabel}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden lg:h-full lg:w-80"
          >
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatSidebar channel={channel} />
            </div>
          </div>
        )}
      </div>
      <PluginSlot name="chat:bottom" />
    </div>
  );
}

declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
    __HERMES_AUTH_REQUIRED__?: boolean;
  }
}
