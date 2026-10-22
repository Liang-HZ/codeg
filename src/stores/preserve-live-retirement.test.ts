/**
 * P0 (insert-mid-turn §5.2): the `preserveLive` refetch must not restate the
 * previous round.
 *
 * The pill's click refetches the detail with `preserveLive: true`, which keeps
 * the local buffers so the fetch can't clobber an in-flight reply — but once
 * the fetched transcript has caught up, the previous round exists twice: the
 * persisted copy under the parser's id (`acp-N` for `AcpNativeParser`) and the
 * local promoted copy under its `live-…`/client id, which `dedupeTimeline`
 * (role + id) cannot collapse across the two namespaces.
 *
 * The fix retires local copies this same detail PROVES are persisted:
 * `source_turn_id` (the parser's name for a local reply, backfilled by the
 * post-turn reparse) resolving to a persisted assistant turn — plus the user
 * turn immediately before it when the persisted prompt immediately before the
 * twin carries the same full content key. Nothing else retires: without a
 * proof the local copy stays (a visible duplicate beats a hidden message).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import {
  resetConversationRuntimeStore,
  selectTimelineTurns,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 84

function ts(secs: number): string {
  return new Date(1_700_000_000_000 + secs * 1000).toISOString()
}

function userTurn(id: string, text: string, secs = 0): MessageTurn {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: ts(secs),
  }
}

function assistantTurn(over: Partial<MessageTurn>): MessageTurn {
  return {
    id: "a",
    role: "assistant",
    blocks: [{ type: "text", text: "reply" }],
    timestamp: ts(1),
    ...over,
  }
}

function detail(
  turns: MessageTurn[],
  over: Partial<DbConversationDetail> = {}
) {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "custom",
      title: null,
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-1",
      message_count: turns.length,
      child_count: 0,
      created_at: ts(0),
      updated_at: ts(9),
      pinned_at: null,
    },
    turns,
    session_stats: null,
    transcript_watermark: null,
    in_flight_user_turn_id: null,
    turns_offset: 0,
    turns_total: turns.length,
    assistant_turns_before_offset: 0,
    prefix_hash: null,
    uncovered_prefix_max_ts: null,
    ...over,
  } as unknown as DbConversationDetail
}

function emptySession(conversationId: number): ConversationRuntimeSession {
  return {
    conversationId,
    externalId: "ext-1",
    dbConversationId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    pendingCancelledTurnReports: null,
    optimisticTurns: [],
    liveMessage: null,
    syncState: "idle",
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
    batchRetiredAssistantCount: 0,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
  }
}

function seed(overrides: Partial<ConversationRuntimeSession> = {}): void {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, { ...emptySession(CID), ...overrides }]]),
  })
}

function session(): ConversationRuntimeSession | undefined {
  return useConversationRuntimeStore.getState().byConversationId.get(CID)
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

function timelineIds(): string[] {
  return selectTimelineTurns(useConversationRuntimeStore.getState(), CID).map(
    (entry) => entry.turn.id
  )
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGet.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("preserveLive detail refetch retirement", () => {
  it("retires the local copies this detail proves persisted — timeline single copy", async () => {
    const localUser = userTurn("u-1", "提交、线上复核", 0)
    const localAssistant = assistantTurn({
      id: "live-84-1",
      timestamp: ts(0),
      // Backfilled by the post-turn reparse: the parser's own name for this
      // same reply, plus the completion instant recorded from that record.
      source_turn_id: "acp-1",
      completed_at: ts(1),
    })
    seed({ localTurns: [localUser, localAssistant] })
    mockGet.mockResolvedValue(
      detail([
        userTurn("acp-0", "提交、线上复核", 0),
        assistantTurn({ id: "acp-1", timestamp: ts(1), completed_at: ts(1) }),
      ])
    )

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    // Both copies retired (the user turn via its proven partner + full content
    // match), so the timeline renders ONE copy of the round — the persisted
    // one.
    expect(session()?.localTurns).toEqual([])
    expect(session()?.batchRetiredAssistantCount).toBe(1)
    expect(timelineIds()).toEqual(["acp-0", "acp-1"])
  })

  it("keeps a local turn with no correspondence proof (visible duplicate)", async () => {
    // No `source_turn_id`: the local reply is not namable against the parse,
    // so nothing links it to the persisted copy. Keeping both copies visible
    // is the documented failure direction.
    seed({
      localTurns: [
        userTurn("u-1", "hello", 0),
        assistantTurn({ id: "live-84-1" }),
      ],
    })
    mockGet.mockResolvedValue(
      detail([
        userTurn("acp-0", "hello", 0),
        assistantTurn({ id: "acp-1", timestamp: ts(1) }),
      ])
    )

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    expect(session()?.localTurns).toHaveLength(2)
    expect(session()?.batchRetiredAssistantCount).toBe(0)
    expect(timelineIds()).toEqual(["acp-0", "acp-1", "u-1", "live-84-1"])
  })

  it("keeps the duplicate when a stale name resolves to a rewritten record", async () => {
    // Compaction renumbered the parse: `acp-1` still resolves, but to a
    // DIFFERENT reply (its completion instant moved). The id alone would hide
    // the local copy here; the `completed_at` leg catches it and keeps both.
    seed({
      localTurns: [
        userTurn("u-1", "hello", 0),
        assistantTurn({
          id: "live-84-1",
          source_turn_id: "acp-1",
          completed_at: ts(1),
        }),
      ],
    })
    mockGet.mockResolvedValue(
      detail([
        userTurn("acp-0", "hello", 0),
        assistantTurn({ id: "acp-1", timestamp: ts(9), completed_at: ts(9) }),
      ])
    )

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    expect(session()?.localTurns).toHaveLength(2)
    expect(session()?.batchRetiredAssistantCount).toBe(0)
  })

  it("stops assistant retirement at the first unproven reply", async () => {
    // A1 is proven; A2 is not. The sync alignment counts a PREFIX of retired
    // assistants (`batchRetiredAssistantCount`), so retirement must stop
    // there — A2 (and the prompt before it) stays visible.
    seed({
      localTurns: [
        userTurn("u-1", "first", 0),
        assistantTurn({
          id: "live-84-1",
          source_turn_id: "acp-1",
          completed_at: ts(1),
        }),
        userTurn("u-2", "second", 2),
        assistantTurn({ id: "live-84-2", timestamp: ts(3) }),
      ],
    })
    mockGet.mockResolvedValue(
      detail([
        userTurn("acp-0", "first", 0),
        assistantTurn({ id: "acp-1", timestamp: ts(1), completed_at: ts(1) }),
      ])
    )

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    expect(session()?.localTurns.map((t) => t.id)).toEqual(["u-2", "live-84-2"])
    expect(session()?.batchRetiredAssistantCount).toBe(1)
  })

  it("keeps the adjacent user turn when its content differs from the persisted prompt", async () => {
    // The reply is proven, but the user copy can't be matched (an attachment
    // round-trips differently on the two paths). Hiding the wrong message is
    // the one unrecoverable failure, so the user copy stays.
    seed({
      localTurns: [
        userTurn("u-1", "with attachment", 0),
        assistantTurn({
          id: "live-84-1",
          source_turn_id: "acp-1",
          completed_at: ts(1),
        }),
      ],
    })
    mockGet.mockResolvedValue(
      detail([
        userTurn("acp-0", "different payload", 0),
        assistantTurn({ id: "acp-1", timestamp: ts(1), completed_at: ts(1) }),
      ])
    )

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    expect(session()?.localTurns.map((t) => t.id)).toEqual(["u-1"])
    expect(session()?.batchRetiredAssistantCount).toBe(1)
  })

  it("runs independently of the watermark overlay retirement", async () => {
    // Both retirement rules fire from the same response: the overlay entry the
    // transcript watermark now covers, and the local copy the id link proves.
    // Neither may affect the other's inputs.
    seed({
      localTurns: [
        userTurn("u-1", "hello", 0),
        assistantTurn({
          id: "live-84-1",
          source_turn_id: "acp-1",
          completed_at: ts(1),
        }),
      ],
      backgroundTurns: [
        {
          turn: assistantTurn({ id: "bg-1", timestamp: ts(2) }),
          watermark: 50,
        },
      ],
    })
    mockGet.mockResolvedValue(
      detail(
        [
          userTurn("acp-0", "hello", 0),
          assistantTurn({ id: "acp-1", timestamp: ts(1), completed_at: ts(1) }),
        ],
        { transcript_watermark: 100 }
      )
    )

    actions().refetchDetail(CID, { preserveLive: true })
    await flush()

    expect(session()?.backgroundTurns).toEqual([])
    expect(session()?.localTurns).toEqual([])
    expect(timelineIds()).toEqual(["acp-0", "acp-1"])
  })

  it("resets the retired ledger when a fresh batch starts", async () => {
    seed({
      localTurns: [
        userTurn("u-1", "hello", 0),
        assistantTurn({
          id: "live-84-1",
          source_turn_id: "acp-1",
          completed_at: ts(1),
        }),
      ],
    })
    mockGet.mockResolvedValue(
      detail([
        userTurn("acp-0", "hello", 0),
        assistantTurn({ id: "acp-1", timestamp: ts(1), completed_at: ts(1) }),
      ])
    )
    actions().refetchDetail(CID, { preserveLive: true })
    await flush()
    expect(session()?.batchRetiredAssistantCount).toBe(1)

    // Everything was retired, so the next send is a fresh batch: the boundary
    // is re-captured from the current detail and the ledger starts over.
    actions().appendOptimisticTurn(CID, userTurn("u-2", "next", 5), "tok-1")
    expect(session()?.batchRetiredAssistantCount).toBe(0)
    expect(session()?.batchBoundaryIndex).toBe(2)
  })
})

const BOUNDARY = 2

function hashPrefix(count: number): string {
  const full = [
    userTurn("acp-0", "hello", 0),
    assistantTurn({ id: "acp-1", timestamp: ts(1) }),
  ]
  const h = extendPrefixFingerprint(FNV_SEED_HEX, full.slice(0, count))
  if (h === null) throw new Error("fingerprint failed")
  return h
}

describe("metadata sync after a retirement", () => {
  it("drops the retired twins from the alignment instead of folding them into the survivors", async () => {
    vi.useFakeTimers()
    // State left by the pill refetch: A's local copies were retired (count 1)
    // while B was still unsynced, so B has no `source_turn_id` yet and the
    // batch boundary still anchors the whole batch.
    seed({
      localTurns: [
        userTurn("u-2", "second", 2),
        assistantTurn({ id: "live-84-2", timestamp: ts(3) }),
      ],
      batchBoundaryIndex: BOUNDARY,
      batchBoundaryPrefixHash: hashPrefix(BOUNDARY),
      batchRetiredAssistantCount: 1,
    })
    // The window from the same boundary leads with A's persisted twin; B's
    // stats must come from B's own record only, and its `source_turn_id` must
    // become nameable again (offset 0 after the retired prefix is dropped).
    mockGet.mockResolvedValue(
      detail(
        [
          {
            ...assistantTurn({ id: "acp-2", timestamp: ts(3) }),
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            duration_ms: 5000,
          },
          {
            ...assistantTurn({ id: "acp-3", timestamp: ts(4) }),
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            duration_ms: 100,
          },
        ],
        {
          turns_offset: BOUNDARY,
          turns_total: 4,
          assistant_turns_before_offset: 1,
          prefix_hash: hashPrefix(BOUNDARY),
        }
      )
    )

    actions().syncTurnMetadata(CID)
    await vi.advanceTimersByTimeAsync(1600)

    const assistant = session()?.localTurns[1]
    expect(assistant?.usage?.input_tokens).toBe(1)
    expect(assistant?.duration_ms).toBe(100)
    expect(assistant?.source_turn_id).toBe("acp-3")
  })
})
