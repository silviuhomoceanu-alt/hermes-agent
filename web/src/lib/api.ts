// The dashboard can be served either at the root of its host (e.g.
// https://kanban.tilos.com/) or under a URL prefix when reverse-proxied
// (e.g. https://mission-control.tilos.com/hermes/). The Python backend
// injects ``window.__HERMES_BASE_PATH__`` into index.html based on the
// incoming ``X-Forwarded-Prefix`` header so the SPA can address its own
// ``/api/...`` and ``/dashboard-plugins/...`` URLs correctly without a
// rebuild. Empty string means "served at root".
function readBasePath(): string {
  if (typeof window === "undefined") return "";
  const raw = window.__HERMES_BASE_PATH__ ?? "";
  if (!raw) return "";
  // Normalise: ensure leading slash, strip trailing slash.
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

export const HERMES_BASE_PATH = readBasePath();
const BASE = HERMES_BASE_PATH;

import type { DashboardTheme } from "@/themes/types";

// Ephemeral session token for protected endpoints.
// Injected into index.html by the server — never fetched via API.
declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
    __HERMES_BASE_PATH__?: string;
    /** Server-injected flag: ``true`` when the dashboard's OAuth gate is
     * engaged (public bind, no ``--insecure``). Toggles the SPA's
     * WS-upgrade path from legacy ``?token=`` to single-use ``?ticket=``
     * fetched via :func:`getWsTicket`. */
    __HERMES_AUTH_REQUIRED__?: boolean;
  }
}
let _sessionToken: string | null = null;
const SESSION_HEADER = "X-Hermes-Session-Token";

function setSessionHeader(headers: Headers, token: string): void {
  if (!headers.has(SESSION_HEADER)) {
    headers.set(SESSION_HEADER, token);
  }
}

