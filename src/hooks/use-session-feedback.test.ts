import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ConnectionStatus,
  EventEnvelope,
  FeedbackItem,
  InsertCapability,
  LiveSessionSnapshot,
} from "@/lib/types"

// Capture the handler `useAcpEvent` registers so tests can fire events.
let capturedHandler: ((env: EventEnvelope) => void) | null = null
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (handler: (env: EventEnvelope) => void) => {
    capturedHandler = handler
  },
}))

// Stable `t` (a fresh instance per render can loop t-dependent effects).
const stableT = (key: string, vals?: Record<string, unknown>) =>
  vals ? `${key}:${JSON.stringify(vals)}` : key
vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
}))

vi.mock("@/lib/api", () => ({
  submitSessionFeedback: vi.fn(),
  acpGetSessionSnapshot: vi.fn(),
  acpPromptInterrupt: vi.fn(),
}))
vi.mock("@/lib/app-error", () => ({
  toErrorMessage: (e: unknown) => String(e),
}))
vi.mock("@/lib/turn-busy", () => ({
  isNoActiveTurnRejection: vi.fn(() => false),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

import {
  useSessionFeedback,
  type UseSessionFeedbackArgs,
} from "./use-session-feedback"
import {
  acpGetSessionSnapshot,
  acpPromptInterrupt,
  submitSessionFeedback,
} from "@/lib/api"
import { isNoActiveTurnRejection } from "@/lib/turn-busy"
import { toast } from "sonner"

const mockSnapshot = vi.mocked(acpGetSessionSnapshot)
const mockSubmit = vi.mocked(submitSessionFeedback)
const mockInterrupt = vi.mocked(acpPromptInterrupt)
const mockIsNoTurn = vi.mocked(isNoActiveTurnRejection)

function note(
  id: string,
  text: string,
  status: "pending" | "delivered" = "pending"
): FeedbackItem {
  return { id, text, created_at: "2026-06-07T00:00:00Z", status }
}

function snapshot(
  partial: Partial<LiveSessionSnapshot> = {}
): LiveSessionSnapshot {
  return {
    feedback_tool_available: true,
    feedback: [],
    ...partial,
  } as LiveSessionSnapshot
}

const baseProps = {
  connectionId: "c1",
  connStatus: "prompting" as ConnectionStatus,
  enabled: true,
}

beforeEach(() => {
  capturedHandler = null
  vi.clearAllMocks()
  mockSnapshot.mockResolvedValue(snapshot())
  mockIsNoTurn.mockReturnValue(false)
})

describe("useSessionFeedback", () => {
  it("hydrates notes and tool availability from the snapshot", async () => {
    mockSnapshot.mockResolvedValue(
      snapshot({ feedback: [note("n1", "hi")], feedback_tool_available: true })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))

    await waitFor(() => expect(result.current.notes).toHaveLength(1))
    expect(result.current.notes[0].id).toBe("n1")
    expect(result.current.canSubmit).toBe(true)
    expect(result.current.showList).toBe(true)
  })

  it("adds, flips, and clears notes from the event stream", async () => {
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    act(() =>
      capturedHandler!({
        seq: 0,
        connection_id: "c1",
        type: "feedback_submitted",
        item: note("n1", "hi"),
      } as EventEnvelope)
    )
    expect(result.current.notes.map((n) => n.id)).toEqual(["n1"])

    act(() =>
      capturedHandler!({
        seq: 0,
        connection_id: "c1",
        type: "feedback_consumed",
        ids: ["n1"],
        delivered_at: "2026-06-07T00:01:00Z",
      } as EventEnvelope)
    )
    expect(result.current.notes[0].status).toBe("delivered")

    act(() =>
      capturedHandler!({
        seq: 0,
        connection_id: "c1",
        type: "user_message",
        message_id: "m1",
        blocks: [],
      } as EventEnvelope)
    )
    expect(result.current.notes).toHaveLength(0)
  })

  it("ignores events for other connections", async () => {
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    act(() =>
      capturedHandler!({
        seq: 0,
        connection_id: "other",
        type: "feedback_submitted",
        item: note("x", "nope"),
      } as EventEnvelope)
    )
    expect(result.current.notes).toHaveLength(0)
  })

  it("submit adds the note optimistically and closes the dialog", async () => {
    mockSubmit.mockResolvedValue(note("s1", "steer"))
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(result.current.canSubmit).toBe(true))

    act(() => result.current.openDialog())
    expect(result.current.dialogOpen).toBe(true)

    await act(async () => {
      await result.current.submit("steer")
    })

    expect(mockSubmit).toHaveBeenCalledWith("c1", "steer")
    expect(result.current.notes.map((n) => n.id)).toContain("s1")
    expect(result.current.dialogOpen).toBe(false)
  })

  it("reroutes to onResendAsPrompt when the turn already ended", async () => {
    mockSubmit.mockRejectedValue(new Error("no turn"))
    mockIsNoTurn.mockReturnValue(true)
    const onResendAsPrompt = vi.fn()
    const { result } = renderHook(() =>
      useSessionFeedback({ ...baseProps, onResendAsPrompt })
    )
    await waitFor(() => expect(result.current.canSubmit).toBe(true))

    act(() => result.current.openDialog())
    await act(async () => {
      await result.current.submit("late note")
    })

    expect(onResendAsPrompt).toHaveBeenCalledWith("late note")
    expect(result.current.dialogOpen).toBe(false)
    expect(toast.info).toHaveBeenCalled()
  })

  it("shows an error toast on a generic submit failure", async () => {
    mockSubmit.mockRejectedValue(new Error("boom"))
    mockIsNoTurn.mockReturnValue(false)
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(result.current.canSubmit).toBe(true))

    await act(async () => {
      await result.current.submit("x")
    })

    expect(toast.error).toHaveBeenCalled()
  })

  it("gates canSubmit/showList on feature flag and active turn", async () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: { ...baseProps, enabled: false } }
    )
    // Feature off: never submittable, never fetches the snapshot.
    expect(result.current.featureEnabled).toBe(false)
    expect(result.current.canSubmit).toBe(false)
    expect(mockSnapshot).not.toHaveBeenCalled()

    // Enabled but idle (not prompting): entry shown but not submittable.
    rerender({ ...baseProps, connStatus: "connected" })
    await waitFor(() => expect(mockSnapshot).toHaveBeenCalled())
    expect(result.current.featureEnabled).toBe(true)
    expect(result.current.canSubmit).toBe(false)
    expect(result.current.showList).toBe(false)
  })

  it("discards a snapshot that resolves after a new turn started", async () => {
    let resolveSnap: (s: LiveSessionSnapshot | null) => void = () => {}
    mockSnapshot.mockReturnValue(
      new Promise<LiveSessionSnapshot | null>((r) => {
        resolveSnap = r
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    // A new turn lands while the snapshot fetch is still in flight.
    act(() =>
      capturedHandler!({
        seq: 0,
        connection_id: "c1",
        type: "user_message",
        message_id: "m1",
        blocks: [],
      } as EventEnvelope)
    )

    // The previous turn's snapshot now resolves — its notes must be dropped,
    // but tool availability (fixed at launch) is still applied.
    await act(async () => {
      resolveSnap(
        snapshot({
          feedback: [note("stale", "old turn")],
          feedback_tool_available: true,
        })
      )
    })

    await waitFor(() => expect(result.current.canSubmit).toBe(true))
    expect(result.current.notes).toHaveLength(0)
  })

  it("does not send when the feature is disabled while the dialog is open", async () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: baseProps }
    )
    await waitFor(() => expect(result.current.canSubmit).toBe(true))

    act(() => result.current.openDialog())
    expect(result.current.dialogOpen).toBe(true)

    // Feature toggled off elsewhere: the entry hides, but the dialog is open.
    rerender({ ...baseProps, enabled: false })

    await act(async () => {
      await result.current.submit("note")
    })

    expect(mockSubmit).not.toHaveBeenCalled()
    expect(result.current.dialogOpen).toBe(false)
  })

  it("native steering alone unlocks canSubmit and flips the channel", async () => {
    // The backend-synthesized flag is the ONLY native signal — no agent-type
    // checks here. A session without the pull tool (no MCP) but with native
    // steering must be fully usable.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        native_steering_available: true,
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))

    await waitFor(() => expect(result.current.canSubmit).toBe(true))
    expect(result.current.channel).toBe("native")
    expect(result.current.steerAvailable).toBe(true)
  })

  it("reads the capability's steer channel and its boundary", async () => {
    // The P1/P2 model: `insert_capability.steer` is what the frontend reads for
    // the insert entry (the legacy bool is its transitional projection). A
    // capability-only payload — no pull tool, legacy bool absent — must unlock
    // the entry and carry the adapter's declared boundary into the copy.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        insert_capability: { steer: { boundary: "immediate" }, pull: false },
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))

    await waitFor(() => expect(result.current.channel).toBe("native"))
    expect(result.current.steerAvailable).toBe(true)
    expect(result.current.canSubmit).toBe(true)
    expect(result.current.insertBoundary).toBe("immediate")
  })

  it("self-heals the capability and boundary once the connection goes live", async () => {
    // The new connection's FIRST snapshot (while "connecting") precedes the
    // backend's initialize synthesis: it carries neither channel. The
    // self-heal re-read must pick BOTH the capability and its boundary up, or
    // a fresh zcode session renders its insert entry with generic copy — or
    // never at all.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        insert_capability: null,
      })
    )
    const { result, rerender } = renderHook(
      (props: UseSessionFeedbackArgs) => useSessionFeedback(props),
      {
        initialProps: {
          ...baseProps,
          connStatus: "connecting",
        } as UseSessionFeedbackArgs,
      }
    )
    await waitFor(() => expect(mockSnapshot).toHaveBeenCalled())
    expect(result.current.steerAvailable).toBe(false)

    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        insert_capability: { steer: { boundary: "step" }, pull: false },
      })
    )
    rerender({ ...baseProps, connStatus: "prompting" })

    await waitFor(() => expect(result.current.channel).toBe("native"))
    expect(result.current.insertBoundary).toBe("step")
  })

  it("falls back to the generic insert copy on an unknown boundary", async () => {
    // A future adapter value must not be guessed at: the channel works, but the
    // copy promises nothing about timing.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        // Deliberately outside the union — what a newer server could send. The
        // `unknown` hop is the point: this payload is not expressible in the
        // current type, which is exactly what the hook must survive.
        insert_capability: {
          steer: { boundary: "drain" },
        } as unknown as InsertCapability,
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))

    await waitFor(() => expect(result.current.channel).toBe("native"))
    expect(result.current.insertBoundary).toBeNull()
  })

  it("stays on the pull channel when only the tool is available", async () => {
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: true,
        native_steering_available: false,
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))

    await waitFor(() => expect(result.current.canSubmit).toBe(true))
    expect(result.current.channel).toBe("pull")
    // The pull tool is a working delivery channel — the composer's mid-turn
    // send must be offered here too, not only on native sessions.
    expect(result.current.steerAvailable).toBe(true)
  })

  it("reports no steer channel when the session has neither", async () => {
    // No tool (launched before the feature was enabled / agent without MCP)
    // and no native steering: the composer must keep its historical Stop-only
    // prompting form, so `steerAvailable` stays false even mid-turn.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        native_steering_available: false,
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))

    // Both flags START false, so asserting before the reads land would pass
    // no matter what the hook does with them. Wait for BOTH snapshot reads
    // (hydrate + self-heal, each fired on mount) and flush their resolutions
    // first — only then does `false` mean "the snapshot said no channel".
    await waitFor(() => expect(mockSnapshot).toHaveBeenCalledTimes(2))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.steerAvailable).toBe(false)
    expect(result.current.canSubmit).toBe(false)
  })

  it("drops the steer channel when switching to a session without one", async () => {
    // The flags only ever UPGRADE from a snapshot, so the per-connection reset
    // is the sole thing standing between a capable session and the next tab
    // inheriting its channel. Without it the composer would keep offering the
    // mid-turn send on a session whose backend rejects every note.
    const { result, rerender } = renderHook(
      (props: UseSessionFeedbackArgs) => useSessionFeedback(props),
      { initialProps: baseProps as UseSessionFeedbackArgs }
    )
    await waitFor(() => expect(result.current.steerAvailable).toBe(true))

    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        native_steering_available: false,
      })
    )
    rerender({ ...baseProps, connectionId: "c2" })

    await waitFor(() => expect(result.current.steerAvailable).toBe(false))
    expect(result.current.canSubmit).toBe(false)
  })

  // --- notes that outlive their turn -------------------------------------

  /** Mount mid-turn, land `items` as live notes, then end the turn. */
  async function endTurnWith(
    items: FeedbackItem[],
    props: Partial<UseSessionFeedbackArgs> = {}
  ) {
    const hook = renderHook(
      (p: UseSessionFeedbackArgs) => useSessionFeedback(p),
      { initialProps: { ...baseProps, ...props } as UseSessionFeedbackArgs }
    )
    await waitFor(() => expect(capturedHandler).toBeTruthy())
    for (const item of items) {
      act(() =>
        capturedHandler!({
          seq: 0,
          connection_id: "c1",
          type: "feedback_submitted",
          item,
        } as EventEnvelope)
      )
    }
    // The agent stopped without ever calling `check_user_feedback`.
    hook.rerender({
      ...baseProps,
      ...props,
      connStatus: "connected",
    } as UseSessionFeedbackArgs)
    return hook
  }

  it("keeps an unread note listed once the turn ends, as expired", async () => {
    const { result } = await endTurnWith([note("n1", "use pnpm")])

    // The whole point: the list used to hide the moment `isPrompting` dropped,
    // taking the user's unread text with it.
    expect(result.current.showList).toBe(true)
    expect(result.current.notesExpired).toBe(true)
    expect(result.current.notes.map((n) => n.id)).toEqual(["n1"])
  })

  it("retires the note the agent read and keeps the one it did not", async () => {
    const { result } = await endTurnWith([
      note("read", "already seen", "delivered"),
      note("unread", "use pnpm"),
    ])

    // A delivered note steered the turn it belonged to — nothing left to
    // salvage, so it goes with the turn.
    expect(result.current.notes.map((n) => n.id)).toEqual(["unread"])
    expect(result.current.notesExpired).toBe(true)
  })

  it("hides the list when the turn ends with every note read", async () => {
    const { result } = await endTurnWith([
      note("read", "already seen", "delivered"),
    ])

    expect(result.current.showList).toBe(false)
    expect(result.current.notesExpired).toBe(false)
  })

  it.each(["connecting", "disconnected", "error"] as const)(
    "does not call the turn over on a %s session",
    async (connStatus) => {
      // Only a live, IDLE session proves the turn ended. These three can read
      // "not prompting" with the agent still running and the note still
      // consumable — a mid-turn attach hydrates in `connecting`, and the
      // liveness sweep flips to `disconnected` when the terminal event never
      // arrived. Offering "send as message" there buys a duplicate: the user
      // queues a copy, the agent goes on to read the original.
      const { result } = renderHook(
        (p: UseSessionFeedbackArgs) => useSessionFeedback(p),
        { initialProps: { ...baseProps, connStatus } as UseSessionFeedbackArgs }
      )
      await waitFor(() => expect(capturedHandler).toBeTruthy())
      act(() =>
        capturedHandler!({
          seq: 0,
          connection_id: "c1",
          type: "feedback_submitted",
          item: note("n1", "use pnpm"),
        } as EventEnvelope)
      )

      expect(result.current.notesExpired).toBe(false)
      expect(result.current.showList).toBe(false)
    }
  )

  it("resendNote sends the note's text as a message and retires the row", async () => {
    const onResendAsPrompt = vi.fn()
    const { result } = await endTurnWith([note("n1", "use pnpm")], {
      onResendAsPrompt,
    })

    act(() => result.current.resendNote("n1"))

    expect(onResendAsPrompt).toHaveBeenCalledWith("use pnpm")
    expect(onResendAsPrompt).toHaveBeenCalledTimes(1)
    expect(result.current.showList).toBe(false)
  })

  it("resendNote sends once even when clicked twice in a tick", async () => {
    // Both calls see the row: it only leaves on the next render. Resending is
    // the one action here that would actually reach the agent twice.
    const onResendAsPrompt = vi.fn()
    const { result } = await endTurnWith([note("n1", "use pnpm")], {
      onResendAsPrompt,
    })

    act(() => {
      result.current.resendNote("n1")
      result.current.resendNote("n1")
    })

    expect(onResendAsPrompt).toHaveBeenCalledTimes(1)
  })

  it("dismissNote retires only its own row, and sends nothing", async () => {
    const onResendAsPrompt = vi.fn()
    const { result } = await endTurnWith(
      [note("n1", "use pnpm"), note("n2", "and run the tests")],
      { onResendAsPrompt }
    )

    act(() => result.current.dismissNote("n1"))

    expect(onResendAsPrompt).not.toHaveBeenCalled()
    expect(result.current.notes.map((n) => n.id)).toEqual(["n2"])
  })

  it("keeps a retired row retired against a late submit broadcast", async () => {
    const { result } = await endTurnWith([note("n1", "use pnpm")])
    act(() => result.current.dismissNote("n1"))
    expect(result.current.showList).toBe(false)

    // The broadcast for that very note arriving out of order must not re-add
    // the row the user already dealt with.
    act(() =>
      capturedHandler!({
        seq: 0,
        connection_id: "c1",
        type: "feedback_submitted",
        item: note("n1", "use pnpm"),
      } as EventEnvelope)
    )

    expect(result.current.notes).toHaveLength(0)
    expect(result.current.showList).toBe(false)
  })

  it("keeps a retired row retired across a re-hydrate", async () => {
    // The note stays `pending` backend-side until the next turn clears it, so
    // the snapshot still carries it — only the tombstone keeps a row the user
    // already dealt with from reappearing.
    mockSnapshot.mockResolvedValue(
      snapshot({ feedback: [note("n1", "use pnpm")] })
    )
    const { result, rerender } = renderHook(
      (props: UseSessionFeedbackArgs) => useSessionFeedback(props),
      { initialProps: baseProps as UseSessionFeedbackArgs }
    )
    await waitFor(() => expect(result.current.notes).toHaveLength(1))
    act(() => result.current.dismissNote("n1"))
    expect(result.current.notes).toHaveLength(0)

    // Toggling the feature off and back on re-runs the hydrate on the SAME
    // connection, against a snapshot that still lists the note.
    const before = mockSnapshot.mock.calls.length
    rerender({ ...baseProps, enabled: false })
    rerender(baseProps)
    await waitFor(() =>
      expect(mockSnapshot.mock.calls.length).toBeGreaterThan(before)
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.notes).toHaveLength(0)
  })

  it("steer appends optimistically on success and RETHROWS on failure", async () => {
    // The composer owns its own fallback (enqueue) and draft policy — steer
    // must never swallow errors into toasts the way the dialog's submit does.
    mockSubmit.mockResolvedValueOnce(note("st1", "go left", "delivered"))
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(result.current.canSubmit).toBe(true))

    await act(async () => {
      await result.current.steer("go left")
    })
    expect(mockSubmit).toHaveBeenCalledWith("c1", "go left", undefined)
    expect(result.current.notes.map((n) => n.id)).toContain("st1")

    // A draft with attachments hands its full block list through untouched —
    // the API layer owns upload-marker stripping, the backend the channel
    // gate; the hook adds nothing.
    const blocks = [
      { type: "text" as const, text: "match this" },
      {
        type: "image" as const,
        data: "aGk=",
        mime_type: "image/png",
      },
    ]
    mockSubmit.mockResolvedValueOnce(note("st2", "match this", "delivered"))
    await act(async () => {
      await result.current.steer("match this", blocks)
    })
    expect(mockSubmit).toHaveBeenCalledWith("c1", "match this", blocks)

    const noTurn = new Error("no turn")
    mockSubmit.mockRejectedValueOnce(noTurn)
    mockIsNoTurn.mockReturnValue(true)
    await expect(
      act(async () => {
        await result.current.steer("late")
      })
    ).rejects.toBe(noTurn)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it("converges after the real startedNewTurn round: delivered result + backend flag off", async () => {
    // The downgrade round itself returns DELIVERED (the detached turn
    // consumed the content) — status alone can't reveal the downgrade. The
    // hook must verify the authoritative snapshot after the submit and flip
    // silently, so the NEXT action already stops offering "insert into
    // current turn" instead of mislabeling one more note.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: true,
        native_steering_available: true,
      })
    )
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: baseProps }
    )
    await waitFor(() => expect(result.current.channel).toBe("native"))

    // Backend state at the time of the steer's verify read: flag already off.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: true,
        native_steering_available: false,
      })
    )
    mockSubmit.mockResolvedValueOnce(note("dg0", "consumed", "delivered"))
    await act(async () => {
      await result.current.steer("consumed")
    })

    await waitFor(() => expect(result.current.channel).toBe("pull"))
    // Silent: that round's note WAS consumed by the agent — nothing to warn
    // about; only future actions change surface.
    expect(toast.info).not.toHaveBeenCalled()

    // A later stale snapshot still reporting the launch-time `true` must not
    // resurrect the native channel (latch).
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: true,
        native_steering_available: true,
      })
    )
    rerender({ ...baseProps, connStatus: "connected" })
    rerender({ ...baseProps })
    await waitFor(() => expect(result.current.canSubmit).toBe(true))
    expect(result.current.channel).toBe("pull")
  })

  it("downgrades with a notice when a native-session submit comes back pending", async () => {
    // The pull-path result on a supposedly-native session (a submit racing
    // the downgrade window, or the dialog path right after it): the note was
    // recorded as a WAITING pull note, not injected — the user must be told
    // the delivery semantics changed, and the channel converges.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: true,
        native_steering_available: true,
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(result.current.channel).toBe("native"))

    mockSubmit.mockResolvedValueOnce(note("dg1", "note", "pending"))
    await act(async () => {
      await result.current.steer("note")
    })

    expect(result.current.channel).toBe("pull")
    expect(toast.info).toHaveBeenCalled()
    // Note not lost — it's tracked as a waiting pull note.
    expect(result.current.notes.map((n) => n.id)).toContain("dg1")
  })

  it("ignores a late pending result from a previous connection", async () => {
    // Connection A's steer resolves pending AFTER the user switched to B: the
    // stale closure must not latch B's downgrade ref, flip B's channel, or
    // leak A's note into B's list.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: true,
        native_steering_available: true,
      })
    )
    let resolveSubmit: (i: FeedbackItem) => void = () => {}
    mockSubmit.mockReturnValueOnce(
      new Promise<FeedbackItem>((r) => {
        resolveSubmit = r
      })
    )
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: baseProps }
    )
    await waitFor(() => expect(result.current.channel).toBe("native"))

    let steerPromise: Promise<FeedbackItem> | null = null
    act(() => {
      steerPromise = result.current.steer("from A")
    })
    // Switch to connection B while A's submit is in flight.
    rerender({ ...baseProps, connectionId: "c2" })
    await waitFor(() => expect(result.current.channel).toBe("native"))

    await act(async () => {
      resolveSubmit(note("a1", "from A", "pending"))
      await steerPromise
    })

    expect(result.current.channel).toBe("native")
    expect(toast.info).not.toHaveBeenCalled()
    expect(result.current.notes.map((n) => n.id)).not.toContain("a1")
  })

  it("re-reads tool availability once the connection becomes live", async () => {
    // A new connection's id appears while it's still "connecting", before the
    // backend has set feedback_tool_available — the first read says false; the
    // later (live) read says true.
    mockSnapshot.mockResolvedValueOnce(
      snapshot({ feedback_tool_available: false })
    )
    mockSnapshot.mockResolvedValue(snapshot({ feedback_tool_available: true }))

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      {
        initialProps: {
          ...baseProps,
          connStatus: "connecting" as ConnectionStatus,
        },
      }
    )
    await waitFor(() => expect(mockSnapshot).toHaveBeenCalled())
    expect(result.current.canSubmit).toBe(false)

    // Connection goes live (streaming) → tool availability is re-read.
    rerender({ ...baseProps, connStatus: "prompting" })
    await waitFor(() => expect(result.current.canSubmit).toBe(true))
  })
})

