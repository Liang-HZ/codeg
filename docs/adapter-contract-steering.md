# Adapter contract: mid-turn steering (insert into current turn)

Audience: ACP adapter authors who want codeg to offer "insert into current turn" for their agent. Everything else (queued messages, interrupt-and-send) needs nothing from this contract — codeg provides both over ordinary `session/prompt` and `session/cancel`.

## 1. Prerequisites

Report your adapter identity in the `initialize` result:

```jsonc
{
  "agentInfo": { "name": "your-adapter", "version": "1.2.3" }
}
```

codeg's policy table is keyed on this name. An adapter that advertises steering without reporting `agentInfo` is treated as not supporting native steering (fail closed).

## 2. The `_meta.steering` descriptor

Advertise the capability on the top-level `_meta.steering` of the `initialize` result:

```jsonc
"_meta": { "steering": {
  "supported": true,                  // required; true iff _session/steering works
  "method": "_session/steering",      // required when supported
  "tier": "native",                   // "native" | "extension"
  "boundary": "step",                 // "immediate" | "step" | "turnEnd"; default "step"
  "idle": "promptRequired",           // required for native steering; see below
  "settlesOwnerTurn": false,          // does an injection end the host's turn early?
  "outcomes": ["injected", "queued", "promptRequired", "startedNewTurn", "failed"]
}}
```

Strictness rules (codeg side):

- `supported` and `outcomes` are parsed strictly. An unknown entry in `outcomes`, or a non-array, is a protocol error — keep the list accurate.
- `boundary` and `idle` are parsed leniently: an unrecognized value falls back to the conservative default with a warning, so adding a future value must not kill the connection.
- `idle: "promptRequired"` is the opt-in that makes codeg offer native steering. Any other value (including absent) means codeg uses the pull channel (`check_user_feedback`) and its local queue instead.

## 3. The steer request

codeg sends `_session/steering` with `idleBehavior: "promptRequired"` while your turn is running. Reply synchronously with exactly one outcome:

| outcome | meaning | what codeg does |
|---|---|---|
| `injected` | accepted into the running turn, takes effect per `boundary` | records it as delivered; never resends |
| `queued` | accepted, but deferred to after the current turn | records it as delivered with an "runs after this turn" caption; never resends |
| `promptRequired` | not consumed; still belongs to the host | degrades to an ordinary prompt (or the local queue, per existing fallback chain) |
| `startedNewTurn` | consumed, but as a detached turn codeg does not control | records it as delivered; disables native steering for the rest of the session |
| `failed` | real failure | surfaces the error; the draft returns to the composer |

An unknown outcome is a protocol error, by design — reply with one of the declared values.

## 4. Receipts (optional)

Attach `_meta.steering.steerState` (string) to the response. codeg uses it only to caption the `queued` case (e.g. `fellBack`, `notRequested`); an `injected` outcome needs no caption and ignores it.

## 5. Worked example

`zcode-acp` advertises:

```jsonc
"_meta": { "steering": {
  "supported": true,
  "method": "_session/steering",
  "tier": "native",
  "idle": "promptRequired",
  "outcomes": ["injected", "queued", "promptRequired", "startedNewTurn", "failed"]
}}
```

and replies to a steer accepted for the next turn boundary with `{"outcome": "queued", "_meta": {"steering": {"steerState": "fellBack"}}}`.