export async function fetchJSON<T>(
  url: string,
  init?: RequestInit,
  options?: FetchJSONOptions,
): Promise<T> {
  // Inject the session token into all /api/ requests.
  const headers = new Headers(init?.headers);
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) {
    setSessionHeader(headers, token);
  }
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers,
    // ``credentials: 'include'`` so the cookie-auth path (gated mode) works
    // for any fetch routed through here. Loopback mode is unaffected — the
    // server doesn't read cookies and the legacy session-token header is
    // already attached above.
    credentials: init?.credentials ?? "include",
  });
  if (res.status === 401) {
    // Phase 6: the gated middleware emits a structured envelope so the
    // SPA can full-page-navigate to /login on session expiry. Parse it,
    // and only redirect on the known error codes — domain-level 401s
    // (e.g. "you don't have permission to read this monitor") bubble
    // up as regular errors so callers can handle them.
    let body: { error?: string; login_url?: string } = {};
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON 401 — let it fall through */
    }
    if (
      (body.error === "unauthenticated" || body.error === "session_expired") &&
      body.login_url
    ) {
      // Preserve where the user was so /auth/callback can land them back
      // after re-auth. The gate's login_url already carries a ``next=``
      // built from the request path, but the SPA may be deep inside a
      // SPA route the gate never saw — e.g. a hash route or a client-side
      // /sessions/<id> deep link. Save the current location as a
      // fallback the post-login handler can read.
      try {
        sessionStorage.setItem(
          "hermes.lastLocation",
          window.location.pathname + window.location.search,
        );
      } catch {
        /* SSR / privacy mode — ignore */
      }
      window.location.assign(body.login_url);
      // Never resolve — the page is about to unload.
      return new Promise<T>(() => {});
    }
    // Loopback mode: ``_SESSION_TOKEN`` rotates on every server restart
    // (``hermes update``, ``hermes gateway restart``, etc.). A tab kept
    // open across the restart holds the OLD token in
    // ``window.__HERMES_SESSION_TOKEN__`` from the previous HTML render,
    // so every fetch returns 401. The HTML is served ``Cache-Control:
    // no-store`` so a reload picks up the freshly-injected token. Trigger
    // that reload once on the first stale-token 401 — gated mode is
    // handled above, so reaching here in gated mode means a real
    // middleware failure that should not reload-loop.
    if (!window.__HERMES_AUTH_REQUIRED__ && !options?.allowUnauthorized) {
      let alreadyReloaded = false;
      try {
        alreadyReloaded =
          sessionStorage.getItem("hermes.tokenReloadAttempted") === "1";
      } catch {
        /* SSR / privacy mode — fall through to throw */
      }
      if (!alreadyReloaded) {
        try {
          sessionStorage.setItem("hermes.tokenReloadAttempted", "1");
        } catch {
          /* SSR / privacy mode — best effort */
        }
        window.location.reload();
        return new Promise<T>(() => {});
      }
    }
  }
  if (res.ok) {
    // Clear the stale-token reload guard: a successful 2xx proves the
    // current ``window.__HERMES_SESSION_TOKEN__`` is valid, so the next
    // 401 — if any — should be allowed to trigger its own reload cycle.
    try {
      sessionStorage.removeItem("hermes.tokenReloadAttempted");
    } catch {
      /* SSR / privacy mode — ignore */
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

/** Encode a plugin registry key for URL paths (preserves `/` segment separators). */
function pluginPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

async function getSessionToken(): Promise<string> {
  if (_sessionToken) return _sessionToken;
  const injected = window.__HERMES_SESSION_TOKEN__;
  if (injected) {
    _sessionToken = injected;
    return _sessionToken;
  }
  throw new Error("Session token not available — page must be served by the Hermes dashboard server");
}

/**
 * Fetch a single-use ticket for a WebSocket upgrade in gated mode.
 *
 * The dashboard's gated-mode WS auth (``hermes_cli.web_server._ws_auth_ok``)
 * rejects the legacy ``?token=<_SESSION_TOKEN>`` path and only accepts
 * ``?ticket=<minted>`` consumed against the in-memory ticket store. Browsers
 * can't set ``Authorization`` on a WS upgrade, so this round-trip via the
 * authenticated REST endpoint is the bridge from cookie auth to WS auth.
 *
 * Tickets are single-use and TTL=30s — every WS connect attempt must
 * fetch a fresh ticket.
 */
export async function getWsTicket(): Promise<{ ticket: string; ttl_seconds: number }> {
  const res = await fetch(`${BASE}/api/auth/ws-ticket`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`/api/auth/ws-ticket: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Resolve the auth query-param pair (``[name, value]``) for a WebSocket
 * connect. In gated mode mints a fresh single-use ticket; in loopback
 * mode returns the injected session token.
 */
export async function buildWsAuthParam(): Promise<[string, string]> {
  if (window.__HERMES_AUTH_REQUIRED__) {
    const { ticket } = await getWsTicket();
    return ["ticket", ticket];
  }
  const token = window.__HERMES_SESSION_TOKEN__ ?? "";
  return ["token", token];
}

export const api = {
  getStatus: () => fetchJSON<StatusResponse>("/api/status"),
  /**
   * Identity probe for the dashboard auth gate (Phase 7).
   *
   * Returns the verified Session as JSON when gated mode is active and a
   * valid cookie is attached. Loopback mode is unaffected — the endpoint
   * still exists but is never useful there (no Session, no cookie). The
   * AuthWidget component swallows 401s from this call: if the gate isn't
   * engaged, /api/auth/me returns 401 and the widget renders nothing.
   *
   * ``allowUnauthorized`` is load-bearing: in loopback mode this endpoint
   * 401s by design, and fetchJSON's default loopback behaviour treats a
   * 401 as a rotated session token and full-page-reloads to pick up a
   * fresh one. Because every *other* dashboard request succeeds (and so
   * clears the one-shot reload guard), that turns this expected 401 into
   * an infinite reload loop. Opting out keeps the 401 a plain throw the
   * widget can catch.
   */
  getAuthMe: () =>
    fetchJSON<AuthMeResponse>("/api/auth/me", undefined, {
      allowUnauthorized: true,
    }),
  logout: () =>
    fetch(`${BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).then((r) => {
      // /auth/logout returns 302 → /login. Follow that with a full-page
      // navigation rather than letting fetch() opaquely consume the
      // redirect — the SPA needs to leave the protected area.
      window.location.assign("/login");
      return r;
    }),
  getSessions: (limit = 20, offset = 0) =>
    fetchJSON<PaginatedSessions>(`/api/sessions?limit=${limit}&offset=${offset}`),
  getSessionMessages: (id: string) =>
    fetchJSON<SessionMessagesResponse>(`/api/sessions/${encodeURIComponent(id)}/messages`),
  getSessionLatestDescendant: (id: string) =>
    fetchJSON<SessionLatestDescendantResponse>(
      `/api/sessions/${encodeURIComponent(id)}/latest-descendant`,
    ),
  deleteSession: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  getLogs: (params: { file?: string; lines?: number; level?: string; component?: string }) => {
    const qs = new URLSearchParams();
    if (params.file) qs.set("file", params.file);
    if (params.lines) qs.set("lines", String(params.lines));
    if (params.level && params.level !== "ALL") qs.set("level", params.level);
    if (params.component && params.component !== "all") qs.set("component", params.component);
    return fetchJSON<LogsResponse>(`/api/logs?${qs.toString()}`);
  },
  getReports: () => fetchJSON<ReportsResponse>("/api/reports"),
  getMemoryProfiles: () => fetchJSON<MemoryProfilesResponse>("/api/memory/profiles"),
  getMemoryOverview: () => fetchJSON<MemoryOverviewResponse>("/api/memory/overview"),
  getMemoryGraph: (params: { profiles?: string; includeMessages?: boolean; includeRawSources?: boolean; includeDerivedEdges?: boolean; view?: MemoryGraphView } = {}) => {
    const qs = new URLSearchParams();
    if (params.profiles) qs.set("profiles", params.profiles);
    if (params.includeMessages !== undefined) qs.set("includeMessages", String(params.includeMessages));
    if (params.includeRawSources !== undefined) qs.set("includeRawSources", String(params.includeRawSources));
    if (params.includeDerivedEdges !== undefined) qs.set("includeDerivedEdges", String(params.includeDerivedEdges));
    if (params.view) qs.set("view", params.view);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return fetchJSON<MemoryGraphResponse>(`/api/memory/graph${suffix}`);
  },
  searchMemory: (q: string, params: { profiles?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams({ q });
    if (params.profiles) qs.set("profiles", params.profiles);
    if (params.limit) qs.set("limit", String(params.limit));
    return fetchJSON<MemorySearchResponse>(`/api/memory/search?${qs.toString()}`);
  },
  getHermesMemory: (profile = "default") =>
    fetchJSON<HermesMemoryResponse>(`/api/memory/hermes?profile=${encodeURIComponent(profile)}`),
  addHermesMemory: (body: AddHermesMemoryRequest) =>
    fetchJSON<HermesMemoryWriteResponse>("/api/memory/hermes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateHermesMemory: (profile: string, target: HermesMemoryTarget, entryId: string, body: UpdateHermesMemoryRequest) =>
    fetchJSON<HermesMemoryWriteResponse>(
      `/api/memory/hermes/${encodeURIComponent(profile)}/${encodeURIComponent(target)}/${encodeURIComponent(entryId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  deleteHermesMemory: (profile: string, target: HermesMemoryTarget, entryId: string, body: DeleteHermesMemoryRequest = {}) =>
    fetchJSON<HermesMemoryWriteResponse>(
      `/api/memory/hermes/${encodeURIComponent(profile)}/${encodeURIComponent(target)}/${encodeURIComponent(entryId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  getMemoryAudit: (limit = 50) =>
    fetchJSON<MemoryAuditResponse>(`/api/memory/audit?limit=${encodeURIComponent(String(limit))}`),
  linkMemoryNodes: (body: MemoryLinkRequest) =>
    fetchJSON<MemoryLinkResponse>("/api/memory/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  unlinkMemoryNodes: (body: MemoryLinkRequest) =>
    fetchJSON<MemoryUnlinkResponse>("/api/memory/unlink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  promoteMemory: (body: MemoryCurationRequest) =>
    fetchJSON<MemoryCurationResponse>("/api/memory/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  demoteMemory: (body: MemoryCurationRequest) =>
    fetchJSON<MemoryCurationResponse>("/api/memory/demote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  getWikiTree: (profile = "default") =>
    fetchJSON<WikiTreeResponse>(`/api/memory/wiki/tree?profile=${encodeURIComponent(profile)}`),
  getWikiPage: (profile: string, path: string) => {
    const qs = new URLSearchParams({ profile, path });
    return fetchJSON<WikiPageResponse>(`/api/memory/wiki/page?${qs.toString()}`);
  },
  getWikiBacklinks: (profile: string, path: string) => {
    const qs = new URLSearchParams({ profile, path });
    return fetchJSON<WikiBacklinksResponse>(`/api/memory/wiki/backlinks?${qs.toString()}`);
  },
  getWikiLint: (profile = "default") =>
    fetchJSON<WikiLintResponse>(`/api/memory/wiki/lint?profile=${encodeURIComponent(profile)}`),
  saveWikiPage: (body: WikiPageWriteRequest) =>
    fetchJSON<WikiPageResponse>("/api/memory/wiki/page", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  createWikiPage: (body: WikiPageWriteRequest) =>
    fetchJSON<WikiPageResponse>("/api/memory/wiki/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  renameWikiPage: (body: WikiRenameRequest) =>
    fetchJSON<WikiPageResponse>("/api/memory/wiki/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  getHonchoStatus: (profile = "default") =>
    fetchJSON<HonchoStatusResponse>(`/api/memory/honcho/status?profile=${encodeURIComponent(profile)}`),
  getHonchoPeers: (profile = "default") =>
    fetchJSON<HonchoPeersResponse>(`/api/memory/honcho/peers?profile=${encodeURIComponent(profile)}`),
  getHonchoConclusions: (profile = "default") =>
    fetchJSON<HonchoConclusionsResponse>(`/api/memory/honcho/conclusions?profile=${encodeURIComponent(profile)}`),
  getHonchoSessions: (profile = "default") =>
    fetchJSON<HonchoSessionsResponse>(`/api/memory/honcho/sessions?profile=${encodeURIComponent(profile)}`),
  searchHoncho: (profile: string, q: string, limit = 20) => {
    const qs = new URLSearchParams({ profile, q, limit: String(limit) });
    return fetchJSON<HonchoSearchResponse>(`/api/memory/honcho/search?${qs.toString()}`);
  },
  getHonchoAdminMessages: (params: { search?: string; session?: string; peer?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.session) qs.set("session", params.session);
    if (params.peer) qs.set("peer", params.peer);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return fetchJSON<HonchoAdminMessagesResponse>(`/api/memory/honcho/admin/messages${suffix}`);
  },
  getHonchoAdminQueue: (params: { processed?: string; taskType?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.processed) qs.set("processed", params.processed);
    if (params.taskType) qs.set("taskType", params.taskType);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return fetchJSON<HonchoAdminQueueResponse>(`/api/memory/honcho/admin/queue${suffix}`);
  },
  getHonchoAdminSessions: () => fetchJSON<HonchoAdminSessionsResponse>("/api/memory/honcho/admin/sessions"),
  previewDeleteHonchoMessages: (messageIds: number[]) =>
    fetchJSON<HonchoAdminDeleteResponse>("/api/memory/honcho/admin/messages/preview-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds, confirm: false }),
    }),
  deleteHonchoMessages: (body: HonchoAdminDeleteRequest) =>
    fetchJSON<HonchoAdminDeleteResponse>("/api/memory/honcho/admin/messages/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteHonchoProcessedQueue: (body: HonchoAdminQueueDeleteRequest) =>
    fetchJSON<HonchoAdminDeleteResponse>("/api/memory/honcho/admin/queue/delete-processed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateHonchoPeerCard: (body: HonchoPeerCardRequest) =>
    fetchJSON<HonchoWriteResponse>("/api/memory/honcho/peer-card", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  createHonchoConclusion: (body: HonchoConclusionRequest) =>
    fetchJSON<HonchoWriteResponse>("/api/memory/honcho/conclusions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteHonchoConclusion: (profile: string, conclusionId: string, confirm = true) => {
    const qs = new URLSearchParams({ profile, confirm: String(confirm) });
    return fetchJSON<HonchoWriteResponse>(`/api/memory/honcho/conclusions/${encodeURIComponent(conclusionId)}?${qs.toString()}`, {
      method: "DELETE",
    });
  },
  getReportDownloadUrl: (path: string) => {
    const qs = new URLSearchParams({ path });
    const token = window.__HERMES_SESSION_TOKEN__;
    if (token) qs.set("token", token);
    return `${BASE}/api/reports/download?${qs.toString()}`;
  },
  uploadChatFile: async (file: File): Promise<ChatFileUploadResponse> => {
    const form = new FormData();
    form.append("file", file);
    return fetchJSON<ChatFileUploadResponse>("/api/chat/upload-file", {
      method: "POST",
      body: form,
    });
  },
  getAnalytics: (days: number) =>
    fetchJSON<AnalyticsResponse>(`/api/analytics/usage?days=${days}`),
  getModelsAnalytics: (days: number) =>
    fetchJSON<ModelsAnalyticsResponse>(`/api/analytics/models?days=${days}`),
  getConfig: () => fetchJSON<Record<string, unknown>>("/api/config"),
  getDefaults: () => fetchJSON<Record<string, unknown>>("/api/config/defaults"),
  getSchema: () => fetchJSON<{ fields: Record<string, unknown>; category_order: string[] }>("/api/config/schema"),
  getModelInfo: () => fetchJSON<ModelInfoResponse>("/api/model/info"),
  getModelOptions: () => fetchJSON<ModelOptionsResponse>("/api/model/options"),
  getAuxiliaryModels: () => fetchJSON<AuxiliaryModelsResponse>("/api/model/auxiliary"),
  setModelAssignment: (body: ModelAssignmentRequest) =>
    fetchJSON<ModelAssignmentResponse>("/api/model/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  saveConfig: (config: Record<string, unknown>) =>
    fetchJSON<{ ok: boolean }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),
  getConfigRaw: () => fetchJSON<{ yaml: string }>("/api/config/raw"),
  saveConfigRaw: (yaml_text: string) =>
    fetchJSON<{ ok: boolean }>("/api/config/raw", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text }),
    }),
  getEnvVars: () => fetchJSON<Record<string, EnvVarInfo>>("/api/env"),
  setEnvVar: (key: string, value: string) =>
    fetchJSON<{ ok: boolean }>("/api/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }),
  deleteEnvVar: (key: string) =>
    fetchJSON<{ ok: boolean }>("/api/env", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  revealEnvVar: async (key: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ key: string; value: string }>("/api/env/reveal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify({ key }),
    });
  },

  // Cron jobs
  getCronJobs: (profile = "all") =>
    fetchJSON<CronJob[]>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`),
  createCronJob: (job: { prompt: string; schedule: string; name?: string; deliver?: string }, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    }),
  pauseCronJob: (id: string, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/pause?profile=${encodeURIComponent(profile)}`, { method: "POST" }),
  resumeCronJob: (id: string, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/resume?profile=${encodeURIComponent(profile)}`, { method: "POST" }),
  triggerCronJob: (id: string, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger?profile=${encodeURIComponent(profile)}`, { method: "POST" }),
  deleteCronJob: (id: string, profile = "default") =>
    fetchJSON<{ ok: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" }),

  // Profiles (minimal)
  getProfiles: () =>
    fetchJSON<{ profiles: ProfileInfo[] }>("/api/profiles"),
  createProfile: (body: { name: string; clone_from_default: boolean }) =>
    fetchJSON<{ ok: boolean; name: string; path: string }>("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  renameProfile: (name: string, newName: string) =>
    fetchJSON<{ ok: boolean; name: string; path: string }>(
      `/api/profiles/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: newName }),
      },
    ),
  deleteProfile: (name: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  getProfileSetupCommand: (name: string) =>
    fetchJSON<{ command: string }>(
      `/api/profiles/${encodeURIComponent(name)}/setup-command`,
    ),
  getProfileSoul: (name: string) =>
    fetchJSON<{ content: string; exists: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}/soul`,
    ),
  updateProfileSoul: (name: string, content: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}/soul`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    ),

  // Skills & Toolsets
  getSkills: () => fetchJSON<SkillInfo[]>("/api/skills"),
  toggleSkill: (name: string, enabled: boolean) =>
    fetchJSON<{ ok: boolean }>("/api/skills/toggle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    }),
  getToolsets: () => fetchJSON<ToolsetInfo[]>("/api/tools/toolsets"),

  // Session search (FTS5)
  searchSessions: (q: string) =>
    fetchJSON<SessionSearchResponse>(`/api/sessions/search?q=${encodeURIComponent(q)}`),

  // OAuth provider management
  getOAuthProviders: () =>
    fetchJSON<OAuthProvidersResponse>("/api/providers/oauth"),
  disconnectOAuthProvider: async (providerId: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ ok: boolean; provider: string }>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}`,
      {
        method: "DELETE",
        headers: { [SESSION_HEADER]: token },
      },
    );
  },
  startOAuthLogin: async (providerId: string) => {
    const token = await getSessionToken();
    return fetchJSON<OAuthStartResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: token,
        },
        body: "{}",
      },
    );
  },
  submitOAuthCode: async (providerId: string, sessionId: string, code: string) => {
    const token = await getSessionToken();
    return fetchJSON<OAuthSubmitResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/submit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: token,
        },
        body: JSON.stringify({ session_id: sessionId, code }),
      },
    );
  },
  pollOAuthSession: (providerId: string, sessionId: string) =>
    fetchJSON<OAuthPollResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`,
    ),
  cancelOAuthSession: async (sessionId: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ ok: boolean }>(
      `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        headers: { [SESSION_HEADER]: token },
      },
    );
  },

  // Gateway / update actions
  restartGateway: () =>
    fetchJSON<ActionResponse>("/api/gateway/restart", { method: "POST" }),
  updateHermes: () =>
    fetchJSON<ActionResponse>("/api/hermes/update", { method: "POST" }),
  getActionStatus: (name: string, lines = 200) =>
    fetchJSON<ActionStatusResponse>(
      `/api/actions/${encodeURIComponent(name)}/status?lines=${lines}`,
    ),

  // Dashboard plugins
  getPlugins: () =>
    fetchJSON<PluginManifestResponse[]>("/api/dashboard/plugins"),
  rescanPlugins: () =>
    fetchJSON<{ ok: boolean; count: number }>("/api/dashboard/plugins/rescan"),

  getPluginsHub: () => fetchJSON<PluginsHubResponse>("/api/dashboard/plugins/hub"),

  installAgentPlugin: (body: AgentPluginInstallRequest) =>
    fetchJSON<AgentPluginInstallResponse>("/api/dashboard/agent-plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body }),
    }),

  enableAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}/enable`,
      { method: "POST" },
    ),

  disableAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}/disable`,
      { method: "POST" },
    ),

  updateAgentPlugin: (name: string) =>
    fetchJSON<AgentPluginUpdateResponse>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}/update`,
      { method: "POST" },
    ),

  removeAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string }>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}`,
      { method: "DELETE" },
    ),

  savePluginProviders: (body: PluginProvidersPutRequest) =>
    fetchJSON<{ ok: boolean }>("/api/dashboard/plugin-providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  setPluginVisibility: (name: string, hidden: boolean) =>
    fetchJSON<{ ok: boolean; name: string; hidden: boolean }>(
      `/api/dashboard/plugins/${pluginPath(name)}/visibility`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      },
    ),

  // Dashboard themes
  getThemes: () =>
    fetchJSON<DashboardThemesResponse>("/api/dashboard/themes"),
  setTheme: (name: string) =>
    fetchJSON<{ ok: boolean; theme: string }>("/api/dashboard/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
};

