"use client"

import { useCallback, useRef, useState, type PointerEvent } from "react"
import { Reorder, useDragControls } from "motion/react"
import { Clock, GripVertical, OctagonX, Pencil, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { draftRidesBlocks } from "@/lib/prompt-draft"
import type { QueuedMessage } from "@/hooks/use-message-queue"

interface MessageQueueDisplayProps {
  queue: QueuedMessage[]
  onReorder: (items: QueuedMessage[]) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  editingItemId: string | null
  /**
   * Send one queued item straight into the RUNNING turn over the session's
   * live-feedback channel (same delivery as the composer's mid-turn send).
   * Present only while the session has a working channel AND a turn is in
   * flight; the host decides whether the row is removed (it stays queued on
   * the turn-end race). Resolves once delivery is settled.
   */
  onSteerItem?: (id: string) => Promise<void> | void
  /** Which channel {@link onSteerItem} rides; picks the honest icon/copy,
   *  mirroring the composer's split-button (`Zap` = instant insert,
   *  `Clock` = note the agent reads on its next check). */
  steerChannel?: "native" | "pull"
  /**
   * Stop the running turn and send THIS row as the next one ("interrupt and
   * send now"). Present while a turn is in flight, on EVERY session — the
   * action is a plain `session/cancel` + `session/prompt`, not a live-feedback
   * insert, so it needs no steer channel. Confirmed destructively before it
   * runs; the host removes the row on success and reports failures.
   */
  onInterruptItem?: (id: string) => Promise<void> | void
}

interface QueueItemProps {
  item: QueuedMessage
  index: number
  isEditing: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSteerItem?: (id: string) => Promise<void> | void
  steerChannel: "native" | "pull"
  /** Whether an insert from ANY row is in flight — every row's button is
   *  disabled for the duration, so two rows can't race the one channel. */
  steering: boolean
  onSteerStart: (id: string) => Promise<void>
  onInterruptItem?: (id: string) => Promise<void> | void
  /** Whether an interrupt from ANY row is in flight (same single-flight
   *  discipline as {@link steering}). */
  interrupting: boolean
  onInterruptStart: (id: string) => void
}

function QueueItem({
  item,
  index,
  isEditing,
  onEdit,
  onDelete,
  onSteerItem,
  steerChannel,
  steering,
  onSteerStart,
  onInterruptItem,
  interrupting,
  onInterruptStart,
}: QueueItemProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  const dragControls = useDragControls()

  // Which rows may offer the insert at all. Two rows can't, and offering a
  // click that provably does nothing is worse than offering none:
  // * The row under edit. Its authoritative text is in the composer now, so
  //   inserting would send the PRE-edit draft and then drop the row the edit
  //   was going to save into. (The composer hides its own mid-turn send while
  //   editing for the same reason.)
  // * A draft carrying attachments on a pull-tool session. The pull channel
  //   delivers text, so the backend rejects blocks there — every click would
  //   land on the turn-end fallback, which only moves the row to the front
  //   and never inserts it. It still goes out whole with the next turn.
  const canSteer =
    Boolean(onSteerItem) &&
    !isEditing &&
    (steerChannel === "native" || !draftRidesBlocks(item.draft))
  // The interrupt has neither restriction: it rides the ordinary prompt wire
  // (blocks included) and a cancelled turn takes the row's place, so an
  // attachment is delivered whole. The row under edit is the one case that
  // still cannot — same pre-edit-draft reason as the insert.
  const canInterrupt = Boolean(onInterruptItem) && !isEditing

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="div"
      value={item}
      dragListener={false}
      dragControls={dragControls}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-1 text-3xs leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
        "bg-muted/40 border-border/70",
        isEditing && "border-primary/50 bg-primary/5"
      )}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing p-0"
        onPointerDown={startDrag}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
      </button>
      <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
        #{index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-3xs text-foreground/80">
        {item.draft.displayText}
      </span>
      {canSteer && (
        <button
          type="button"
          onClick={() => void onSteerStart(item.id)}
          disabled={steering || interrupting}
          className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground disabled:opacity-50"
          title={t(
            steerChannel === "pull" ? "steerItemAsNote" : "steerItemNow"
          )}
        >
          {steerChannel === "pull" ? (
            <Clock className="h-2.5 w-2.5" />
          ) : (
            <Zap className="h-2.5 w-2.5" />
          )}
        </button>
      )}
      {canInterrupt && (
        <button
          type="button"
          onClick={() => onInterruptStart(item.id)}
          disabled={steering || interrupting}
          className="shrink-0 rounded-sm p-0.5 hover:bg-destructive/15 text-destructive disabled:opacity-50"
          title={t("interruptItem")}
        >
          <OctagonX className="h-2.5 w-2.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("editItem")}
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("deleteItem")}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Reorder.Item>
  )
}

