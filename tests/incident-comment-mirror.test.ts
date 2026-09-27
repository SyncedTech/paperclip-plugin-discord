import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Task 20 (synced-oncall Plan 3): the incident's Discord thread should show
// the whole story — opened, agent summary, approval, result, done — without
// leaking Paperclip's own system notices or a stray hub comment whose author
// happens to look like a board user (the hub's board key resolves to the
// consultant's own Paperclip userId, so author alone can't tell them apart).
//
// These tests cover:
//   - an agent-authored comment is mirrored as a reply to the stored incident message
//   - a board/user comment is mirrored ONLY when it starts with a known hub relay prefix
//   - a Paperclip system notice (no relay prefix, not agent-authored) is skipped
//   - no stored incident message for the issue -> skipped silently, never a random channel
//   - a long comment is clipped to Discord's 2000-char limit, keeping the first line and
//     ending with the Paperclip issue link
//   - agent.run.started/finished are suppressed when notifyOnRunEvents is false, and still
//     posted when true (the default, so upstream behaviour is unchanged)
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

const TEST_COMPANY_ID = "company-1";
const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import { _resetRuntimeForTests, clipMirrorContent } from "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedDefinitions.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  const definition = capturedDefinitions[capturedDefinitions.length - 1];
  return async (ctx: any) => {
    _resetRuntimeForTests();
    await definition.setup(ctx);
    await definition.onConfigChanged?.(ctx.__testConfig ?? {}, { companyId: TEST_COMPANY_ID });
  };
}