/** Identity payload returned by ``GET /api/auth/me`` (Phase 7).
 *
 * Returned by the dashboard's gated middleware when a valid session cookie
 * is attached. ``email`` and ``display_name`` are empty strings under the
 * Nous Portal contract V1 (the access token has no email/name claims —
 * see Contract Anchor C4 in the plan). The AuthWidget surfaces a
 * truncated ``user_id`` instead.
 */
export interface AuthMeResponse {
  user_id: string;
  email: string;
  display_name: string;
  org_id: string;
  provider: string;
  expires_at: number;
}

export interface ActionResponse {
  name: string;
  ok: boolean;
  pid: number;
}

/** Per-call overrides for {@link fetchJSON}. */
interface FetchJSONOptions {
  /** When true, a 401 response is surfaced as a normal thrown error rather
   *  than triggering the loopback stale-token page reload. Use for probes
   *  whose 401 is an expected signal (e.g. /api/auth/me in non-gated mode)
   *  rather than evidence of a rotated session token. */
  allowUnauthorized?: boolean;
}

export interface ActionStatusResponse {
  exit_code: number | null;
  lines: string[];
  name: string;
  pid: number | null;
  running: boolean;
}

export interface PlatformStatus {
  error_code?: string;
  error_message?: string;
  state: string;
  updated_at: string;
}