/**
 * A note the transcript adopted as a mid-turn user turn is a MESSAGE now, so
 * its strip above the composer goes away - otherwise the same text is on
 * screen twice for the rest of the turn.
 *
 * The adoption decision belongs to the connection reducer (it is the only
 * thing that knows whether there was a running turn to splice the message
 * into), so the hook is told which ids were taken rather than guessing. A note
 * that was NOT adopted keeps its strip, which is what makes "shows in exactly
 * one place" true in both directions.
 */
describe("useSessionFeedback steered-note strips", () => {
  // Widen the props type so a test can vary `steeredMessageIds`;
  // `baseProps` alone would pin it to the three fields it declares.
  const props: Parameters<typeof useSessionFeedback>[0] = baseProps

  it("drops the strip for a note the transcript adopted", async () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: props }
    )
    act(() => {
      capturedHandler?.({
        type: "feedback_submitted",
        connection_id: "c1",
        item: note("n1", "use the other API", "delivered"),
      } as unknown as EventEnvelope)
    })
    await waitFor(() => expect(result.current.notes).toHaveLength(1))

    // The reducer spliced it into the live turn.
    rerender({ ...baseProps, steeredMessageIds: ["n1"] })
    expect(result.current.notes).toHaveLength(0)
    expect(result.current.showList).toBe(false)
  })

  it("keeps the strip for a note the transcript could not adopt", async () => {
    const { result } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: { ...baseProps, steeredMessageIds: [] } }
    )
    act(() => {
      capturedHandler?.({
        type: "feedback_submitted",
        connection_id: "c1",
        item: note("n1", "landed after the turn ended", "delivered"),
      } as unknown as EventEnvelope)
    })
    // No adoption reported, so the note stays visible somewhere.
    await waitFor(() => expect(result.current.notes).toHaveLength(1))
    expect(result.current.showList).toBe(true)
  })

  it("leaves pull-channel notes alone - they never become messages", async () => {
    // A `check_user_feedback` note reaches the agent as a tool result, not as
    // a user message, so it has no user turn on reload either. Strips are the
    // right and only home for it, waiting or read.
    const { result } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: { ...baseProps, steeredMessageIds: [] } }
    )
    act(() => {
      capturedHandler?.({
        type: "feedback_submitted",
        connection_id: "c1",
        item: note("n1", "waiting note"),
      } as unknown as EventEnvelope)
    })
    await waitFor(() => expect(result.current.notes).toHaveLength(1))
    act(() => {
      capturedHandler?.({
        type: "feedback_consumed",
        connection_id: "c1",
        ids: ["n1"],
        delivered_at: "2026-06-07T00:00:05Z",
      } as unknown as EventEnvelope)
    })
    // Read by the agent, still a strip.
    expect(result.current.notes).toHaveLength(1)
    expect(result.current.notes[0].status).toBe("delivered")
    expect(result.current.showList).toBe(true)
  })

  it("only drops the ids it was given", async () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useSessionFeedback>[0]) =>
        useSessionFeedback(props),
      { initialProps: props }
    )
    act(() => {
      capturedHandler?.({
        type: "feedback_submitted",
        connection_id: "c1",
        item: note("n1", "one", "delivered"),
      } as unknown as EventEnvelope)
      capturedHandler?.({
        type: "feedback_submitted",
        connection_id: "c1",
        item: note("n2", "two", "delivered"),
      } as unknown as EventEnvelope)
    })
    await waitFor(() => expect(result.current.notes).toHaveLength(2))
    rerender({ ...baseProps, steeredMessageIds: ["n1"] })
    expect(result.current.notes.map((n) => n.id)).toEqual(["n2"])
  })
})

