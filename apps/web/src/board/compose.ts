// A one-signal bridge so something outside the board — today the command
// palette's "New task in <list>" — can ask the board to open its quick-add.
//
// The board's composer is component state (which column is composing), and the
// requester is mounted in a different subtree, so the request travels as a
// nonce: the board reacts to the counter changing rather than to a boolean it
// would then have to reset.
import { signal, type Signal } from "@preact/signals";

export type ComposeRequest = { listId: string | null; nonce: number };

export const composeRequest: Signal<ComposeRequest> = signal({ listId: null, nonce: 0 });

/** Ask the board for `listId` (or whichever board is mounted) to start a task. */
export function requestNewTask(listId: string | null): void {
  composeRequest.value = { listId, nonce: composeRequest.value.nonce + 1 };
}