export interface StatusResponse {
  active_sessions: number;
  /** Phase 7: ``true`` when the dashboard's OAuth gate is engaged
   * (public bind, no ``--insecure``). Read alongside ``auth_providers``
   * to render a "gated / loopback" badge. */
  auth_required?: boolean;
  /** Phase 7: registered ``DashboardAuthProvider`` names (e.g. ``["nous"]``).
   * Empty in loopback mode; empty + ``auth_required=true`` is a
   * fail-closed state (the dashboard will refuse to bind). */
  auth_providers?: string[];
  config_path: string;
  config_version: number;
  env_path: string;
  gateway_exit_reason: string | null;
  gateway_health_url: string | null;
  gateway_pid: number | null;
  gateway_platforms: Record<string, PlatformStatus>;
  gateway_running: boolean;
  gateway_state: string | null;
  gateway_updated_at: string | null;
  hermes_home: string;
  latest_config_version: number;
  release_date: string;
  version: string;
}

export interface SessionInfo {
  id: string;
  source: string | null;
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  last_active: number;
  is_active: boolean;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  preview: string | null;
  parent_session_id?: string | null;
}

export interface SessionLatestDescendantResponse {
  requested_session_id: string;
  session_id: string;
  path: string[];
  changed: boolean;
}

export interface PaginatedSessions {
  sessions: SessionInfo[];
  total: number;
  limit: number;
  offset: number;
}