/**
 * Interrupt-and-send is NOT a live-feedback action: it goes over the ordinary
 * prompt wire (`acpPromptInterrupt`), needs no steer/pull channel, and its
 * in-flight latch is shared by every caller (the composer's dropdown and the
 * queue rows) so two interrupts can never be admitted against one hand-over.
 */
describe("useSessionFeedback interruptAndSend", () => {
  const blocks = [{ type: "text" as const, text: "stop and do this" }]

  it("sends the full block list and latches while the admission is in flight", async () => {
    let finish: () => void = () => {}
    mockInterrupt.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    let pending: Promise<void> | null = null
    act(() => {
      pending = result.current.interruptAndSend(blocks)
    })
    await waitFor(() => expect(result.current.interrupting).toBe(true))
    expect(mockInterrupt).toHaveBeenCalledWith("c1", blocks)

    await act(async () => {
      finish()
      await pending
    })
    expect(result.current.interrupting).toBe(false)
  })

  it("ignores a second call while one is in flight", async () => {
    // The UI disables the action, but a click that still slips through a
    // pending render must not cancel twice — the backend would refuse it and
    // the caller would misread the refusal as a real failure.
    let finish: () => void = () => {}
    mockInterrupt.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    let first: Promise<void> | null = null
    act(() => {
      first = result.current.interruptAndSend(blocks)
    })
    await waitFor(() => expect(result.current.interrupting).toBe(true))

    await act(async () => {
      await result.current.interruptAndSend(blocks)
    })
    expect(mockInterrupt).toHaveBeenCalledTimes(1)

    await act(async () => {
      finish()
      await first
    })
  })

  it("rethrows a failure and clears the latch for a retry", async () => {
    // The caller owns the draft policy: the hook must not swallow the error,
    // and a failed attempt must not strand the latch (the retry goes through).
    const boom = new Error("boom")
    mockInterrupt.mockRejectedValueOnce(boom)
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    // Caught INSIDE the act callback: a rejecting one leaves React's act
    // environment poisoned for every later render in the file.
    let failure: unknown = null
    await act(async () => {
      await result.current.interruptAndSend(blocks).catch((err: unknown) => {
        failure = err
      })
    })
    expect(failure).toBe(boom)
    expect(result.current.interrupting).toBe(false)

    mockInterrupt.mockResolvedValueOnce(undefined)
    await act(async () => {
      await result.current.interruptAndSend(blocks)
    })
    expect(mockInterrupt).toHaveBeenCalledTimes(2)
  })

  it("needs no steer channel and no note state", async () => {
    // A session with neither the pull tool nor native steering keeps its
    // historical Stop-only composer — but cancelling and resending is a plain
    // ACP sequence every agent supports, so the interrupt must still work.
    mockSnapshot.mockResolvedValue(
      snapshot({
        feedback_tool_available: false,
        native_steering_available: false,
      })
    )
    const { result } = renderHook(() => useSessionFeedback(baseProps))
    await waitFor(() => expect(mockSnapshot).toHaveBeenCalledTimes(2))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.steerAvailable).toBe(false)

    mockInterrupt.mockResolvedValueOnce(undefined)
    await act(async () => {
      await result.current.interruptAndSend(blocks)
    })
    expect(mockInterrupt).toHaveBeenCalledWith("c1", blocks)
    // Nothing about it shows up in the notes list — it is a message, not a note.
    expect(result.current.notes).toHaveLength(0)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