export function MessageQueueDisplay({
  queue,
  onReorder,
  onEdit,
  onDelete,
  editingItemId,
  onSteerItem,
  steerChannel = "pull",
  onInterruptItem,
}: MessageQueueDisplayProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  // The id whose insert is in flight. A per-row `steering` would let a
  // concurrent click on another row race the same channel; one shared id
  // both disables the clicked row and (via `steeringId !== null`) the others
  // — matching the composer's single-flight `steering` guard.
  const [steeringId, setSteeringId] = useState<string | null>(null)
  // The click handler's re-entrancy lock. Taken in the click itself and
  // released in `finally`, so a second click that lands before React commits
  // the disabled buttons is still refused: the state above only drives
  // rendering and lags a commit.
  const steeringIdRef = useRef<string | null>(null)
  // Same single-flight discipline for the interrupt: the destructive action
  // runs one at a time, and both action buttons of every row are disabled
  // while either is settling.
  const [interruptingId, setInterruptingId] = useState<string | null>(null)
  const interruptingIdRef = useRef<string | null>(null)
  // The row whose interrupt confirmation is open. The click itself never
  // sends — the dialog's action does (see the composer's own confirmation).
  const [pendingInterruptId, setPendingInterruptId] = useState<string | null>(
    null
  )
  const pendingItem = pendingInterruptId
    ? queue.find((item) => item.id === pendingInterruptId)
    : undefined

  const handleSteerStart = useCallback(
    async (id: string) => {
      if (!onSteerItem || steeringIdRef.current !== null) return
      steeringIdRef.current = id
      setSteeringId(id)
      try {
        await onSteerItem(id)
      } finally {
        steeringIdRef.current = null
        setSteeringId(null)
      }
    },
    [onSteerItem]
  )

  const handleInterruptStart = useCallback(
    async (id: string) => {
      if (!onInterruptItem || interruptingIdRef.current !== null) return
      interruptingIdRef.current = id
      setInterruptingId(id)
      try {
        await onInterruptItem(id)
      } finally {
        interruptingIdRef.current = null
        setInterruptingId(null)
      }
    },
    [onInterruptItem]
  )

  if (queue.length === 0) return null

  return (
    <div className="max-h-28 overflow-y-auto pb-1">
      <Reorder.Group
        as="div"
        axis="y"
        values={queue}
        onReorder={onReorder}
        className="flex flex-col gap-0.5"
      >
        {queue.map((item, index) => (
          <QueueItem
            key={item.id}
            item={item}
            index={index}
            isEditing={editingItemId === item.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onSteerItem={onSteerItem}
            steerChannel={steerChannel}
            steering={steeringId !== null}
            onSteerStart={handleSteerStart}
            onInterruptItem={onInterruptItem}
            interrupting={interruptingId !== null}
            onInterruptStart={setPendingInterruptId}
          />
        ))}
      </Reorder.Group>
      {/* Destructive confirmation for the row's interrupt: it aborts whatever
          the agent is doing, so a stray click on a tiny icon never fires it
          directly. The row is named by its position, matching the list. */}
      <AlertDialog
        open={pendingInterruptId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingInterruptId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("interruptItemConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingItem ? `#${queue.indexOf(pendingItem) + 1} ` : ""}
              {t("interruptItemHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                const id = pendingInterruptId
                setPendingInterruptId(null)
                if (id) void handleInterruptStart(id)
              }}
            >
              {t("interruptItem")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