export interface EnvVarInfo {
  is_set: boolean;
  redacted_value: string | null;
  description: string;
  url: string | null;
  category: string;
  is_password: boolean;
  tools: string[];
  advanced: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number;
}

export interface SessionMessagesResponse {
  session_id: string;
  messages: SessionMessage[];
}

export interface LogsResponse {
  file: string;
  lines: string[];
}

export interface ReportFile {
  name: string;
  path: string;
  dir: string;
  ext: string;
  size_bytes: number;
  modified: number;
}

export interface ReportsResponse {
  reports: ReportFile[];
}

export interface ChatFileUploadResponse {
  path: string;
  filename: string;
  file_type: "image" | "document";
}

export interface AnalyticsDailyEntry {
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
}

export interface AnalyticsModelEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  sessions: number;
  api_calls: number;
}

export interface AnalyticsSkillEntry {
  skill: string;
  view_count: number;
  manage_count: number;
  total_count: number;
  percentage: number;
  last_used_at: number | null;
}

export interface AnalyticsSkillsSummary {
  total_skill_loads: number;
  total_skill_edits: number;
  total_skill_actions: number;
  distinct_skills_used: number;
}

export interface AnalyticsResponse {
  daily: AnalyticsDailyEntry[];
  by_model: AnalyticsModelEntry[];
  totals: {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_reasoning: number;
    total_estimated_cost: number;
    total_actual_cost: number;
    total_sessions: number;
    total_api_calls: number;
  };
  skills: {
    summary: AnalyticsSkillsSummary;
    top_skills: AnalyticsSkillEntry[];
  };
}