function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  let discordMessageCount = 0;
  const stateStore = new Map<string, unknown>();

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: true,
    notifyOnAgentError: false,
    notifyOnRunEvents: true,
    mirrorAgentComments: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: "https://paperclip.example.com",
    intelligenceRetentionDays: 30,
    escalationChannelId: "",
    enableEscalations: true,
    escalationTimeoutMinutes: 30,
    maxAgentsPerThread: 5,
    enableMediaPipeline: false,
    mediaChannelIds: [],
    enableCustomCommands: false,
    enableProactiveSuggestions: false,
    proactiveScanIntervalMinutes: 15,
    enableCommands: false,
    enableInbound: false,
    topicRouting: false,
    digestMode: "off",
    dailyDigestTime: "09:00",
    bidailySecondTime: "17:00",
    tridailyTimes: "07:00,13:00,19:00",
    ...configOverrides,
  };

  const mockDiscordFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++discordMessageCount}` }),
    text: async () => "",
  }));

  const ctx = {
    config: {
      get: vi.fn().mockImplementation(async (companyId?: string) => {
        if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
        return defaultConfig;
      }),
    },
    __testConfig: defaultConfig,
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: vi.fn().mockImplementation(async (key: { scopeKind: string; scopeId?: string; stateKey: string }) => {
        const id = `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`;
        return stateStore.get(id) ?? null;
      }),
      set: vi.fn().mockImplementation(async (key: { scopeKind: string; scopeId?: string; stateKey: string }, value: unknown) => {
        const id = `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`;
        stateStore.set(id, value);
      }),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
      on: vi.fn().mockImplementation((name: string, fn: (event: any) => Promise<void>) => {
        const handlers = eventHandlers.get(name) || [];
        handlers.push(fn);
        eventHandlers.set(name, handlers);
        return () => {};
      }),
    },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listComments: vi.fn().mockResolvedValue([]),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, eventHandlers, getDiscordMessageCount: () => discordMessageCount, mockDiscordFetch };
}

function makeEvent(
  eventType: string,
  eventId: string,
  payload: Record<string, unknown> = {},
  opts: { entityId?: string; actorType?: "user" | "agent" | "system" | "plugin"; actorId?: string } = {},
): any {
  return {
    eventId,
    eventType,
    occurredAt: new Date().toISOString(),
    companyId: TEST_COMPANY_ID,
    entityId: opts.entityId ?? "issue-1",
    entityType: "issue",
    actorType: opts.actorType,
    actorId: opts.actorId,
    payload,
  };
}

/**
 * A real `issue.comment.created` event, matching what the Paperclip server
 * actually sends (routes/issues.ts + services/activity-log.ts): built from the
 * activity log, so `actorType`/`actorId` carry the author and the payload is a
 * summary — `commentId` + a 120-char `bodySnippet` — never the full `body`.
 * The plugin fetches the full comment separately via `commentId`.
 */
function makeCommentEvent(
  eventId: string,
  opts: {
    commentId: string;
    actorType?: "user" | "agent" | "system" | "plugin";
    agentId?: string | null;
    bodySnippet?: string;
    entityId?: string;
    extraPayload?: Record<string, unknown>;
  },
): any {
  return makeEvent(
    "issue.comment.created",
    eventId,
    {
      commentId: opts.commentId,
      bodySnippet: opts.bodySnippet ?? "",
      identifier: "INC-1",
      issueTitle: "Something broke",
      agentId: opts.agentId ?? null,
      runId: null,
      responsibleUserId: null,
      ...opts.extraPayload,
    },
    { entityId: opts.entityId, actorType: opts.actorType },
  );
}

async function emitEvent(
  eventHandlers: Map<string, Array<(event: any) => Promise<void>>>,
  eventType: string,
  event: any,
) {
  const handlers = eventHandlers.get(eventType) || [];
  for (const handler of handlers) {
    await handler(event);
  }
}

/** Seed the stored incident message the way issue.created's onPosted callback does. */
async function seedIncidentMessage(ctx: any, issueId: string, channelId: string, messageId: string) {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `issue_message_${issueId}` },
    { channelId, messageId },
  );
}

function findMessageCreateCalls(mockDiscordFetch: ReturnType<typeof vi.fn>) {
  return mockDiscordFetch.mock.calls.filter(
    (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/") && call[0].endsWith("/messages") && typeof call[1]?.body === "string",
  );
}

describe("issue.comment.created: mirroring agent and hub-relay comments into the incident thread", () => {
  it("mirrors an agent-authored comment as a reply to the stored incident message, with mentions suppressed", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([
      { id: "c1", body: "Root cause: the healthcheck flapped because of a DNS timeout." },
    ]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-1", {
      commentId: "c1",
      actorType: "agent",
      agentId: "agent-oncall",
      bodySnippet: "Root cause: the healthcheck flapped becaus",
    });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(ctx.issues.listComments).toHaveBeenCalledWith("issue-1", TEST_COMPANY_ID);
    const calls = findMessageCreateCalls(mockDiscordFetch);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("/channels/ch-incidents/messages");
    const body = JSON.parse(calls[0][1].body);
    expect(body.message_reference).toMatchObject({ message_id: "msg-original" });
    expect(body.content).toContain("Root cause: the healthcheck flapped");
    expect(body.content).toContain("https://paperclip.example.com/issues/issue-1");
    expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false });
  });

  it("treats a missing actorType with a truthy payload.agentId as agent-authored", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([{ id: "c2", body: "Fallback-detected agent comment." }]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-1b", { commentId: "c2", agentId: "agent-oncall" });
    // No actorType set at all — only the payload.agentId fallback should mark this as agent-authored.
    delete event.actorType;

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(1);
  });

  it("mirrors a board/user comment only when its full body starts with a known hub relay prefix", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([
      { id: "c3", body: "Approved by the consultant and run on host-1: systemctl restart nginx" },
    ]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-2", {
      commentId: "c3",
      actorType: "user",
      bodySnippet: "Approved by the consultant and run on host-1:",
    });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    const calls = findMessageCreateCalls(mockDiscordFetch);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.content).toContain("Approved by the consultant");
  });

  it("reads the comment body via commentId, never the old assumed payload.body field", async () => {
    // Regression guard: an earlier draft assumed the event payload carried `body`
    // and `authorAgentId` directly. It does not — the event is an activity-log
    // summary. A payload that happens to still have a `body` key (e.g. a stale
    // caller) must be ignored in favour of the fetched comment.
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([
      { id: "c4", body: "Real body from listComments, this is what should be posted." },
    ]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-old-shape", {
      commentId: "c4",
      actorType: "agent",
      agentId: "agent-oncall",
      extraPayload: { body: "OLD SHAPE BODY - must not be used", authorAgentId: "agent-oncall" },
    });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    const calls = findMessageCreateCalls(mockDiscordFetch);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.content).toContain("Real body from listComments");
    expect(body.content).not.toContain("OLD SHAPE BODY");
  });

  it("skips a Paperclip system notice (no relay prefix, not agent-authored)", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([
      { id: "c5", body: "This issue needs a disposition before it can proceed." },
    ]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-3", { commentId: "c5", actorType: "system" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("not agent-authored or a known relay prefix"),
      expect.anything(),
    );
  });

  it("skips silently when no incident message is stored for the issue", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    await getSetup()(ctx);
    // No seedIncidentMessage call: this issue predates the plugin restart.

    const event = makeCommentEvent("evt-comment-4", { commentId: "c6", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("No stored incident message"),
      expect.anything(),
    );
  });

  it("debug-logs and skips when the fetched comment body is empty", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([{ id: "c7", body: "   " }]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-empty", { commentId: "c7", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Comment body is empty"),
      expect.anything(),
    );
  });

  it("debug-logs and skips when the comment id isn't found in listComments", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockResolvedValue([{ id: "some-other-comment", body: "unrelated" }]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-missing", { commentId: "c8", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Comment not found"),
      expect.anything(),
    );
  });

  it("debug-logs and skips when fetching comments throws", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    ctx.issues.listComments.mockRejectedValue(new Error("board api unavailable"));
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-fetch-fail", { commentId: "c9", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch comment body"),
      expect.anything(),
    );
  });

  it("does nothing when mirrorAgentComments is off", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({ mirrorAgentComments: false });
    ctx.issues.listComments.mockResolvedValue([{ id: "c10", body: "Root cause found." }]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-5", { commentId: "c10", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
  });

  it("clips a long comment to 2000 chars, keeping the first line and ending with the issue link", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext();
    const firstLine = "Root cause: the disk filled up on host-3.";
    const longBody = `${firstLine}\n${"filler line describing background context.\n".repeat(100)}`;
    ctx.issues.listComments.mockResolvedValue([{ id: "c11", body: longBody }]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-6", { commentId: "c11", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    const calls = findMessageCreateCalls(mockDiscordFetch);
    const body = JSON.parse(calls[0][1].body);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.startsWith(firstLine)).toBe(true);
    expect(body.content.endsWith("https://paperclip.example.com/issues/issue-1")).toBe(true);
  });

  it("falls back to the default base URL when paperclipBaseUrl is empty, so the link is always there", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({ paperclipBaseUrl: "" });
    ctx.issues.listComments.mockResolvedValue([{ id: "c12", body: "Root cause found." }]);
    await getSetup()(ctx);
    await seedIncidentMessage(ctx, "issue-1", "ch-incidents", "msg-original");

    const event = makeCommentEvent("evt-comment-7", { commentId: "c12", actorType: "agent", agentId: "agent-oncall" });

    await emitEvent(eventHandlers, "issue.comment.created", event);

    const calls = findMessageCreateCalls(mockDiscordFetch);
    const body = JSON.parse(calls[0][1].body);
    expect(body.content).toContain("http://localhost:3100/issues/issue-1");
  });
});

describe("clipMirrorContent", () => {
  it("keeps short content untouched apart from the appended link", () => {
    const out = clipMirrorContent("Short finding.", "https://paperclip.example.com/issues/x");
    expect(out).toBe("Short finding.\n\nhttps://paperclip.example.com/issues/x");
  });

  it("never exceeds the Discord content limit", () => {
    const out = clipMirrorContent("x".repeat(5000), "https://paperclip.example.com/issues/x");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.endsWith("https://paperclip.example.com/issues/x")).toBe(true);
  });
});

describe("agent.run.started/finished: the notifyOnRunEvents switch", () => {
  it("suppresses run posts when notifyOnRunEvents is false", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({ notifyOnRunEvents: false });
    await getSetup()(ctx);

    await emitEvent(eventHandlers, "agent.run.started", makeEvent("agent.run.started", "evt-run-1", { agentName: "Scribe" }));
    await emitEvent(eventHandlers, "agent.run.finished", makeEvent("agent.run.finished", "evt-run-2", { agentName: "Scribe" }));

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(0);
  });

  it("still posts run events when notifyOnRunEvents is true (the default, upstream behaviour unchanged)", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({ notifyOnRunEvents: true });
    await getSetup()(ctx);

    await emitEvent(eventHandlers, "agent.run.started", makeEvent("agent.run.started", "evt-run-3", { agentName: "Scribe" }));
    await emitEvent(eventHandlers, "agent.run.finished", makeEvent("agent.run.finished", "evt-run-4", { agentName: "Scribe" }));

    expect(findMessageCreateCalls(mockDiscordFetch)).toHaveLength(2);
  });
});