export interface ProfileInfo {
  name: string;
  path: string;
  is_default: boolean;
  model: string | null;
  provider: string | null;
  has_env: boolean;
  skill_count: number;
}

export interface ModelsAnalyticsModelEntry {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
  tool_calls: number;
  last_used_at: number;
  avg_tokens_per_session: number;
  capabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

export interface ModelsAnalyticsResponse {
  models: ModelsAnalyticsModelEntry[];
  totals: {
    distinct_models: number;
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_reasoning: number;
    total_estimated_cost: number;
    total_actual_cost: number;
    total_sessions: number;
    total_api_calls: number;
  };
  period_days: number;
}

export interface CronJob {
  id: string;
  profile?: string | null;
  profile_name?: string | null;
  hermes_home?: string | null;
  is_default_profile?: boolean;
  name?: string | null;
  prompt?: string | null;
  script?: string | null;
  schedule?: { kind?: string; expr?: string; display?: string };
  schedule_display?: string | null;
  enabled: boolean;
  state?: string | null;
  deliver?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_error?: string | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface ToolsetInfo {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
}

export interface SessionSearchResult {
  session_id: string;
  snippet: string;
  role: string | null;
  source: string | null;
  model: string | null;
  session_started: number | null;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
}

// ── Model info types ──────────────────────────────────────────────────

export interface ModelInfoResponse {
  model: string;
  provider: string;
  auto_context_length: number;
  config_context_length: number;
  effective_context_length: number;
  capabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

// ── Model options / assignment types ──────────────────────────────────

export interface ModelOptionProvider {
  name: string;
  slug: string;
  models?: string[];
  total_models?: number;
  is_current?: boolean;
  is_user_defined?: boolean;
  source?: string;
  warning?: string;
}

export interface ModelOptionsResponse {
  model?: string;
  provider?: string;
  providers?: ModelOptionProvider[];
}

export interface AuxiliaryTaskAssignment {
  task: string;
  provider: string;
  model: string;
  base_url: string;
}

export interface AuxiliaryModelsResponse {
  tasks: AuxiliaryTaskAssignment[];
  main: { provider: string; model: string };
}

export interface ModelAssignmentRequest {
  scope: "main" | "auxiliary";
  provider: string;
  model: string;
  /** For auxiliary: task slot name, "" for all, "__reset__" to reset all. */
  task?: string;
}

export interface ModelAssignmentResponse {
  ok: boolean;
  scope?: string;
  provider?: string;
  model?: string;
  tasks?: string[];
  reset?: boolean;
}

// ── Memory Workbench types ──────────────────────────────────────────────

export interface MemoryProfileInfo {
  name: string;
  path: string;
  is_default: boolean;
  wiki_path?: string | null;
  has_honcho: boolean;
}

export type MemoryGraphView = "stored_content" | "storage";

export interface MemoryNode {
  id: string;
  source: "hermes" | "honcho" | "wiki" | "derived" | "manual";
  kind: string;
  label: string;
  summary?: string;
  editable: boolean;
  metadata: Record<string, unknown>;
}

export interface MemoryEdge {
  id: string;
  source: "hermes" | "honcho" | "wiki" | "derived" | "manual";
  from: string;
  to: string;
  kind: string;
}

export interface MemoryGraphSummary {
  profiles: number;
  nodes: number;
  edges: number;
  storage_nodes?: number;
  storage_edges?: number;
  hermes_entries: number;
  wiki_pages: number;
  honcho_nodes: number;
}

export interface MemoryGraphResponse {
  view: MemoryGraphView;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  summary: MemoryGraphSummary;
  warnings: string[];
}

export interface MemoryProfilesResponse {
  profiles: MemoryProfileInfo[];
}

export interface MemoryOverviewResponse {
  profiles: MemoryProfileInfo[];
  summary: MemoryGraphSummary;
  warnings: string[];
}

export interface MemorySearchResult {
  id: string;
  source: MemoryNode["source"];
  profile?: string | null;
  kind: string;
  title: string;
  snippet: string;
  editable: boolean;
  score?: number;
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
}


export interface MemoryManualLink {
  id: string;
  profile: string;
  from: string;
  to: string;
  kind: "manual_link" | "curated_link";
  label?: string;
}

export interface MemoryLinkRequest {
  profile?: string;
  fromNodeId?: string;
  toNodeId?: string;
  kind?: "manual_link" | "curated_link";
  label?: string;
  linkId?: string;
}


export interface MemoryCurationRequest {
  profile?: string;
  sourceNodeId?: string;
  sourceText?: string;
  sourcePath?: string;
  target: "hermes" | "wiki";
  targetMemory?: HermesMemoryTarget;
  targetPath?: string;
  title?: string;
  content?: string;
  pointerContent?: string;
  confirm?: boolean;
}

export interface MemoryCurationResponse {
  profile: string;
  direction: "promote" | "demote";
  target: "hermes" | "wiki";
  applied: boolean;
  requiresConfirmation: boolean;
  source: Record<string, unknown>;
  draft: Record<string, unknown>;
  result?: Record<string, unknown>;
  pointer?: Record<string, unknown>;
}

export interface MemoryLinkResponse {
  profile: string;
  link: MemoryManualLink;
  links: MemoryManualLink[];
}

export interface MemoryUnlinkResponse {
  profile: string;
  removed: number;
  linkId: string;
  links: MemoryManualLink[];
}

export type HermesMemoryTarget = "user" | "memory";

export interface HermesMemoryEntry {
  id: string;
  index: number;
  content: string;
  editable: true;
}

export interface HermesMemoryStore {
  target: HermesMemoryTarget;
  path: string;
  charLimit: number;
  usedChars: number;
  entries: HermesMemoryEntry[];
}

export interface HermesMemoryResponse {
  profile: string;
  stores: HermesMemoryStore[];
  warnings: string[];
}

export interface AddHermesMemoryRequest {
  profile: string;
  target: HermesMemoryTarget;
  content: string;
}

export interface UpdateHermesMemoryRequest {
  content: string;
  expectedOldContent: string;
}

export interface DeleteHermesMemoryRequest {
  expectedOldContent?: string;
}

export interface HermesMemoryWriteResponse {
  profile: string;
  success: boolean;
  target?: HermesMemoryTarget;
  entries?: string[];
  usage?: string;
  entry_count?: number;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export interface WikiTreeNode {
  id: string;
  name: string;
  path: string;
  type: "directory" | "page";
  children?: WikiTreeNode[];
  title?: string;
  read_only?: boolean;
  has_frontmatter?: boolean;
}

export interface WikiPageSummary {
  path: string;
  absolute_path: string;
  title: string;
  read_only: boolean;
  has_frontmatter: boolean;
  size_bytes: number;
}

export interface WikiTreeResponse {
  profile: string;
  wiki_root: string;
  tree: WikiTreeNode;
  pages: WikiPageSummary[];
}

export interface WikiLinkRef {
  label: string;
  path: string | null;
  exists: boolean;
}

export interface WikiBacklinkRef {
  path: string;
  title: string;
  link: string;
  read_only: boolean;
}

export interface WikiPageResponse {
  profile: string;
  wiki_root: string;
  path: string;
  absolute_path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  read_only: boolean;
  outgoing_links: WikiLinkRef[];
  backlinks: WikiBacklinkRef[];
}

export interface WikiBacklinksResponse {
  profile: string;
  wiki_root: string;
  path: string;
  backlinks: WikiBacklinkRef[];
}

export interface WikiLintIssue {
  kind: string;
  path: string;
  message: string;
  severity: "error" | "warning";
  link?: string;
  source?: string;
}



export interface MemoryAuditOperation {
  id: string;
  timestamp: string;
  profile: string;
  source: "hermes" | "honcho" | "wiki" | string;
  action: string;
  success: boolean;
  details: Record<string, unknown>;
  error?: string;
}

export interface MemoryAuditResponse {
  operations: MemoryAuditOperation[];
}

export interface WikiPageWriteRequest {
  profile: string;
  path: string;
  frontmatter?: Record<string, unknown> | null;
  body?: string | null;
  raw?: string | null;
}

export interface WikiRenameRequest {
  profile: string;
  oldPath: string;
  newPath: string;
}

export interface HonchoStatusResponse {
  profile: string;
  configured: boolean;
  base_url: string;
  workspace: string;
  peers: string[];
  warnings: string[];
}

export interface HonchoPeersResponse {
  profile: string;
  peers: Record<string, unknown>[];
  warnings: string[];
}

export interface HonchoConclusionsResponse {
  profile: string;
  conclusions: Record<string, unknown>[];
  warnings: string[];
}

export interface HonchoSessionsResponse {
  profile: string;
  sessions: Record<string, unknown>[];
  warnings: string[];
}

export interface HonchoSearchResponse {
  profile: string;
  results: Record<string, unknown>[];
  warnings: string[];
}

export interface HonchoAdminMessage {
  id: number;
  public_id?: string | null;
  created_at?: string | null;
  peer_name?: string | null;
  workspace_name?: string | null;
  session_name?: string | null;
  token_count?: number | null;
  content_preview?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  internal_metadata?: Record<string, unknown> | null;
}

export interface HonchoAdminQueueItem {
  id: number;
  created_at?: string | null;
  processed?: boolean | null;
  task_type?: string | null;
  work_unit_key?: string | null;
  session_id?: number | string | null;
  workspace_name?: string | null;
  message_id?: number | null;
  error?: string | null;
  payload_preview?: string | null;
}

export interface HonchoAdminSessionItem {
  id: number;
  name: string;
  workspace_name?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
  message_count?: number | null;
  queue_count?: number | null;
  document_count?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface HonchoAdminMessagesResponse {
  items: HonchoAdminMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface HonchoAdminQueueResponse {
  items: HonchoAdminQueueItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface HonchoAdminSessionsResponse {
  items: HonchoAdminSessionItem[];
  total: number;
}

export interface HonchoAdminDeleteRequest {
  messageIds: number[];
  reason?: string;
  confirm?: boolean;
  createBackup?: boolean;
}

export interface HonchoAdminQueueDeleteRequest {
  reason?: string;
  confirm?: boolean;
  createBackup?: boolean;
}

export interface HonchoAdminDeleteResponse {
  applied?: boolean;
  requiresConfirmation?: boolean;
  message_ids?: number[];
  counts?: Record<string, number>;
  deleted?: Record<string, number>;
  backup_path?: string | null;
  audit_path?: string | null;
}

export interface HonchoPeerCardRequest {
  profile: string;
  peerId: string;
  card: string[];
}

export interface HonchoConclusionRequest {
  profile: string;
  peerId: string;
  conclusion: string;
}

export interface HonchoWriteResponse {
  profile: string;
  result: Record<string, unknown>;
}

export interface WikiLintResponse {
  profile: string;
  wiki_root: string;
  issues: WikiLintIssue[];
  summary: {
    pages: number;
    issues: number;
    errors: number;
    warnings: number;
  };
}

// ── OAuth provider types ────────────────────────────────────────────────

export interface OAuthProviderStatus {
  logged_in: boolean;
  source?: string | null;
  source_label?: string | null;
  token_preview?: string | null;
  expires_at?: string | null;
  has_refresh_token?: boolean;
  last_refresh?: string | null;
  error?: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
  /** "pkce" (browser redirect + paste code), "device_code" (show code + URL),
   *  or "external" (delegated to a separate CLI like Claude Code or Qwen). */
  flow: "pkce" | "device_code" | "external";
  cli_command: string;
  docs_url: string;
  status: OAuthProviderStatus;
}

export interface OAuthProvidersResponse {
  providers: OAuthProvider[];
}

/** Discriminated union — the shape of /start depends on the flow. */
export type OAuthStartResponse =
  | {
      session_id: string;
      flow: "pkce";
      auth_url: string;
      expires_in: number;
    }
  | {
      session_id: string;
      flow: "device_code";
      user_code: string;
      verification_url: string;
      expires_in: number;
      poll_interval: number;
    };

export interface OAuthSubmitResponse {
  ok: boolean;
  status: "approved" | "error";
  message?: string;
}

export interface OAuthPollResponse {
  session_id: string;
  status: "pending" | "approved" | "denied" | "expired" | "error";
  error_message?: string | null;
  expires_at?: number | null;
}

// ── Dashboard theme types ──────────────────────────────────────────────

export interface DashboardThemeSummary {
  description: string;
  label: string;
  name: string;
  /** Full theme definition for user themes; undefined for built-ins
   *  (which the frontend already has locally). */
  definition?: DashboardTheme;
}

export interface DashboardThemesResponse {
  active: string;
  themes: DashboardThemeSummary[];
}

// ── Dashboard plugin types ─────────────────────────────────────────────

export interface PluginManifestResponse {
  name: string;
  label: string;
  description: string;
  icon: string;
  version: string;
  tab: {
    path: string;
    position?: string;
    override?: string;
    hidden?: boolean;
  };
  slots?: string[];
  entry: string;
  css?: string | null;
  has_api: boolean;
  source: string;
}

export interface HubAgentPluginRow {
  name: string;
  version: string;
  description: string;
  source: string;
  runtime_status: "disabled" | "enabled" | "inactive";
  has_dashboard_manifest: boolean;
  dashboard_manifest: PluginManifestResponse | null;
  path: string;
  can_remove: boolean;
  can_update_git: boolean;
  auth_required: boolean;
  auth_command: string;
  user_hidden: boolean;
}

export interface PluginsHubProviders {
  memory_provider: string;
  memory_options: Array<{ name: string; description: string }>;
  context_engine: string;
  context_options: Array<{ name: string; description: string }>;
}

export interface PluginsHubResponse {
  plugins: HubAgentPluginRow[];
  orphan_dashboard_plugins: PluginManifestResponse[];
  providers: PluginsHubProviders;
}

export interface AgentPluginInstallRequest {
  identifier: string;
  force?: boolean;
  enable?: boolean;
}

export interface AgentPluginInstallResponse {
  ok: boolean;
  plugin_name?: string;
  warnings?: string[];
  missing_env?: string[];
  after_install_path?: string | null;
  enabled?: boolean;
  error?: string;
}

export interface AgentPluginUpdateResponse {
  ok: boolean;
  name?: string;
  output?: string;
  unchanged?: boolean;
  error?: string;
}

export interface PluginProvidersPutRequest {
  memory_provider?: string;
  context_engine?: string;
}
